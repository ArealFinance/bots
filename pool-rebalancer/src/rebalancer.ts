import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { findDexConfigPda } from '@areal/sdk/pda';
import { parseRwtVault } from '@areal/sdk/rwt-engine';
import { buildShiftLiquidityIx } from '@areal/sdk/tx';
import { CONFIG } from './config.js';
import { calculateNavBin, calculatePoolPrice, calculateDeviation } from './nav-calculator.js';

const POOL_TYPE_CONCENTRATED = 1;
const NAV_DECIMALS = 1_000_000; // RWT nav_book_value is in 6 decimals

/**
 * Decode `nav_book_value` from a raw RwtVault account buffer and convert it
 * to the human-scale price. Returns 0 if the buffer is missing or malformed.
 *
 * Exposed at module scope so the regression test can pin the byte-offset
 * contract (R3 follow-up: prior versions read u64 at offset 8, but the
 * RwtVault layout has `total_invested_capital: u128 + total_rwt_supply: u64`
 * before `nav_book_value`, putting it at offset 32).
 */
export function decodeNavPrice(data: Buffer | Uint8Array): number {
  try {
    const vault = parseRwtVault(data);
    return Number(vault.navBookValue) / NAV_DECIMALS;
  } catch {
    return 0;
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

export class Rebalancer {
  private connection: Connection;
  private wallet: Keypair;
  private dexProgramId: PublicKey;
  private dexConfigPda: PublicKey;
  private lastShiftTime: Map<string, number> = new Map();

  constructor(connection: Connection, wallet: Keypair) {
    this.connection = connection;
    this.wallet = wallet;
    this.dexProgramId = new PublicKey(CONFIG.DEX_PROGRAM_ID);

    // Derive DEX config PDA via the canonical SDK helper.
    const [configPda] = findDexConfigPda(this.dexProgramId);
    this.dexConfigPda = configPda;
  }

  async checkAndRebalance(pool: PoolInfo, rwtVaultPda: PublicKey): Promise<void> {
    const poolAddr = pool.address.toBase58();

    // Skip non-concentrated pools
    if (pool.poolType !== POOL_TYPE_CONCENTRATED) {
      return;
    }

    // Skip paused pools
    if (!pool.isActive) {
      console.log(`[rebalancer] Skipping paused pool ${poolAddr}`);
      return;
    }

    // Skip empty pools
    if (pool.reserveA === 0n || pool.reserveB === 0n) {
      console.log(`[rebalancer] Skipping empty pool ${poolAddr}`);
      return;
    }

    // Debounce: skip if last shift was too recent
    const now = Date.now();
    const lastShift = this.lastShiftTime.get(poolAddr) || 0;
    if (now - lastShift < CONFIG.DEBOUNCE_MS) {
      console.log(`[rebalancer] Debounce: skipping pool ${poolAddr} (${now - lastShift}ms since last shift)`);
      return;
    }

    // Read RWT NAV
    const navPrice = await this.readNavPrice(rwtVaultPda);
    if (navPrice <= 0) {
      console.warn(`[rebalancer] Invalid NAV price: ${navPrice}`);
      return;
    }

    // Calculate pool price from active bin
    const poolPrice = calculatePoolPrice(pool.activeBinId, pool.binStepBps);

    // Check deviation
    const deviation = calculateDeviation(poolPrice, navPrice);
    console.log(`[rebalancer] Pool ${poolAddr}: poolPrice=${poolPrice.toFixed(6)}, navPrice=${navPrice.toFixed(6)}, deviation=${(deviation * 100).toFixed(4)}%`);

    if (deviation <= CONFIG.REBALANCE_THRESHOLD) {
      return; // Within acceptable range
    }

    // Calculate target nav_bin
    const navBin = calculateNavBin(navPrice, pool.binStepBps);
    console.log(`[rebalancer] Deviation ${(deviation * 100).toFixed(2)}% > ${CONFIG.REBALANCE_THRESHOLD * 100}% threshold. Shifting to nav_bin=${navBin}`);

    // Execute shift_liquidity
    await this.executeShift(pool, navBin);
    this.lastShiftTime.set(poolAddr, Date.now());
  }

  private async readNavPrice(rwtVaultPda: PublicKey): Promise<number> {
    const accountInfo = await this.connection.getAccountInfo(rwtVaultPda);
    if (!accountInfo) {
      console.warn(`[rebalancer] RWT vault account not found: ${rwtVaultPda.toBase58()}`);
      return 0;
    }

    // Decode through the SDK so the byte layout (8-byte discriminator +
    // total_invested_capital u128 + total_rwt_supply u64 + nav_book_value u64
    // at offset 32) is sourced from the same IDL as the on-chain handler.
    const price = decodeNavPrice(accountInfo.data);
    if (price === 0) {
      console.warn(`[rebalancer] Failed to parse RwtVault ${rwtVaultPda.toBase58()}`);
    }
    return price;
  }

  private async executeShift(pool: PoolInfo, navBin: number): Promise<void> {
    // Build shift_liquidity via SDK (canonical discriminator + account list).
    const ix = buildShiftLiquidityIx({
      dexProgramId: this.dexProgramId,
      rebalancer: this.wallet.publicKey,
      dexConfig: this.dexConfigPda,
      poolState: pool.address,
      binArray: pool.binArrayPda,
      navBin,
      targetBinCount: CONFIG.TARGET_BIN_COUNT,
    });

    const tx = new Transaction().add(ix);

    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        const sig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
          commitment: 'confirmed',
        });
        console.log(`[rebalancer] shift_liquidity OK: pool=${pool.address.toBase58()}, nav_bin=${navBin}, sig=${sig}`);
        return;
      } catch (err) {
        console.error(`[rebalancer] shift_liquidity attempt ${attempt}/${CONFIG.MAX_RETRIES} failed:`, err);
        if (attempt < CONFIG.MAX_RETRIES) {
          const delay = CONFIG.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    console.error(`[rebalancer] shift_liquidity FAILED after ${CONFIG.MAX_RETRIES} retries for pool ${pool.address.toBase58()}`);
  }
}
