import crypto from "node:crypto";

/** 开放 API 密钥统一前缀，便于日志与前端一眼识别。 */
export const apiKeyTag = "hj_";
/** 前缀之后的随机串长度。 */
export const apiKeySecretLength = 24;
/** 入库与展示用的短前缀取随机串的前几位，例如 hj_a1B2。 */
export const apiKeyPrefixLength = 4;
/** 每个用户最多同时持有几把有效密钥。 */
export const maxActiveApiKeysPerUser = 5;

const apiKeyAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const apiKeyPattern = new RegExp(`^${apiKeyTag}[A-Za-z0-9]{${apiKeySecretLength}}$`);

/** 生成一把新密钥的明文；只在创建时返回一次，之后库里只留 sha256。 */
export function generateApiKeySecret(): string {
  let random = "";
  for (let index = 0; index < apiKeySecretLength; index += 1) {
    random += apiKeyAlphabet[crypto.randomInt(0, apiKeyAlphabet.length)];
  }
  return `${apiKeyTag}${random}`;
}

export function isApiKeySecret(value: string | null | undefined): value is string {
  return typeof value === "string" && apiKeyPattern.test(value);
}

export function hashApiKeySecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/** 展示前缀：hj_ + 随机串前 4 位，前端再自行补省略号。 */
export function apiKeyPrefix(secret: string): string {
  return secret.slice(0, apiKeyTag.length + apiKeyPrefixLength);
}

/** 从 Authorization 头里取出 Bearer 令牌；不是 Bearer 或为空时返回 null。 */
export function parseBearerToken(header: string | null | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = header.match(/^Bearer[ \t]+(\S+)[ \t]*$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}
