import { CryptoService } from "./crypto.service";

describe("CryptoService", () => {
  let svc: CryptoService;

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "fatal";
    process.env.API_PORT = "4000";
    process.env.API_PUBLIC_URL = "http://localhost:4000";
    process.env.WEB_PUBLIC_URL = "http://localhost:3000";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET = Buffer.alloc(64, 1).toString("base64");
    process.env.JWT_REFRESH_SECRET = Buffer.alloc(64, 2).toString("base64");
    process.env.ENCRYPTION_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.COOKIE_DOMAIN = "localhost";
    process.env.COOKIE_SECURE = "false";
  });

  beforeEach(() => {
    svc = new CryptoService();
  });

  it("round-trips a plaintext through AES-256-GCM", () => {
    const plain = "JBSWY3DPEHPK3PXP"; // example TOTP seed
    const encrypted = svc.encrypt(plain);
    expect(encrypted).not.toBe(plain);
    expect(svc.decrypt(encrypted)).toBe(plain);
  });

  it("produces different ciphertext on each call (random IV)", () => {
    const plain = "secret";
    expect(svc.encrypt(plain)).not.toBe(svc.encrypt(plain));
  });

  it("rejects tampered ciphertext (auth-tag verification)", () => {
    const encrypted = svc.encrypt("payload");
    const buf = Buffer.from(encrypted, "base64");
    // flip a bit in the middle of the data.
    buf[buf.length - 4]! ^= 0x01;
    const tampered = buf.toString("base64");
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it("constant-time equal returns false for differing length without short-circuit timing", () => {
    expect(svc.constantTimeEqual("abc", "abcd")).toBe(false);
    expect(svc.constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("sha256 is stable across calls", () => {
    expect(svc.sha256("test")).toBe(svc.sha256("test"));
    expect(svc.sha256("test")).not.toBe(svc.sha256("other"));
  });

  it("randomToken returns hex string of expected length", () => {
    const token = svc.randomToken(16);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});
