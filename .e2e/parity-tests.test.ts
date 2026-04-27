/**
 * R26 / R34 — event byte-parity audit.
 *
 * Walks the Rust `events.rs` files for each program and compares the field
 * sequence (name + type) against a hand-coded TS schema that mirrors what
 * the dashboard / publisher decodes on the wire. Any mismatch fails the test
 * — protecting the off-chain pipeline against silent layout drift when a
 * field is added/removed/reordered in `#[event] pub struct ...`.
 *
 * Coverage (architecture §10.4 — 11 events total):
 *   Layer 8 (5):
 *     - StreamConverted              (yield-distribution)
 *     - LiquidityHoldingFunded       (rwt-engine)
 *     - YieldDistributed             (rwt-engine)
 *     - CompoundYieldExecuted        (native-dex)
 *     - TreasuryYieldClaimed         (ownership-token)
 *   Layer 9 (6):
 *     - NexusInitialized             (native-dex)
 *     - NexusDeposited               (native-dex)
 *     - NexusProfitsWithdrawn        (native-dex)
 *     - NexusRewardsClaimed          (native-dex)
 *     - NexusManagerUpdated          (native-dex)
 *     - LiquidityHoldingWithdrawn    (yield-distribution)
 *
 * The Rust parser is deliberately regex-based: event structs follow a tight
 * pattern (`#[event] pub struct Name { pub field: Type, ... }`) and we'd
 * rather fail the parity test than hide a layout drift behind a clever AST
 * walker.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

interface FieldSpec {
  name: string;
  type: string;
}

/** Hand-coded mirror of each event's on-chain layout. */
interface EventSchema {
  program: 'yield-distribution' | 'native-dex' | 'rwt-engine' | 'ownership-token';
  name: string;
  fields: FieldSpec[];
}

const SCHEMAS: EventSchema[] = [
  // Layer 8 — pinned during Layer 8 acceptance, restated here so any drift
  // in events.rs surfaces in Substep 13 CI rather than at on-chain decode.
  {
    program: 'ownership-token',
    name: 'RevenueDistributed',
    fields: [
      { name: 'ot_mint', type: '[u8; 32]' },
      { name: 'total_amount', type: 'u64' },
      { name: 'protocol_fee', type: 'u64' },
      { name: 'distribution_count', type: 'u64' },
      { name: 'num_destinations', type: 'u8' },
      { name: 'timestamp', type: 'i64' },
    ],
  },
  {
    program: 'yield-distribution',
    name: 'StreamConverted',
    fields: [
      { name: 'distributor', type: '[u8; 32]' },
      { name: 'ot_mint', type: '[u8; 32]' },
      { name: 'amount', type: 'u64' },
      { name: 'protocol_fee', type: 'u64' },
      { name: 'total_funded', type: 'u64' },
      { name: 'locked_vested', type: 'u64' },
      { name: 'timestamp', type: 'i64' },
      { name: 'usdc_in', type: 'u64' },
      { name: 'swap_out_rwt', type: 'u64' },
      { name: 'mint_out_rwt', type: 'u64' },
    ],
  },
  {
    program: 'rwt-engine',
    name: 'LiquidityHoldingFunded',
    fields: [
      { name: 'liquidity_holding', type: '[u8; 32]' },
      { name: 'ot_mint', type: '[u8; 32]' },
      { name: 'amount', type: 'u64' },
      { name: 'timestamp', type: 'i64' },
    ],
  },
  {
    program: 'rwt-engine',
    name: 'YieldDistributed',
    fields: [
      { name: 'vault', type: '[u8; 32]' },
      { name: 'ot_mint', type: '[u8; 32]' },
      { name: 'total_yield', type: 'u64' },
      { name: 'book_value_share', type: 'u64' },
      { name: 'liquidity_share', type: 'u64' },
      { name: 'protocol_revenue_share', type: 'u64' },
      { name: 'nav_before', type: 'u64' },
      { name: 'nav_after', type: 'u64' },
      { name: 'timestamp', type: 'i64' },
    ],
  },
  {
    program: 'native-dex',
    name: 'CompoundYieldExecuted',
    fields: [
      { name: 'pool', type: '[u8; 32]' },
      { name: 'ot_mint', type: '[u8; 32]' },
      { name: 'rwt_claimed', type: 'u64' },
      { name: 'rwt_side', type: 'u8' },
      { name: 'reserve_after', type: 'u64' },
      { name: 'timestamp', type: 'i64' },
    ],
  },
  {
    program: 'ownership-token',
    name: 'TreasuryYieldClaimed',
    fields: [
      { name: 'ot_mint', type: '[u8; 32]' },
      { name: 'yd_ot_mint', type: '[u8; 32]' },
      { name: 'amount', type: 'u64' },
      { name: 'timestamp', type: 'i64' },
    ],
  },
  // Layer 9 — Nexus events (native-dex) + LiquidityHoldingWithdrawn (yd)
  {
    program: 'native-dex',
    name: 'NexusInitialized',
    fields: [
      { name: 'manager', type: '[u8; 32]' },
      { name: 'timestamp', type: 'i64' },
    ],
  },
  {
    program: 'native-dex',
    name: 'NexusDeposited',
    fields: [
      { name: 'token_mint', type: '[u8; 32]' },
      { name: 'amount', type: 'u64' },
      { name: 'new_total_deposited', type: 'u64' },
      { name: 'source_kind', type: 'u8' },
      { name: 'timestamp', type: 'i64' },
    ],
  },
  {
    program: 'native-dex',
    name: 'NexusProfitsWithdrawn',
    fields: [
      { name: 'token_mint', type: '[u8; 32]' },
      { name: 'amount', type: 'u64' },
      { name: 'remaining_profit', type: 'u64' },
      { name: 'treasury_destination', type: '[u8; 32]' },
      { name: 'timestamp', type: 'i64' },
    ],
  },
  {
    program: 'native-dex',
    name: 'NexusRewardsClaimed',
    fields: [
      { name: 'amount', type: 'u64' },
      { name: 'treasury_destination', type: '[u8; 32]' },
      { name: 'timestamp', type: 'i64' },
    ],
  },
  {
    program: 'native-dex',
    name: 'NexusManagerUpdated',
    fields: [
      { name: 'old_manager', type: '[u8; 32]' },
      { name: 'new_manager', type: '[u8; 32]' },
      { name: 'timestamp', type: 'i64' },
    ],
  },
  {
    program: 'yield-distribution',
    name: 'LiquidityHoldingWithdrawn',
    fields: [
      { name: 'liquidity_holding', type: '[u8; 32]' },
      { name: 'destination_nexus', type: '[u8; 32]' },
      { name: 'amount', type: 'u64' },
      { name: 'cumulative_withdrawn', type: 'u64' },
      { name: 'slot', type: 'u64' },
      { name: 'timestamp', type: 'i64' },
    ],
  },
];

