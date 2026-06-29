import crypto from "node:crypto";
import { env } from "../config/env.js";

// AES-256-GCM envelope encryption for high-sensitivity fields (#314).
// In production, FIELD_ENCRYPTION_KEY should be a KMS-derived data key.
// Key rotation: each encrypted value carries a key_version tag so
// re-encryption jobs can identify which records need updating.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getKey(version: number): Buffer {
  const raw = env.FIELD_ENCRYPTION_KEY ?? "";
  if (!raw || raw.length < 32) {
    throw new Error("FIELD_ENCRYPTION_KEY must be at least 32 characters");
  }
  // Derive a version-specific key by hashing the base key + version.
  // In production, replace with AWS KMS GenerateDataKey for each version.
  return crypto
    .createHash("sha256")
    .update(`${raw}:v${version}`)
    .digest();
}

export const CURRENT_KEY_VERSION = Number(env.FIELD_ENCRYPTION_KEY_VERSION ?? 1);

export interface EncryptedValue {
  ciphertext: string; // base64
  iv: string;         // base64
  tag: string;        // base64
  key_version: number;
}

export function encryptField(plaintext: string): EncryptedValue {
  const iv = crypto.randomBytes(IV_BYTES);
  const key = getKey(CURRENT_KEY_VERSION);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    key_version: CURRENT_KEY_VERSION,
  };
}

export function decryptField(value: EncryptedValue): string {
  const key = getKey(value.key_version);
  const iv = Buffer.from(value.iv, "base64");
  const tag = Buffer.from(value.tag, "base64");
  const ciphertext = Buffer.from(value.ciphertext, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

export function encryptFieldToJson(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;
  return JSON.stringify(encryptField(plaintext));
}

export function decryptFieldFromJson(json: string | null | undefined): string | null {
  if (json == null) return null;
  return decryptField(JSON.parse(json) as EncryptedValue);
}
