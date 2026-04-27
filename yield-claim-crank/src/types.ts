import type { PublicKey } from '@solana/web3.js';

/**
 * Layer 8 — yield-claim-crank shared types.
 */

/**
 * Merkle proof JSON file shape — must match the format emitted by
 * `bots/merkle-publisher/src/proof-store.ts`. Each row is one
 * (distributor, claimant, epoch).
 */
export interface ProofFile {
  claimant: string; // base58 PDA
  distributor: string; // base58 PDA
  epoch: number;
  cumulativeAmount: string; // u64 as decimal string
  proof: string[]; // hex-encoded 32-byte nodes (0x… or no-prefix hex)
}

export type ClaimDecision =
  | { kind: 'send'; cumulativeAmount: bigint; epoch: bigint }
  | { kind: 'skip'; reason: ClaimSkipReason };

export type ClaimSkipReason =
  | 'no_proof'
  | 'epoch_stale'
  | 'rpc_error'
  | 'in_flight'
  // Arch M-2: scaffolded flow that intentionally defers TX assembly until an
  // upstream R-ticket lands (R20 RWT_MINT pin → LH-drain; nexus provisioning
  // → USDC nexus_deposit). Distinct from `epoch_stale` so log analytics
  // correctly surfaces "code path not yet built" vs "nothing to claim".
  | 'deferred';

export interface ClaimTarget {
  /** Distributor PDA — derived from `["merkle_dist", ot_mint]` under YD program. */
  distributor: PublicKey;
  /** Claimant PDA — depends on the flow:
   *   - vault    → RwtVault PDA (`["rwt_vault"]`)
   *   - pool     → DEX pool PDA
   *   - treasury → OtTreasury PDA (`["ot_treasury", treasury_ot_mint]`)
   */
  claimant: PublicKey;
}
