import { Connection, PublicKey } from '@solana/web3.js';
import * as os from 'node:os';
import { loadConfig } from './config.js';
import { EventWatcher } from './event-watcher.js';
import { createKmsSigner } from './kms-signer.js';
import { logger, setLogLevel } from './logger.js';
import { ProofStore } from './proof-store.js';
import { Publisher } from './publisher.js';
import { SnapshotStore } from './snapshot-store.js';
import { SnapshotTaker } from './snapshot-taker.js';

/**
 * Bootstrap the merkle-publisher bot:
 *   1. Load & validate config.
 *   2. Initialize SQLite + proof directory + acquire leader lock.
 *   3. Instantiate KMS signer (async probe), verify pubkey matches PUBLISHER_PUBKEY.
 *   4. Open primary + archival RPC connections, sanity-check each + mainnet
 *      archival-capability probe.
 *   5. Reconcile any missed events since the last persisted snapshot slot.
 *   6. Start event watcher — on fund events, take snapshot.
 *   7. Start publisher loop.
 *   8. Wire SIGINT/SIGTERM → graceful shutdown (release lock + stop).
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  logger.info('merkle-publisher starting', {
    network: cfg.network,
    rpc: cfg.rpcUrl,
    archival: cfg.archivalRpcUrl,
    archival2: cfg.archivalRpcUrl2 ?? '(none)',
    ydProgram: cfg.ydProgramId.toBase58(),
    otProgram: cfg.otProgramId.toBase58(),
    publisherPubkey: cfg.publisherPubkey.toBase58(),
    kms: cfg.kmsProvider,
    publishIntervalMs: cfg.publishIntervalMs,
    excludedHoldersCount: cfg.excludedHolders.length,
  });

  const signer = await createKmsSigner(cfg);
  if (!signer.publicKey.equals(cfg.publisherPubkey)) {
    throw new Error(
      `Signer pubkey ${signer.publicKey.toBase58()} does not match PUBLISHER_PUBKEY ${cfg.publisherPubkey.toBase58()}`,
    );
  }
  logger.info('signer ready', { pubkey: signer.publicKey.toBase58() });

  const primaryConn = new Connection(cfg.rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: cfg.rpcWsUrl,
  });
  const archivalConn =
    cfg.archivalRpcUrl === cfg.rpcUrl
      ? primaryConn
      : new Connection(cfg.archivalRpcUrl, { commitment: 'confirmed' });
  const archivalConn2 = cfg.archivalRpcUrl2
    ? new Connection(cfg.archivalRpcUrl2, { commitment: 'confirmed' })
    : null;

  // RPC sanity check — catches config errors before we start subscribing.
  try {
    const height = await primaryConn.getBlockHeight('confirmed');
    logger.info('primary RPC OK', { blockHeight: height });
  } catch (err) {
    throw new Error(
      `primary RPC unreachable at ${cfg.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (archivalConn !== primaryConn) {
    try {
      const height = await archivalConn.getBlockHeight('confirmed');
      logger.info('archival RPC OK', { blockHeight: height });
    } catch (err) {
      throw new Error(
        `archival RPC unreachable at ${cfg.archivalRpcUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (archivalConn2) {
    try {
      const height = await archivalConn2.getBlockHeight('confirmed');
      logger.info('archival RPC 2 OK', { blockHeight: height });
    } catch (err) {
      throw new Error(
        `archival RPC 2 unreachable at ${cfg.archivalRpcUrl2}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // M-3: on mainnet, require the archival RPC to actually support historical
  // queries. A plain Solana RPC will return empty/pruned data for transactions
  // older than ~2 epochs — we must fail-fast rather than silently publish on
  // incomplete data.
  if (cfg.network === 'mainnet') {
    await probeArchivalCapability(archivalConn, cfg.ydProgramId);
    if (archivalConn2) await probeArchivalCapability(archivalConn2, cfg.ydProgramId);
  }

  const snapshotStore = new SnapshotStore(cfg.dbPath);

  // M-2: acquire single-writer lock before anything else touches the DB
  // beyond schema migration.
  const pid = process.pid;
  const hostname = os.hostname();
  if (!snapshotStore.tryAcquireLeaderLock(pid, hostname)) {
    throw new Error(
      'Another publisher instance holds the leader lock. Refusing to start to avoid double-publish race.',
    );
  }

  // Heartbeat loop — refreshes the lock every 30 s so a crashed instance
  // eventually appears stale and lets a successor start cleanly.
  const heartbeatTimer = setInterval(() => {
    try {
      snapshotStore.heartbeatLeaderLock(pid, hostname);
    } catch (err) {
      logger.error('leader-lock heartbeat failed', err);
    }
  }, 30_000);

  const proofStore = new ProofStore(cfg.proofDir, signer);

  // NEW-M-3: sweep any staging directories left behind by crashed publishes.
  // An "orphaned" staging epoch is one whose publish_root tx never landed
  // (no row in `publishes`). Keeping them would leak epoch numbers into
  // future startup scans and confuse any tooling that inspects `_staging/`.
  try {
    proofStore.sweepStaleStaging((d, ep) => snapshotStore.isEpochPublished(d, ep));
  } catch (err) {
    logger.error('sweepStaleStaging failed (non-fatal, continuing)', err);
  }

  const snapshotTaker = new SnapshotTaker(
    archivalConn,
    snapshotStore,
    cfg.minHoldingOtLamports,
    archivalConn2,
    new Set(cfg.excludedHolders),
  );

  const eventWatcher = new EventWatcher(
    primaryConn,
    cfg.ydProgramId,
    async event => {
      try {
        await snapshotTaker.takeSnapshot(event);
      } catch (err) {
        logger.error('takeSnapshot failed', err, {
          distributor: event.distributor.toBase58(),
          signature: event.signature,
        });
      }
    },
    snapshotStore,
  );

  const publisher = new Publisher(cfg, primaryConn, signer, snapshotStore, proofStore);

  // Graceful shutdown handling.
  const stopController = new AbortController();

  // LOW-R2-1: any crash path (publisher loop, uncaughtException, unhandledRejection)
  // must release the lock so a successor does not wait the full 60s stale TTL.
  let alreadyShuttingDown = false;
  const releaseAndClose = (): void => {
    try {
      snapshotStore.releaseLeaderLock(pid, hostname);
    } catch (err) {
      logger.error('releaseLeaderLock failed', err);
    }
    try {
      snapshotStore.close();
    } catch (err) {
      logger.error('snapshotStore.close failed', err);
    }
  };

  const onShutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (alreadyShuttingDown) return;
    alreadyShuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    stopController.abort();
    clearInterval(heartbeatTimer);
    try {
      await eventWatcher.stop();
    } catch (err) {
      logger.error('event watcher stop failed', err);
    }
    // Give publisher.loop a moment to notice the abort and exit cleanly.
    await new Promise(r => setTimeout(r, 500));
    releaseAndClose();
    logger.info('shutdown complete');
    process.exit(exitCode);
  };
  process.once('SIGINT', () => void onShutdown('SIGINT'));
  process.once('SIGTERM', () => void onShutdown('SIGTERM'));
  process.once('uncaughtException', err => {
    logger.error('uncaughtException — releasing leader lock before exit', err);
    try { releaseAndClose(); } catch { /* swallow */ }
    process.exit(1);
  });
  process.once('unhandledRejection', err => {
    logger.error('unhandledRejection — releasing leader lock before exit', err);
    try { releaseAndClose(); } catch { /* swallow */ }
    process.exit(1);
  });

  // L-4: seed the in-memory processed-signature set from DB BEFORE subscribing
  // so any replays (reconcile or live) are deduped correctly.
  eventWatcher.seedProcessedFromStore();

  // HIGH-3 + MED-5: before the live subscription starts, reconcile any fund
  // events we missed while the bot was offline.
  //
  // NEW-M-2 cold-start fix: if the store is empty (`lastSlot === null`), the
  // previous implementation skipped reconcile entirely. An operator deploying
  // the bot AFTER the first fund_distributor event would miss it, causing
  // `max_total_claim < total_funded` on the first publish → InvalidMaxClaim →
  // stuck loop. We now invoke `reconcileCold(COLD_START_LOOKBACK_SLOTS)` to
  // scan recent program history (~2 days of slots by default).
  const lastSlot = snapshotStore.getMaxSlot();
  try {
    if (lastSlot !== null) {
      logger.info('reconciling missed events since last snapshot', {
        lastSlot: lastSlot.toString(),
      });
      const missed = await eventWatcher.reconcile(Number(lastSlot));
      for (const e of missed) {
        await snapshotTaker.takeSnapshot(e);
      }
      logger.info('reconcile pass complete', { replayed: missed.length });
    } else {
      logger.info('cold start — reconciling recent program history', {
        lookbackSlots: cfg.coldStartLookbackSlots.toString(),
      });
      const missed = await eventWatcher.reconcileCold(cfg.coldStartLookbackSlots);
      for (const e of missed) {
        await snapshotTaker.takeSnapshot(e);
      }
      logger.info('cold-start reconcile complete', { replayed: missed.length });
    }
  } catch (err) {
    logger.error('reconcile pass failed (continuing with live subscription)', err);
  }

  eventWatcher.start();

  // Fire-and-forget the publisher loop. It exits when the abort signal fires.
  // LOW-R2-1: on crash, go through the shared shutdown path so the leader
  // lock is released (otherwise a successor waits the full 60s stale TTL).
  publisher.loop(stopController.signal).catch(err => {
    logger.error('publisher loop crashed', err);
    void onShutdown('publisher-crash', 1);
  });

  logger.info('merkle-publisher ready');
}

