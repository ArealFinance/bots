import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  findAssociatedTokenAddressPda,
  findDexConfigPda,
  findLiquidityNexusPda,
} from '@areal/sdk/pda';
import { parseRwtVault } from '@areal/sdk/rwt-engine';
import {
  buildCompressLiquidityIx,
  buildGrowLiquidityIx,
} from '@areal/sdk/tx';
import { CONFIG } from './config.js';
import {
  deviation,
  navToBin,
  priceAtBinFloat,
} from './nav-calculator.js';

const POOL_TYPE_CONCENTRATED = 1;
const NAV_DECIMALS = 1_000_000; // RWT nav_book_value is in 6 decimals

/**
 * Decode `nav_book_value` from a raw RwtVault account buffer and convert it
 * to the human-scale price. Returns `null` if the buffer is missing or
 * malformed.
 *
 * Exposed at module scope so the regression test can pin the byte-offset
 * contract (R3 follow-up): prior versions of the bot read u64 at offset 8,
 * but the RwtVault layout has `total_invested_capital: u128 +
 * total_rwt_supply: u64` before `nav_book_value`, putting it at offset 32.
 *
 * Returns the parsed `bigint` (NAV-scale, 6 decimals) alongside the float
 * price (NAV-scale ÷ NAV_DECIMALS). Returns `null` on parse failure rather
 * than `0` so callers can distinguish "vault not initialised" from
 * "NAV = 0" (which is a legitimate post-writedown state).
 */
export function decodeNavPrice(
  data: Buffer | Uint8Array,
): { navRaw: bigint; navPrice: number } | null {
  try {
    const vault = parseRwtVault(data);
    return {
      navRaw: vault.navBookValue,
      navPrice: Number(vault.navBookValue) / NAV_DECIMALS,
    };
  } catch {
    return null;
  }
}

export interface PoolInfo {
  address: PublicKey;
  binArrayPda: PublicKey;
  poolType: number;
  isActive: boolean;
  reserveA: bigint;
  reserveB: bigint;
  binStepBps: number;
  activeBinId: number;
  lastRebalanceNavBin: number;
  vaultB: PublicKey;
  tokenBMint: PublicKey;
}

/**
 * Result of a `checkAndRebalance()` cycle. Surfaced so the index.ts main
 * loop can emit a single structured log line per pool and so tests can
 * assert on the decision tree without mocking the full RPC client.
 */
export type RebalanceDecision =
  | { kind: 'skip'; reason: SkipReason; detail?: string }
  | { kind: 'noop'; detail: string }
  | {
      kind: 'grow_submitted';
      newNavBin: number;
      signature: string;
      nexusBalance: bigint;
    }
  | {
      kind: 'compression_submitted';
      newNavBin: number;
      signature: string;
    }
  | { kind: 'submission_failed'; newNavBin: number; pathway: 'grow' | 'compress'; error: string };

export type SkipReason =
  | 'wrong_pool_type'
  | 'pool_inactive'
  | 'debounce'
  | 'nav_unreadable'
  | 'nav_zero'
  | 'below_threshold'
  | 'nexus_empty';

/**
 * Minimal RPC surface needed by the rebalancer. Carved out so tests can
 * provide a fake without spinning up a `Connection`. Methods mirror
 * `Connection`'s shape verbatim so the production path is a one-line
 * `new Rebalancer(connection, wallet)`.
 */
export interface RpcAdapter {
  getAccountInfo(
    pubkey: PublicKey,
  ): Promise<{ data: Buffer | Uint8Array } | null>;
  getTokenAccountBalance(
    pubkey: PublicKey,
  ): Promise<{ value: { amount: string } }>;
  sendAndConfirm(tx: Transaction, signers: Keypair[]): Promise<string>;
}

function adaptConnection(connection: Connection): RpcAdapter {
  return {
    async getAccountInfo(pubkey) {
      const info = await connection.getAccountInfo(pubkey);
      return info ? { data: info.data } : null;
    },
    getTokenAccountBalance: (pubkey) => connection.getTokenAccountBalance(pubkey),
    sendAndConfirm: (tx, signers) =>
      sendAndConfirmTransaction(connection, tx, signers, {
        commitment: 'confirmed',
      }),
  };
}