/** Cache-per-program — events.rs is small and we read it multiple times. */
const eventsCache = new Map<string, string>();

function eventsFile(program: string): string {
  const cached = eventsCache.get(program);
  if (cached) return cached;
  const path = resolve(REPO_ROOT, 'contracts', program, 'src', 'events.rs');
  if (!existsSync(path)) {
    throw new Error(`events.rs not found at ${path}`);
  }
  const body = readFileSync(path, 'utf8');
  eventsCache.set(program, body);
  return body;
}

/**
 * Extract the field list (in declaration order) of `#[event] pub struct Name`
 * from a Rust events.rs body. Returns null if the struct isn't found.
 */
function parseRustEvent(body: string, structName: string): FieldSpec[] | null {
  // Match `pub struct Name { ... }` body; allow attributes/whitespace.
  const re = new RegExp(
    String.raw`pub\s+struct\s+${structName}\s*\{([\s\S]*?)\n\}`,
    'm',
  );
  const m = body.match(re);
  if (!m) return null;
  const inner = m[1] ?? '';

  // Strip line comments + trim.
  const stripped = inner.replace(/\/\/.*$/gm, '');

  // Each field: `pub <name>: <type>,` — type may contain commas inside `[u8; N]`.
  const fields: FieldSpec[] = [];
  // Walk by lines; group `pub <name>: <typeUpToTrailingComma>`.
  const lines = stripped.split('\n');
  let buffer = '';
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    buffer += (buffer ? ' ' : '') + trimmed;
    if (buffer.endsWith(',')) {
      const fieldText = buffer.slice(0, -1).trim();
      buffer = '';
      const fm = fieldText.match(/^pub\s+(\w+)\s*:\s*(.+)$/);
      if (!fm) continue;
      fields.push({ name: fm[1]!, type: normalizeType(fm[2]!) });
    }
  }
  // Trailing field without comma (rare but possible).
  if (buffer) {
    const fm = buffer.match(/^pub\s+(\w+)\s*:\s*(.+)$/);
    if (fm) fields.push({ name: fm[1]!, type: normalizeType(fm[2]!) });
  }
  return fields;
}

function normalizeType(t: string): string {
  // Compress arbitrary whitespace.
  return t.replace(/\s+/g, ' ').trim();
}

for (const schema of SCHEMAS) {
  test(`parity ${schema.program}::${schema.name}`, () => {
    const body = eventsFile(schema.program);
    const actual = parseRustEvent(body, schema.name);
    assert.ok(actual, `event struct ${schema.name} not found in ${schema.program}/events.rs`);

    // Compare names + types in declaration order.
    const actualNames = actual!.map((f) => f.name);
    const expectedNames = schema.fields.map((f) => f.name);
    assert.deepEqual(
      actualNames,
      expectedNames,
      `field name/order mismatch for ${schema.name}: rust=${JSON.stringify(actualNames)} schema=${JSON.stringify(expectedNames)}`,
    );

    for (let i = 0; i < schema.fields.length; i++) {
      const exp = schema.fields[i]!;
      const got = actual![i]!;
      assert.equal(
        got.type,
        exp.type,
        `${schema.name}.${exp.name}: type drift rust="${got.type}" schema="${exp.type}"`,
      );
    }
  });
}

test('parity — every schema entry actually parses', () => {
  // Smoke: ensure nothing in SCHEMAS references a missing struct (regression
  // protection if someone adds a schema without a Rust counterpart).
  for (const schema of SCHEMAS) {
    const body = eventsFile(schema.program);
    const actual = parseRustEvent(body, schema.name);
    assert.ok(actual, `${schema.name} has no Rust counterpart in ${schema.program}/events.rs`);
  }
});

test('parity — 11 events covered (architecture §10.4)', () => {
  assert.ok(
    SCHEMAS.length >= 11,
    `expected >=11 event schemas (architecture §10.4 target), got ${SCHEMAS.length}`,
  );
});