/**
 * M-3: verify the archival RPC can actually answer historical queries.
 *
 * Strategy: ask for program signatures with an explicit `before` cursor set
 * about one month back. A pruned RPC will return empty; a proper archival RPC
 * returns the corresponding page. We also probe `getSlot` to make sure the
 * node is live.
 */
async function probeArchivalCapability(
  conn: Connection,
  programId: PublicKey,
): Promise<void> {
  const slot = await conn.getSlot('finalized');
  // ~30 days of slots at ~400 ms/slot = 6,480,000 slots.
  const oldSlot = Math.max(0, slot - 6_480_000);
  // Probe getBlockTime on the old slot — archival RPCs return it; pruned
  // public RPCs respond with -32009 (block not available).
  try {
    const bt = await conn.getBlockTime(oldSlot);
    if (bt == null) {
      throw new Error('getBlockTime returned null');
    }
    logger.info('archival capability probe OK', { oldSlot, blockTime: bt });
  } catch (err) {
    throw new Error(
      `Archival RPC capability probe failed at slot ${oldSlot}: ${
        err instanceof Error ? err.message : String(err)
      }. Use Helius/Triton or another archival provider for NETWORK=mainnet.`,
    );
  }
}

main().catch(err => {
  console.error('[fatal] merkle-publisher failed to start:', err);
  process.exit(1);
});
