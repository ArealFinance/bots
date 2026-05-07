import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import * as fs from 'node:fs';
import type { BotMetrics, KmsProvider } from '@areal/bots-shared';

import type { BotConfig } from './config.js';
import { logger } from './logger.js';

/**
 * Abstract signer interface — decouples publisher from key-custody mechanism.
 *
 * Implementations:
 *  - LocalMockSigner:  reads ed25519 keypair from disk. DEVNET ONLY.
 *  - AwsKmsSigner:     delegates signing to AWS KMS (ED25519 key spec).
 *  - GcpKmsSigner:     delegates signing to GCP Cloud KMS (EC_SIGN_ED25519).
 *
 * Both cloud signers:
 *  - Fetch the public key via the provider's GetPublicKey / getPublicKey API.
 *  - Parse the returned SPKI DER to extract the 32-byte raw ed25519 point.
 *  - On `signTransaction`, serialize the message, call the provider's Sign /
 *    asymmetricSign API with `EDDSA` / `EC_SIGN_ED25519` algorithm, then
 *    attach the returned 64-byte signature via `tx.addSignature`.
 *
 * AWS KMS ED25519 note: `KeySpec=ECC_ED25519` is required. As of 2024+ this
 * is available in us-east-1, eu-west-1, ap-northeast-1, and a few others.
 * If `DescribeKey`/`GetPublicKey` returns a non-EDDSA KeySpec, the signer
 * throws in its startup probe with a recommendation to use Turnkey/Fireblocks.
 */
export interface KmsSigner {
  /** Solana pubkey (ed25519) corresponding to the KMS key material. */
  readonly publicKey: PublicKey;

  /** Phase 21: provider tag used as the `provider` metric label. */
  readonly provider: KmsProvider;

  /** Sign a legacy Solana Transaction — adds signature in-place. */
  signTransaction(tx: Transaction): Promise<Transaction>;

  /** Sign a versioned Solana Transaction — adds signature in-place. */
  signVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;

