import { PublicKey } from '@solana/web3.js';

/**
 * PDA derivations used across the three claim flows. All seed prefixes mirror
 * the on-chain handlers verbatim.
 */

export const MERKLE_DIST_SEED = Buffer.from('merkle_dist');
export const DIST_CONFIG_SEED = Buffer.from('dist_config');
export const CLAIM_STATUS_SEED = Buffer.from('claim_status');
export const RWT_VAULT_SEED = Buffer.from('rwt_vault');
export const RWT_DIST_CONFIG_SEED = Buffer.from('dist_config_rwt');
export const OT_TREASURY_SEED = Buffer.from('ot_treasury');

export function deriveDistributorPda(otMint: PublicKey, ydProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [MERKLE_DIST_SEED, otMint.toBuffer()],
    ydProgramId,
  )[0];
}

export function deriveDistConfigPda(ydProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([DIST_CONFIG_SEED], ydProgramId)[0];
}

export function deriveRwtDistConfigPda(rwtEngineProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([RWT_DIST_CONFIG_SEED], rwtEngineProgramId)[0];
}

export function deriveRwtVaultPda(rwtEngineProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([RWT_VAULT_SEED], rwtEngineProgramId)[0];
}

export function deriveOtTreasuryPda(otMint: PublicKey, otProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [OT_TREASURY_SEED, otMint.toBuffer()],
    otProgramId,
  )[0];
}

export function deriveClaimStatusPda(args: {
  distributor: PublicKey;
  claimant: PublicKey;
  ydProgramId: PublicKey;
}): PublicKey {
  return PublicKey.findProgramAddressSync(
    [CLAIM_STATUS_SEED, args.distributor.toBuffer(), args.claimant.toBuffer()],
    args.ydProgramId,
  )[0];
}
