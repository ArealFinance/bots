import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { findBinArrayPda, findRwtVaultPda } from '@areal/sdk/pda';
import { createBotMetrics } from '@areal/bots-shared';
import { CONFIG } from './config.js';
import { Rebalancer } from './rebalancer.js';
import * as fs from 'fs';

const POOL_TYPE_CONCENTRATED = 1;

async function main() {
  console.log('[pool-rebalancer] Starting...');
  console.log(`[pool-rebalancer] RPC: ${CONFIG.RPC_URL}`);
  console.log(`[pool-rebalancer] DEX Program: ${CONFIG.DEX_PROGRAM_ID}`);
  console.log(`[pool-rebalancer] Check interval: ${CONFIG.CHECK_INTERVAL_MS}ms`);
  console.log(`[pool-rebalancer] Threshold: ${CONFIG.REBALANCE_THRESHOLD * 100}%`);
  console.log(`[pool-rebalancer] Target bin count: ${CONFIG.TARGET_BIN_COUNT}`);

  // Phase 21: prom-client metrics surface. BOT_METRICS_PORT is supplied by
  // scripts/lib/start-bots.ts (locked port 9103 for pool-rebalancer).
  const metricsPort = parseInt(process.env.BOT_METRICS_PORT ?? '0', 10);
  if (!metricsPort) {
    console.error('[pool-rebalancer] BOT_METRICS_PORT env not set');
    process.exit(1);
  }

  // Load rebalancer keypair
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

  const metrics = createBotMetrics({
    bot: 'pool-rebalancer',
    instructions: ['shift_liquidity'],
    port: metricsPort,
    startedAt: new Date(),
    walletPubkey: wallet.publicKey.toBase58(),
  });

  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');
  const rebalancer = new Rebalancer(connection, wallet, metrics);
  const dexProgramId = new PublicKey(CONFIG.DEX_PROGRAM_ID);

  // Phase 21: 60s heartbeat — refresh wallet SOL gauge.
  const metricsHeartbeat = setInterval(() => {
    void (async (): Promise<void> => {
      try {
        const lamports = await connection.getBalance(wallet.publicKey, 'confirmed');
        metrics.walletSol.set(lamports / 1e9);
      } catch {
        /* surfaces via downstream alerts */
      }
    })();
  }, 60_000);
  metricsHeartbeat.unref();

  const onShutdown = async (signal: string): Promise<void> => {
    console.log(`[pool-rebalancer] received ${signal}, shutting down`);
    clearInterval(metricsHeartbeat);
    try {
      await metrics.shutdown();
    } catch (err) {
      console.error('[pool-rebalancer] metrics shutdown failed', err);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void onShutdown('SIGINT'));
  process.once('SIGTERM', () => void onShutdown('SIGTERM'));

  // Main loop
  while (true) {
    try {
      // Discover concentrated pools by scanning program accounts
      const pools = await discoverConcentratedPools(connection, dexProgramId);
      console.log(`[pool-rebalancer] Found ${pools.length} concentrated pool(s)`);

      // Derive RWT vault PDA (from RWT Engine program) via SDK helper.
      const rwtVaultPda = CONFIG.RWT_ENGINE_PROGRAM_ID
        ? findRwtVaultPda(new PublicKey(CONFIG.RWT_ENGINE_PROGRAM_ID))[0]
        : null;

      if (!rwtVaultPda) {
        console.warn('[pool-rebalancer] RWT_ENGINE_PROGRAM_ID not set, skipping rebalance');
      } else {
        for (const pool of pools) {
          try {
            await rebalancer.checkAndRebalance(pool, rwtVaultPda);
          } catch (err) {
            console.error(`[pool-rebalancer] Error checking pool ${pool.address.toBase58()}:`, err);
          }
        }
      }
    } catch (err) {
      console.error('[pool-rebalancer] Loop error:', err);
    }

    await new Promise(r => setTimeout(r, CONFIG.CHECK_INTERVAL_MS));
  }
}

interface PoolInfo {
  address: PublicKey;
  binArrayPda: PublicKey;
  poolType: number;
  isActive: boolean;
  reserveA: bigint;
  reserveB: bigint;
  binStepBps: number;
  activeBinId: number;
}

async function discoverConcentratedPools(
  connection: Connection,
  programId: PublicKey,
): Promise<PoolInfo[]> {
  // Fetch all program accounts with PoolState discriminator
  // PoolState discriminator = sha256("account:PoolState")[0..8]
  const crypto = await import('crypto');
  const discriminator = crypto.createHash('sha256')
    .update('account:PoolState')
    .digest()
    .subarray(0, 8);

  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { dataSize: 220 }, // PoolState SPACE
      { memcmp: { offset: 0, bytes: Buffer.from(discriminator).toString('base64'), encoding: 'base64' } },
    ],
  });

  const pools: PoolInfo[] = [];

  for (const { pubkey, account } of accounts) {
    const data = account.data;
    // PoolState layout after 8-byte discriminator:
    // pool_type: u8 (offset 8)
    const poolType = data[8];
    if (poolType !== POOL_TYPE_CONCENTRATED) continue;

    // Parse fields (packed repr):
    // pool_type(1) + token_a_mint(32) + token_b_mint(32) + vault_a(32) + vault_b(32) +
    // reserve_a(8) + reserve_b(8) + total_lp_shares(16) + fee_bps(2) + is_active(1) +
    // total_fees_accumulated(8) + bin_step_bps(2) + active_bin_id(4)
    const offset = 8; // After discriminator
    const isActive = data[offset + 1 + 32 + 32 + 32 + 32 + 8 + 8 + 16 + 2] !== 0;
    const reserveA = data.readBigUInt64LE(offset + 1 + 32 + 32 + 32 + 32);
    const reserveB = data.readBigUInt64LE(offset + 1 + 32 + 32 + 32 + 32 + 8);
    const binStepBps = data.readUInt16LE(offset + 1 + 32 + 32 + 32 + 32 + 8 + 8 + 16 + 2 + 1 + 8);
    const activeBinId = data.readInt32LE(offset + 1 + 32 + 32 + 32 + 32 + 8 + 8 + 16 + 2 + 1 + 8 + 2);

    // Derive BinArray PDA via SDK helper.
    const [binArrayPda] = findBinArrayPda(pubkey, programId);

    pools.push({
      address: pubkey,
      binArrayPda,
      poolType,
      isActive,
      reserveA,
      reserveB,
      binStepBps,
      activeBinId,
    });
  }

  return pools;
}

main().catch(err => {
  console.error('[pool-rebalancer] Fatal error:', err);
  process.exit(1);
});
