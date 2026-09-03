import { describe, expect, test } from "bun:test";
import { signedFileUrl, signedUrlExpiry, signFilePath, verifyFilePath } from "../lib/signed-url";

const secret = "test-signing-secret";
const filePath = "2026/09/03/task_abc/img_abc.png";
const nowMs = Date.UTC(2026, 8, 3, 0, 0, 0);
const exp = Math.floor(nowMs / 1000) + 3600;

describe("signFilePath / verifyFilePath", () => {
  test("同一路径与过期时间签名稳定", () => {
    expect(signFilePath(filePath, exp, secret)).toBe(signFilePath(filePath, exp, secret));
  });

  test("正确签名放行", () => {
    const sig = signFilePath(filePath, exp, secret);
    expect(verifyFilePath({ filePath, sig, exp, secret, nowMs })).toBe(true);
    expect(verifyFilePath({ filePath, sig, exp: String(exp), secret, nowMs })).toBe(true);
  });

  test("换路径、换密钥、改签名一律拒绝", () => {
    const sig = signFilePath(filePath, exp, secret);
    expect(verifyFilePath({ filePath: "2026/09/03/task_abc/other.png", sig, exp, secret, nowMs })).toBe(false);
    expect(verifyFilePath({ filePath, sig, exp, secret: "another-secret", nowMs })).toBe(false);
    expect(verifyFilePath({ filePath, sig: `${sig}x`, exp, secret, nowMs })).toBe(false);
    expect(verifyFilePath({ filePath, sig: sig.slice(0, -1), exp, secret, nowMs })).toBe(false);
  });

  test("过期或 exp 不是数字一律拒绝", () => {
    const sig = signFilePath(filePath, exp, secret);
    expect(verifyFilePath({ filePath, sig, exp, secret, nowMs: exp * 1000 + 1 })).toBe(false);
    expect(verifyFilePath({ filePath, sig, exp: "12abc", secret, nowMs })).toBe(false);
    expect(verifyFilePath({ filePath, sig, exp: null, secret, nowMs })).toBe(false);
    expect(verifyFilePath({ filePath, sig: null, exp, secret, nowMs })).toBe(false);
    expect(verifyFilePath({ filePath, sig, exp, secret: "", nowMs })).toBe(false);
  });

  test("exp 换一个值签名就不成立", () => {
    const sig = signFilePath(filePath, exp, secret);
    expect(verifyFilePath({ filePath, sig, exp: exp + 1, secret, nowMs })).toBe(false);
  });
});

describe("signedUrlExpiry / signedFileUrl", () => {
  test("默认有效期 7 天", () => {
    expect(signedUrlExpiry(nowMs) - Math.floor(nowMs / 1000)).toBe(7 * 24 * 60 * 60);
  });

  test("拼出绝对地址并带上 sig/exp，缩略图再加 thumb=1", () => {
    const url = signedFileUrl({ origin: "https://img.example.com", filePath, secret, expUnix: exp });
    expect(url.startsWith("https://img.example.com/api/files/2026/09/03/task_abc/img_abc.png?")).toBe(true);
    expect(url).toContain(`exp=${exp}`);
    expect(url).toContain("sig=");

    const thumbUrl = signedFileUrl({ origin: "https://img.example.com/", filePath, secret, expUnix: exp, thumb: true });
    expect(thumbUrl).toContain("thumb=1");
    expect(thumbUrl.startsWith("https://img.example.com/api/files/")).toBe(true);
  });

  test("签出来的地址能被 verifyFilePath 验回去", () => {
    const url = signedFileUrl({ origin: "https://img.example.com", filePath, secret, expUnix: exp });
    const parsed = new URL(url);
    expect(
      verifyFilePath({
        filePath,
        sig: parsed.searchParams.get("sig"),
        exp: parsed.searchParams.get("exp"),
        secret,
        nowMs,
      }),
    ).toBe(true);
  });
});
