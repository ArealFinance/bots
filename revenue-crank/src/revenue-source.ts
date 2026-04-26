import { Connection, PublicKey } from '@solana/web3.js';
import type { RevenueAccount, RevenueConfig, RevenueDestination } from './types.js';

/**
 * On-chain reads for the revenue-crank.
 *
 * The exported parsers are pure functions over Buffer slices so they can be
 * unit-tested without spinning up a Solana RPC.
 */

/** Layer 8 — `RevenueAccount` PDA seed prefix. */
export const REVENUE_ACCOUNT_SEED = Buffer.from('revenue');
/** Layer 8 — `RevenueConfig` PDA seed prefix. */
export const REVENUE_CONFIG_SEED = Buffer.from('revenue_config');

/** SPL Token v1 ACCOUNT layout (length-checked before indexing). */
const SPL_TOKEN_ACCOUNT_LEN = 165;

/**
 * Derive (RevenueAccount, RevenueConfig) PDA pair for a given OT mint.
 */
export function deriveRevenuePdas(
  otMint: PublicKey,
  otProgramId: PublicKey,
): { revenueAccount: PublicKey; revenueConfig: PublicKey } {
  const [revenueAccount] = PublicKey.findProgramAddressSync(
    [REVENUE_ACCOUNT_SEED, otMint.toBuffer()],
    otProgramId,
  );
  const [revenueConfig] = PublicKey.findProgramAddressSync(
    [REVENUE_CONFIG_SEED, otMint.toBuffer()],
    otProgramId,
  );
  return { revenueAccount, revenueConfig };
}

/**
 * Parse `RevenueAccount` raw account data (8-byte discriminator + 98-byte body).
 * Throws on length mismatch — caller must catch.
 */
export function parseRevenueAccount(data: Buffer): RevenueAccount {
  if (data.length < 8 + 98) {
    throw new Error(`RevenueAccount: expected ≥106 bytes, got ${data.length}`);
  }
  const body = data.subarray(8);
  const otMint = new PublicKey(body.subarray(0, 32));
  const revenueTokenAccount = new PublicKey(body.subarray(32, 64));
  const totalDistributed = body.readBigUInt64LE(64);
  const distributionCount = body.readBigUInt64LE(72);
  const lastDistributionTs = Number(body.readBigInt64LE(80));
  const minDistributionAmount = body.readBigUInt64LE(88);
  const isDistributing = body.readUInt8(96) !== 0;
  const bump = body.readUInt8(97);
  return {
    otMint,
    revenueTokenAccount,
    totalDistributed,
    distributionCount,
    lastDistributionTs,
    minDistributionAmount,
    isDistributing,
    bump,
  };
}

/**
 * Parse `RevenueConfig` raw account data (8-byte discriminator + 734-byte
 * body). Returns only the **active** destinations slice (sliced down by
 * `activeCount`).
 *
 * Body layout (state.rs:82):
 *   ot_mint                [u8;32]                  → 0..32
 *   destinations[10] {                              → 32..692
 *       address [u8;32]                                (66 bytes each)
 *       allocation_bps u16
 *       label [u8;32]
 *   }
 *   active_count           u8                       → 692..693
 *   config_version         u64                      → 693..701
 *   areal_fee_destination  [u8;32]                  → 701..733
 *   bump                   u8                       → 733..734
 */
const MAX_DESTINATIONS = 10;
const DESTINATION_SIZE = 66;

export function parseRevenueConfig(data: Buffer): RevenueConfig {
  if (data.length < 8 + 734) {
    throw new Error(`RevenueConfig: expected ≥742 bytes, got ${data.length}`);
  }
  const body = data.subarray(8);

  const otMint = new PublicKey(body.subarray(0, 32));

  const destinations: RevenueDestination[] = [];
  for (let i = 0; i < MAX_DESTINATIONS; i++) {
    const off = 32 + i * DESTINATION_SIZE;
    const address = new PublicKey(body.subarray(off, off + 32));
    const allocationBps = body.readUInt16LE(off + 32);
    const labelBytes = body.subarray(off + 34, off + 66);
    const label = decodeLabel(labelBytes);
    destinations.push({ address, allocationBps, label });
  }

  const activeCount = body.readUInt8(692);
  const configVersion = body.readBigUInt64LE(693);
  const arealFeeDestination = new PublicKey(body.subarray(701, 733));
  const bump = body.readUInt8(733);

  return {
    otMint,
    destinations: destinations.slice(0, activeCount),
    activeCount,
    configVersion,
    arealFeeDestination,
    bump,
  };
}

function decodeLabel(buf: Buffer): string {
  // Strip trailing zero bytes; labels are ASCII fixed-width.
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.subarray(0, end).toString('utf-8');
}

/**
 * Read SPL Token Account `amount` (bytes 64..72 LE). Returns 0n if account
 * does not exist (not initialised yet).
 */
export async function fetchTokenAmount(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata, 'confirmed');
  if (!info) return 0n;
  if (info.data.length < SPL_TOKEN_ACCOUNT_LEN) {
    throw new Error(
      `SPL Token Account at ${ata.toBase58()} has unexpected length ${info.data.length}`,
    );
  }
  return info.data.readBigUInt64LE(64);
}

export async function fetchRevenueAccount(
  conn: Connection,
  pda: PublicKey,
): Promise<RevenueAccount | null> {
  const info = await conn.getAccountInfo(pda, 'confirmed');
  if (!info) return null;
  return parseRevenueAccount(info.data);
}

export async function fetchRevenueConfig(
  conn: Connection,
  pda: PublicKey,
): Promise<RevenueConfig | null> {
  const info = await conn.getAccountInfo(pda, 'confirmed');
  if (!info) return null;
  return parseRevenueConfig(info.data);
}