  /** Sign raw bytes — used to sign the proof manifest (`_index.json`). */
  signRaw(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * SPKI ed25519 public key DER parsing.
 *
 * Per RFC 8410, an ed25519 SPKI looks like:
 *
 *   30 2A                          ; SEQUENCE (42 bytes)
 *     30 05                        ; SEQUENCE (AlgorithmIdentifier, 5 bytes)
 *       06 03 2B 65 70             ; OID 1.3.101.112 (id-Ed25519)
 *     03 21                        ; BIT STRING (33 bytes)
 *       00                         ; unused-bits = 0
 *       <32 bytes of raw ed25519 public key point>
 *
 * Total: 44 bytes. We validate the fixed prefix and copy the trailing 32 bytes.
 *
 * We do not pull in `asn1.js` to keep the dep surface small and avoid
 * transitive risk — parsing a fixed-shape 44-byte SPKI is unambiguous.
 */
export function parseEd25519Spki(spki: Uint8Array): Uint8Array {
  if (spki.length < 44) {
    throw new Error(`parseEd25519Spki: SPKI too short (${spki.length} bytes)`);
  }
  // Find the last 32 bytes — standard ed25519 SPKI buffer has the raw point at
  // the tail. For a tight validation, also assert the OID prefix.
  // Prefix: 30 2A 30 05 06 03 2B 65 70 03 21 00
  const prefix = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
  // Accept either: exact SPKI header at offset 0, OR any SPKI where the OID
  // block appears (some providers wrap differently, but all standard-compliant
  // outputs include this exact 12-byte prefix immediately before the 32-byte
  // point).
  const bytes = Buffer.from(spki);
  const idx = bytes.indexOf(prefix);
  if (idx === -1) {
    throw new Error(
      'parseEd25519Spki: could not find ed25519 OID prefix in SPKI DER. ' +
        'Ensure KMS key is ED25519/EC_SIGN_ED25519, not ECDSA or RSA.',
    );
  }
  const rawStart = idx + prefix.length;
  if (rawStart + 32 > bytes.length) {
    throw new Error('parseEd25519Spki: SPKI truncated after OID prefix');
  }
  return bytes.subarray(rawStart, rawStart + 32);
}

/**
 * Local keypair signer — loads an ed25519 keypair from a JSON file on disk.
 *
 * SECURITY:
 *   - DEVNET / TEST ONLY.
 *   - Raw keypair material lives in process memory and on disk.
 *   - `loadConfig()` enforces refusal on mainnet networks; double-checked at
 *     instantiation below (belt-and-suspenders).
 *   - On POSIX hosts we require `chmod 0600` — group/world-readable bits are
 *     refused (M-1).
 */
export class LocalMockSigner implements KmsSigner {
  public readonly publicKey: PublicKey;
  public readonly provider: KmsProvider = 'local';
  private readonly keypair: Keypair;
  private readonly metrics?: BotMetrics;

  constructor(keypairPath: string, metrics?: BotMetrics) {
    this.metrics = metrics;
    if (!fs.existsSync(keypairPath)) {
      throw new Error(`LocalMockSigner: keypair file not found`);
    }

    // M-1: refuse to load a world/group-readable keypair.
    if (process.platform !== 'win32') {
      const stat = fs.statSync(keypairPath);
      const mode = stat.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new Error(
          `LocalMockSigner: keypair file has group/world readable perms (mode=${mode.toString(8)}); expected 0600. ` +
            `Run: chmod 600 <path>`,
        );
      }
    }

    const raw = JSON.parse(fs.readFileSync(keypairPath, 'utf-8')) as number[];
    if (!Array.isArray(raw) || raw.length !== 64) {
      throw new Error(
        `LocalMockSigner: invalid keypair JSON — expected 64-byte array`,
      );
    }
    this.keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
    this.publicKey = this.keypair.publicKey;
    logger.warn('LocalMockSigner loaded — NOT SAFE FOR MAINNET', {
      pubkey: this.publicKey.toBase58(),
    });
  }

  /** Phase 21: route every sign call through observeKmsSign when metrics
   *  is wired. The wrap is a no-op when metrics is undefined (test paths). */
  private observe<T>(op: () => Promise<T>): Promise<T> {
    return this.metrics ? this.metrics.observeKmsSign(this.provider, op) : op();
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    return this.observe(async () => {
      tx.partialSign(this.keypair);
      return tx;
    });
  }

  async signVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    return this.observe(async () => {
      tx.sign([this.keypair]);
      return tx;
    });
  }

  async signRaw(message: Uint8Array): Promise<Uint8Array> {
    return this.observe(async () => {
      // Use tweetnacl-style ed25519 via Keypair's private key — @solana/web3.js
      // doesn't expose sign-only, but we can use Node's crypto.sign with PKCS8
      // import; simplest here is to re-use `nacl` via the keypair.
      // Node 18+ ships native `crypto.sign(null, message, privateKeyObject)` for
      // ed25519 keys — but without a PKCS8 wrapper we'd have to build one. Cheap
      // alternative: use tweetnacl from @solana/web3.js's own bundle indirectly
      // via a synchronous ed25519-sign path.
      const { default: nacl } = await import('tweetnacl');
      return nacl.sign.detached(message, this.keypair.secretKey);
    });
  }
}

/**
 * AWS KMS ED25519 signer.
 *
 * Assumes:
 *   - Key exists in AWS KMS with `KeySpec=ECC_ED25519` in the configured region.
 *   - IAM role / credentials permit `kms:GetPublicKey` + `kms:Sign`.
 *
 * Startup flow:
 *   1. Construct AWS SDK v3 KMS client.
 *   2. Call `GetPublicKey` to fetch SPKI DER.
 *   3. Parse SPKI to raw 32-byte ed25519 public key.
 *   4. Expose as `publicKey` (Solana `PublicKey`).
 *
 * Signing flow:
 *   1. `tx.serializeMessage()` → raw bytes.
 *   2. `Sign { KeyId, Message, MessageType: 'RAW', SigningAlgorithm: 'EDDSA' }`.
 *   3. Response `Signature` is a 64-byte raw ed25519 signature for EDDSA keys.
 *   4. `tx.addSignature(publicKey, signatureBuffer)`.
 *
 * Note: `getPublicKey()` is async, so we use a factory (`AwsKmsSigner.create`)
 * rather than a synchronous constructor. `createKmsSigner` in this module is
 * also async.
 */