export class Rebalancer {
  private rpc: RpcAdapter;
  private wallet: Keypair;
  private dexProgramId: PublicKey;
  private dexConfigPda: PublicKey;
  private liquidityNexusPda: PublicKey;
  private lastTxAt: Map<string, number> = new Map();

  constructor(
    connectionOrAdapter: Connection | RpcAdapter,
    wallet: Keypair,
    overrides?: { dexProgramId?: PublicKey },
  ) {
    this.rpc =
      'sendAndConfirm' in connectionOrAdapter
        ? connectionOrAdapter
        : adaptConnection(connectionOrAdapter);
    this.wallet = wallet;
    this.dexProgramId = overrides?.dexProgramId ?? new PublicKey(CONFIG.DEX_PROGRAM_ID);

    const [configPda] = findDexConfigPda(this.dexProgramId);
    this.dexConfigPda = configPda;
    const [nexusPda] = findLiquidityNexusPda(this.dexProgramId);
    this.liquidityNexusPda = nexusPda;
  }

  /**
   * One decision per pool per cycle. Returns the decision so the caller
   * (or a test) can log / assert without inspecting console output.
   *
   * Decision tree (architect CP-9):
   *   1. Pool not concentrated / inactive             → skip
   *   2. Debounced (last tx too recent)               → skip
   *   3. NAV unreadable / NAV = 0                     → skip
   *   4. |deviation(nav, refPrice)| < threshold       → skip
   *   5. newNavBin > refBin   → grow path
   *      - Nexus accumulator empty                    → skip
   *      - else                                       → grow_liquidity
   *   6. newNavBin < refBin                           → compress_liquidity
   *   7. newNavBin == refBin                          → noop (sub-bin drift)
   */
  async checkAndRebalance(
    pool: PoolInfo,
    rwtVaultPda: PublicKey,
  ): Promise<RebalanceDecision> {
    const poolAddr = pool.address.toBase58();

    if (pool.poolType !== POOL_TYPE_CONCENTRATED) {
      return { kind: 'skip', reason: 'wrong_pool_type', detail: poolAddr };
    }
    if (!pool.isActive) {
      return { kind: 'skip', reason: 'pool_inactive', detail: poolAddr };
    }

    const now = Date.now();
    const lastAt = this.lastTxAt.get(poolAddr) ?? 0;
    if (now - lastAt < CONFIG.DEBOUNCE_MS) {
      return {
        kind: 'skip',
        reason: 'debounce',
        detail: `${now - lastAt}ms since last tx`,
      };
    }

    // Read NAV from RWT Engine vault.
    const accountInfo = await this.rpc.getAccountInfo(rwtVaultPda);
    if (!accountInfo) {
      return { kind: 'skip', reason: 'nav_unreadable', detail: 'vault not found' };
    }
    const decoded = decodeNavPrice(accountInfo.data);
    if (decoded === null) {
      return { kind: 'skip', reason: 'nav_unreadable', detail: 'parse failed' };
    }
    if (decoded.navRaw === 0n) {
      return { kind: 'skip', reason: 'nav_zero' };
    }

    // Float deviation check against the pool's last-rebalance reference.
    const refPrice = priceAtBinFloat(pool.binStepBps, pool.lastRebalanceNavBin);
    const dev = deviation(decoded.navPrice, refPrice);
    if (Math.abs(dev) < CONFIG.REBALANCE_THRESHOLD) {
      return {
        kind: 'skip',
        reason: 'below_threshold',
        detail: `dev=${(dev * 100).toFixed(4)}%`,
      };
    }

    // Q-fixed-point new_nav_bin (sent on-chain — must agree with the contract).
    const newNavBin = navToBin(decoded.navRaw, pool.binStepBps);

    if (newNavBin === pool.lastRebalanceNavBin) {
      // Float deviation crossed the threshold but the integer ladder
      // rounded back to the same bin (e.g. very small bin_step_bps near a
      // bin boundary). On-chain `grow_redistribute` / `compress_redistribute`
      // would revert with `NotGrowthDirection` / `NotCompressionDirection`,
      // so we short-circuit cleanly.
      return {
        kind: 'noop',
        detail: `newNavBin == refBin (${newNavBin})`,
      };
    }

    if (newNavBin > pool.lastRebalanceNavBin) {
      return this.submitGrowLiquidity(pool, rwtVaultPda, newNavBin);
    }
    return this.submitCompressLiquidity(pool, rwtVaultPda, newNavBin);
  }

