/**
 * CryptoService — field-level AES-256-GCM encryption for at-rest secrets.
 * Used for: MFA TOTP seeds, KYC document references, vendor banking metadata.
 * Implementation Plan §4.4.
 *
 * Format of stored ciphertext (base64-encoded, single string for storage):
 *   <12-byte iv> || <ciphertext> || <16-byte auth tag>
 *
 * The master key comes from ENCRYPTION_MASTER_KEY (32 bytes, base64).
 * In production, migrate to a managed KMS (AWS KMS / Hashicorp Vault) per
 * Implementation Plan §4.4 — the interface here is stable across that move.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { loadConfig } from "./config";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

@Injectable()
export class CryptoService {
  private readonly masterKey: Buffer;

  constructor() {
    const cfg = loadConfig();
    this.masterKey = Buffer.from(cfg.ENCRYPTION_MASTER_KEY, "base64");
    if (this.masterKey.length !== 32) {
      throw new Error(
        "ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes (256 bits) of base64.",
      );
    }
  }

  /** Encrypt a UTF-8 string. Returns base64. Safe for variable-length plaintext. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, tag]).toString("base64");
  }

  /** Decrypt a string previously produced by `encrypt`. Throws on tamper. */
  decrypt(ciphertextBase64: string): string {
    const buf = Buffer.from(ciphertextBase64, "base64");
    if (buf.length < IV_LEN + TAG_LEN + 1) {
      throw new Error("Ciphertext is too short to be valid.");
    }
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const data = buf.subarray(IV_LEN, buf.length - TAG_LEN);

    const decipher = createDecipheriv(ALGO, this.masterKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString("utf8");
  }

  /**
   * SHA-256 hex digest. Use for non-secret identifiers (e.g., refresh token
   * lookup keys). Use Argon2 for passwords — never this.
   */
  sha256(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }

  /**
   * Constant-time string comparison. Use whenever you compare a user-supplied
   * value to a stored secret to avoid timing attacks.
   */
  constantTimeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  /** Cryptographically secure random hex string of the given byte length. */
  randomToken(byteLength = 32): string {
    return randomBytes(byteLength).toString("hex");
  }
}