export class AwsKmsSigner implements KmsSigner {
  public readonly publicKey: PublicKey;
  public readonly provider: KmsProvider = 'aws';
  private readonly metrics?: BotMetrics;

  // Kept narrow on purpose — we only need these two operations.
  private constructor(
    private readonly client: {
      send: (cmd: unknown) => Promise<{ Signature?: Uint8Array; PublicKey?: Uint8Array; KeySpec?: string }>;
    },
    private readonly SignCommand: new (input: Record<string, unknown>) => unknown,
    private readonly keyId: string,
    publicKey: PublicKey,
    metrics?: BotMetrics,
  ) {
    this.publicKey = publicKey;
    this.metrics = metrics;
  }

  static async create(keyId: string, region: string, metrics?: BotMetrics): Promise<AwsKmsSigner> {
    const { KMSClient, GetPublicKeyCommand, SignCommand } = await import(
      '@aws-sdk/client-kms'
    );
    const client = new KMSClient({ region });
    logger.info('AwsKmsSigner probing KMS key', { region });

    const pkResp = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (!pkResp.PublicKey) {
      throw new Error('AwsKmsSigner: GetPublicKey returned no PublicKey');
    }
    // `KeySpec` is typed as a closed union in the SDK; compare as a string so
    // we don't break when AWS adds new values.
    if (String(pkResp.KeySpec) !== 'ECC_ED25519') {
      throw new Error(
        `AwsKmsSigner: KMS key has KeySpec="${String(pkResp.KeySpec)}", expected "ECC_ED25519". ` +
          'This region/key does not support Ed25519 signing. ' +
          'Use Turnkey, Fireblocks, or GCP Cloud KMS instead.',
      );
    }
    const raw = parseEd25519Spki(pkResp.PublicKey);
    const publicKey = new PublicKey(raw);
    logger.info('AwsKmsSigner ready', { pubkey: publicKey.toBase58() });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new AwsKmsSigner(client as any, SignCommand as any, keyId, publicKey, metrics);
  }

  /** Phase 21: route the underlying KMS call through observeKmsSign when
   *  metrics is wired. */
  private observe<T>(op: () => Promise<T>): Promise<T> {
    return this.metrics ? this.metrics.observeKmsSign(this.provider, op) : op();
  }

  private async signMessageBytes(message: Uint8Array): Promise<Buffer> {
    return this.observe(async () => {
      const cmd = new this.SignCommand({
        KeyId: this.keyId,
        Message: message,
        MessageType: 'RAW',
        SigningAlgorithm: 'EDDSA',
      });
      const resp = await this.client.send(cmd);
      if (!resp.Signature) {
        throw new Error('AwsKmsSigner: Sign returned no Signature');
      }
      const sig = Buffer.from(resp.Signature);
      if (sig.length !== 64) {
        throw new Error(
          `AwsKmsSigner: expected 64-byte ed25519 signature, got ${sig.length}`,
        );
      }
      return sig;
    });
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    const message = tx.serializeMessage();
    const sig = await this.signMessageBytes(message);
    tx.addSignature(this.publicKey, sig);
    return tx;
  }

  async signVersionedTransaction(
    tx: VersionedTransaction,
  ): Promise<VersionedTransaction> {
    const message = tx.message.serialize();
    const sig = await this.signMessageBytes(message);
    tx.addSignature(this.publicKey, sig);
    return tx;
  }

  async signRaw(message: Uint8Array): Promise<Uint8Array> {
    return this.signMessageBytes(message);
  }
}

/**
 * GCP Cloud KMS Ed25519 signer.
 *
 * Requires a GCP Cloud KMS key version with algorithm `EC_SIGN_ED25519`.
 * GCP accepts `Digest` only for ECDSA; for EdDSA it takes the raw `data`
 * bytes and expects a 64-byte raw signature in return.
 */
