/// Calculate the target NAV bin ID from a NAV price and bin step.
///
/// nav_bin = round(log(nav_price) / log(1 + bin_step_bps / 10000))
///
/// bin_step_bps: price step between bins in basis points (e.g., 10 = 0.1%)
/// nav_price: target price in decimal (e.g., 1.05 = $1.05)
export function calculateNavBin(navPrice: number, binStepBps: number): number {
  if (navPrice <= 0 || binStepBps <= 0) {
    throw new Error(`Invalid inputs: navPrice=${navPrice}, binStepBps=${binStepBps}`);
  }
  const logBase = Math.log(1 + binStepBps / 10_000);
  return Math.round(Math.log(navPrice) / logBase);
}

/// Calculate the pool price from active_bin_id and bin_step_bps.
///
/// pool_price = (1 + bin_step_bps / 10000) ^ active_bin_id
export function calculatePoolPrice(activeBinId: number, binStepBps: number): number {
  return Math.pow(1 + binStepBps / 10_000, activeBinId);
}

/// Calculate deviation between pool price and NAV price.
///
/// Returns absolute fractional deviation: |pool_price - nav_price| / nav_price
export function calculateDeviation(poolPrice: number, navPrice: number): number {
  if (navPrice === 0) return Infinity;
  return Math.abs(poolPrice - navPrice) / navPrice;
}