  private async submitGrowLiquidity(
    pool: PoolInfo,
    rwtVaultPda: PublicKey,
    newNavBin: number,
  ): Promise<RebalanceDecision> {
    // Pre-check: grow_liquidity drains USDC from the Nexus accumulator
    // ATA. If it's empty, the on-chain SPL Transfer would revert
    // (`InsufficientFunds`). Skip cleanly so we don't burn a fee.
    const [nexusUsdcAta] = findAssociatedTokenAddressPda(
      this.liquidityNexusPda,
      pool.tokenBMint,
    );
    let nexusBalance: bigint;
    try {
      const balance = await this.rpc.getTokenAccountBalance(nexusUsdcAta);
      nexusBalance = BigInt(balance.value.amount);
    } catch (err) {
      // ATA may not exist yet — treat as empty rather than throwing.
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: 'skip',
        reason: 'nexus_empty',
        detail: `ATA read failed: ${msg}`,
      };
    }
    if (nexusBalance === 0n) {
      return { kind: 'skip', reason: 'nexus_empty', detail: 'balance=0' };
    }

    const ix = buildGrowLiquidityIx({
      dexProgramId: this.dexProgramId,
      rebalancer: this.wallet.publicKey,
      dexConfig: this.dexConfigPda,
      poolState: pool.address,
      binArray: pool.binArrayPda,
      liquidityNexus: this.liquidityNexusPda,
      nexusUsdcAta,
      poolVaultB: pool.vaultB,
      rwtVault: rwtVaultPda,
      newNavBin,
      activeZoneWidth: CONFIG.ACTIVE_ZONE_WIDTH,
    });

    const submission = await this.submitWithBackoff(ix);
    if (submission.kind === 'ok') {
      this.lastTxAt.set(pool.address.toBase58(), Date.now());
      return {
        kind: 'grow_submitted',
        newNavBin,
        signature: submission.signature,
        nexusBalance,
      };
    }
    return {
      kind: 'submission_failed',
      newNavBin,
      pathway: 'grow',
      error: submission.error,
    };
  }

  private async submitCompressLiquidity(
    pool: PoolInfo,
    rwtVaultPda: PublicKey,
    newNavBin: number,
  ): Promise<RebalanceDecision> {
    const ix = buildCompressLiquidityIx({
      dexProgramId: this.dexProgramId,
      rebalancer: this.wallet.publicKey,
      dexConfig: this.dexConfigPda,
      poolState: pool.address,
      binArray: pool.binArrayPda,
      rwtVault: rwtVaultPda,
      newNavBin,
      activeZoneWidth: CONFIG.ACTIVE_ZONE_WIDTH,
    });

    const submission = await this.submitWithBackoff(ix);
    if (submission.kind === 'ok') {
      this.lastTxAt.set(pool.address.toBase58(), Date.now());
      return {
        kind: 'compression_submitted',
        newNavBin,
        signature: submission.signature,
      };
    }
    return {
      kind: 'submission_failed',
      newNavBin,
      pathway: 'compress',
      error: submission.error,
    };
  }

  /**
   * Send a single-instruction tx with exponential backoff per architect
   * CP-9 spec (2^n × base, MAX_RETRIES attempts). Last error is preserved
   * for the submission_failed result.
   */
  private async submitWithBackoff(
    ix: TransactionInstruction,
  ): Promise<{ kind: 'ok'; signature: string } | { kind: 'err'; error: string }> {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        const tx = new Transaction().add(ix);
        const sig = await this.rpc.sendAndConfirm(tx, [this.wallet]);
        return { kind: 'ok', signature: sig };
      } catch (err) {
        lastErr = err;
        if (attempt < CONFIG.MAX_RETRIES) {
          const delay = CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    return { kind: 'err', error: msg };
  }
}
