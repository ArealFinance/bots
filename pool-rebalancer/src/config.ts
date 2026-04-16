import 'dotenv/config';

export const CONFIG = {
  CHECK_INTERVAL_MS: 60_000,         // 60 seconds
  REBALANCE_THRESHOLD: 0.01,         // 1% deviation
  TARGET_BIN_COUNT: 40,
  DEBOUNCE_MS: 30_000,               // 30 sec min between shifts
  RPC_URL: process.env.RPC_URL || 'http://127.0.0.1:8899',
  REBALANCER_KEYPAIR: process.env.REBALANCER_KEYPAIR || '',
  DEX_PROGRAM_ID: process.env.DEX_PROGRAM_ID || '5FAB2HRFT78AqmQ7c3auV3ttcqnoNx3VjDBYkSQbSZXL',
  RWT_ENGINE_PROGRAM_ID: process.env.RWT_ENGINE_PROGRAM_ID || '',
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 2_000,
};
