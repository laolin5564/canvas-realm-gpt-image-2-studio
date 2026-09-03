import { describe, expect, test } from "bun:test";
import {
  apiKeyPrefix,
  apiKeyPrefixLength,
  apiKeySecretLength,
  apiKeyTag,
  generateApiKeySecret,
  hashApiKeySecret,
  isApiKeySecret,
  parseBearerToken,
} from "../lib/api-keys";

describe("generateApiKeySecret / isApiKeySecret", () => {
  test("生成的密钥符合 hj_ + 24 位字母数字", () => {
    const secret = generateApiKeySecret();
    expect(secret.length).toBe(apiKeyTag.length + apiKeySecretLength);
    expect(secret.startsWith(apiKeyTag)).toBe(true);
    expect(isApiKeySecret(secret)).toBe(true);
  });

  test("两次生成不重复", () => {
    const first = generateApiKeySecret();
    const second = generateApiKeySecret();
    expect(first === second).toBe(false);
  });

  test("格式不对的一律拒绝", () => {
    expect(isApiKeySecret("hj_short")).toBe(false);
    expect(isApiKeySecret("sk_012345678901234567890123")).toBe(false);
    expect(isApiKeySecret(`${apiKeyTag}0123456789012345678901234`)).toBe(false);
    expect(isApiKeySecret(`${apiKeyTag}01234567890123456789012-`)).toBe(false);
    expect(isApiKeySecret(null)).toBe(false);
    expect(isApiKeySecret(undefined)).toBe(false);
  });
});

describe("hashApiKeySecret / apiKeyPrefix", () => {
  test("哈希是 64 位十六进制且与明文不同", () => {
    const secret = generateApiKeySecret();
    const hash = hashApiKeySecret(secret);
    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
    expect(hash === secret).toBe(false);
  });

  test("同一明文哈希稳定，不同明文哈希不同", () => {
    const secret = generateApiKeySecret();
    expect(hashApiKeySecret(secret)).toBe(hashApiKeySecret(secret));
    expect(hashApiKeySecret(secret) === hashApiKeySecret(generateApiKeySecret())).toBe(false);
  });

  test("展示前缀取 hj_ 加随机串前 4 位", () => {
    const secret = generateApiKeySecret();
    const prefix = apiKeyPrefix(secret);
    expect(prefix.length).toBe(apiKeyTag.length + apiKeyPrefixLength);
    expect(secret.startsWith(prefix)).toBe(true);
  });
});

describe("parseBearerToken", () => {
  test("大小写与多空格都能解析", () => {
    expect(parseBearerToken("Bearer hj_abc")).toBe("hj_abc");
    expect(parseBearerToken("bearer   hj_abc")).toBe("hj_abc");
    expect(parseBearerToken("BEARER\thj_abc")).toBe("hj_abc");
  });

  test("缺失或非 Bearer 时返回 null", () => {
    expect(parseBearerToken(null)).toBe(null);
    expect(parseBearerToken("")).toBe(null);
    expect(parseBearerToken("Bearer")).toBe(null);
    expect(parseBearerToken("Bearer ")).toBe(null);
    expect(parseBearerToken("Basic hj_abc")).toBe(null);
  });
});
