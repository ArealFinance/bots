import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  POOLSTATE_DISCRIMINATOR,
  parsePoolState,
} from '@areal/sdk/native-dex';
import { findBinArrayPda, findRwtVaultPda } from '@areal/sdk/pda';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import { CONFIG } from './config.js';
import { Rebalancer, type PoolInfo, type RebalanceDecision } from './rebalancer.js';

const POOL_TYPE_CONCENTRATED = 1;

async function main(): Promise<void> {
  console.log('[pool-rebalancer] Starting...');
  console.log(`[pool-rebalancer] RPC: ${CONFIG.RPC_URL}`);
  console.log(`[pool-rebalancer] DEX Program: ${CONFIG.DEX_PROGRAM_ID}`);
  console.log(`[pool-rebalancer] Check interval: ${CONFIG.CHECK_INTERVAL_MS}ms`);
  console.log(`[pool-rebalancer] Threshold: ${CONFIG.REBALANCE_THRESHOLD * 100}%`);
  console.log(`[pool-rebalancer] Active zone width: ${CONFIG.ACTIVE_ZONE_WIDTH}`);
  console.log(`[pool-rebalancer] Debounce: ${CONFIG.DEBOUNCE_MS}ms`);

  if (!CONFIG.REBALANCER_KEYPAIR) {
    console.error('[pool-rebalancer] REBALANCER_KEYPAIR not set');
    process.exit(1);
  }

  let wallet: Keypair;
  try {
    const keyData = JSON.parse(fs.readFileSync(CONFIG.REBALANCER_KEYPAIR, 'utf-8'));
    wallet = Keypair.fromSecretKey(new Uint8Array(keyData));
  } catch (err) {
    console.error('[pool-rebalancer] Failed to load keypair:', err);
    process.exit(1);
  }
  console.log(`[pool-rebalancer] Rebalancer wallet: ${wallet.publicKey.toBase58()}`);

  if (!CONFIG.RWT_ENGINE_PROGRAM_ID) {
    console.error('[pool-rebalancer] RWT_ENGINE_PROGRAM_ID not set');
    process.exit(1);
  }

  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');
  const rebalancer = new Rebalancer(connection, wallet);
  const dexProgramId = new PublicKey(CONFIG.DEX_PROGRAM_ID);
  const rwtEngineProgramId = new PublicKey(CONFIG.RWT_ENGINE_PROGRAM_ID);
  const [rwtVaultPda] = findRwtVaultPda(rwtEngineProgramId);

  // Main loop — one full iteration per CHECK_INTERVAL_MS.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const pools = await discoverConcentratedPools(connection, dexProgramId);
      console.log(`[pool-rebalancer] Found ${pools.length} concentrated pool(s)`);

      for (const pool of pools) {
        try {
          const decision = await rebalancer.checkAndRebalance(pool, rwtVaultPda);
          logDecision(pool, decision);
        } catch (err) {
          console.error(
            `[pool-rebalancer] Error checking pool ${pool.address.toBase58()}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error('[pool-rebalancer] Loop error:', err);
    }

    await new Promise((r) => setTimeout(r, CONFIG.CHECK_INTERVAL_MS));
  }
}

function logDecision(pool: PoolInfo, decision: RebalanceDecision): void {
  const pool58 = pool.address.toBase58();
  switch (decision.kind) {
    case 'skip':
      console.log(
        `[pool-rebalancer] skip pool=${pool58} reason=${decision.reason}` +
          (decision.detail ? ` detail=${decision.detail}` : ''),
      );
      return;
    case 'noop':
      console.log(`[pool-rebalancer] noop pool=${pool58} detail=${decision.detail}`);
      return;
    case 'grow_submitted':
      console.log(
        `[pool-rebalancer] grow_submitted pool=${pool58} new_nav_bin=${decision.newNavBin} ` +
          `nexus_balance=${decision.nexusBalance.toString()} sig=${decision.signature}`,
      );
      return;
    case 'compression_submitted':
      console.log(
        `[pool-rebalancer] compression_submitted pool=${pool58} new_nav_bin=${decision.newNavBin} ` +
          `sig=${decision.signature}`,
      );
      return;
    case 'submission_failed':
      console.error(
        `[pool-rebalancer] submission_failed pool=${pool58} pathway=${decision.pathway} ` +
          `new_nav_bin=${decision.newNavBin} error=${decision.error}`,
      );
      return;
  }
}

/**
 * Discover concentrated pools via `getProgramAccounts` with a discriminator
 * memcmp filter. We deliberately do NOT filter by `dataSize` — the
 * PoolState size has grown twice (D28: +32 bytes for LP-fee accumulators,
 * CP-1: +20 bytes for Monotonic Ladder anchors), and pinning a byte count
 * here is a foot-gun. The discriminator alone is unique.
 *
 * All field decoding is delegated to the SDK's `parsePoolState` so any
 * future field reordering is picked up transparently.
 */
export async function discoverConcentratedPools(
  connection: Connection,
  programId: PublicKey,
): Promise<PoolInfo[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: Buffer.from(POOLSTATE_DISCRIMINATOR).toString('base64'),
          encoding: 'base64',
        },
      },
    ],
  });

  const pools: PoolInfo[] = [];
  for (const { pubkey, account } of accounts) {
    let state;
    try {
      state = parsePoolState(account.data);
    } catch {
      // Discriminator matched but the body is malformed — skip rather than
      // poison the whole cycle.
      continue;
    }
    if (state.poolType !== POOL_TYPE_CONCENTRATED) continue;

    const [binArrayPda] = findBinArrayPda(pubkey, programId);

    pools.push({
      address: pubkey,
      binArrayPda,
      poolType: state.poolType,
      isActive: state.isActive,
      reserveA: state.reserveA,
      reserveB: state.reserveB,
      binStepBps: state.binStepBps,
      activeBinId: state.activeBinId,
      lastRebalanceNavBin: state.lastRebalanceNavBin,
      vaultB: state.vaultB,
      tokenBMint: state.tokenBMint,
    });
  }

  return pools;
}

main().catch((err) => {
  console.error('[pool-rebalancer] Fatal error:', err);
  process.exit(1);
});