export class GcpKmsSigner implements KmsSigner {
  public readonly publicKey: PublicKey;
  public readonly provider: KmsProvider = 'gcp';
  private readonly metrics?: BotMetrics;

  private constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly client: any,
    private readonly keyVersionName: string,
    publicKey: PublicKey,
    metrics?: BotMetrics,
  ) {
    this.publicKey = publicKey;
    this.metrics = metrics;
  }

  static async create(keyVersionName: string, metrics?: BotMetrics): Promise<GcpKmsSigner> {
    const { KeyManagementServiceClient } = await import('@google-cloud/kms');
    const client = new KeyManagementServiceClient();

    logger.info('GcpKmsSigner probing KMS key', { keyVersionName });
    const [pk] = await client.getPublicKey({ name: keyVersionName });
    if (!pk?.pem) {
      throw new Error('GcpKmsSigner: getPublicKey returned no PEM');
    }
    if (pk.algorithm && String(pk.algorithm) !== 'EC_SIGN_ED25519') {
      throw new Error(
        `GcpKmsSigner: key version algorithm="${pk.algorithm}", expected "EC_SIGN_ED25519".`,
      );
    }

    // PEM → DER → SPKI parse.
    const der = pemToDer(pk.pem);
    const raw = parseEd25519Spki(der);
    const publicKey = new PublicKey(raw);
    logger.info('GcpKmsSigner ready', { pubkey: publicKey.toBase58() });

    return new GcpKmsSigner(client, keyVersionName, publicKey, metrics);
  }

  /** Phase 21: route asymmetricSign through observeKmsSign when wired. */
  private observe<T>(op: () => Promise<T>): Promise<T> {
    return this.metrics ? this.metrics.observeKmsSign(this.provider, op) : op();
  }

  private async signMessageBytes(message: Uint8Array): Promise<Buffer> {
    return this.observe(async () => {
      const [resp] = await this.client.asymmetricSign({
        name: this.keyVersionName,
        data: message,
      });
      if (!resp?.signature) {
        throw new Error('GcpKmsSigner: asymmetricSign returned no signature');
      }
      const sig = Buffer.from(resp.signature as Buffer | Uint8Array);
      if (sig.length !== 64) {
        throw new Error(
          `GcpKmsSigner: expected 64-byte ed25519 signature, got ${sig.length}`,
        );
      }
      return sig;
    });
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    const message = tx.serializeMessage();
    const sig = await this.signMessageBytes(message);
    tx.addSignature(this.publicKey, sig);
    return tx;
  }

  async signVersionedTransaction(
    tx: VersionedTransaction,
  ): Promise<VersionedTransaction> {
    const message = tx.message.serialize();
    const sig = await this.signMessageBytes(message);
    tx.addSignature(this.publicKey, sig);
    return tx;
  }

  async signRaw(message: Uint8Array): Promise<Uint8Array> {
    return this.signMessageBytes(message);
  }
}

/** Strip PEM wrapper and base64-decode into DER bytes. */
function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

/**
 * Factory — async because AWS/GCP signers must probe the KMS before they are
 * usable.
 */
export async function createKmsSigner(
  cfg: BotConfig,
  metrics?: BotMetrics,
): Promise<KmsSigner> {
  switch (cfg.kmsProvider) {
    case 'local':
      if (cfg.network === 'mainnet') {
        // Defense-in-depth (already checked in loadConfig).
        throw new Error('LocalMockSigner forbidden on mainnet');
      }
      return new LocalMockSigner(cfg.kmsKeyId, metrics);
    case 'aws':
      return AwsKmsSigner.create(cfg.kmsKeyId, cfg.awsRegion, metrics);
    case 'gcp':
      return GcpKmsSigner.create(cfg.kmsKeyId, metrics);
    default: {
      const _exhaustive: never = cfg.kmsProvider;
      throw new Error(`Unknown KMS provider: ${String(_exhaustive)}`);
    }
  }
}
