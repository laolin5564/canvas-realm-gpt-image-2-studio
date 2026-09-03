import { NextRequest } from "next/server";
import { apiKeyRateLimit, consumeToken, rateLimitedError, type TokenBucketState } from "./api-v1";
import { AuthError } from "./auth";

interface LoginAttemptState {
  count: number;
  firstAttemptAt: number;
  blockedUntil: number;
}

const loginAttempts = new Map<string, LoginAttemptState>();
const activationCodeAttempts = new Map<string, LoginAttemptState>();
const discountCodeAttempts = new Map<string, LoginAttemptState>();
const windowMs = 15 * 60 * 1000;
const blockMs = 15 * 60 * 1000;
const maxFailures = 10;
const activationCodeWindowMs = 10 * 60 * 1000;
const activationCodeBlockMs = 10 * 60 * 1000;
const activationCodeMaxFailures = 5;
const discountCodeWindowMs = 10 * 60 * 1000;
const discountCodeBlockMs = 10 * 60 * 1000;
const discountCodeMaxFailures = 20;

function now(): number {
  return Date.now();
}

function cleanupExpiredAttempts(currentTime = now()): void {
  cleanupAttemptStore(loginAttempts, windowMs, currentTime);
  cleanupAttemptStore(activationCodeAttempts, activationCodeWindowMs, currentTime);
  cleanupAttemptStore(discountCodeAttempts, discountCodeWindowMs, currentTime);
}

function cleanupAttemptStore(store: Map<string, LoginAttemptState>, attemptWindowMs: number, currentTime = now()): void {
  for (const [key, state] of store.entries()) {
    const windowExpired = currentTime - state.firstAttemptAt > attemptWindowMs;
    const blockExpired = state.blockedUntil > 0 && state.blockedUntil <= currentTime;
    if (windowExpired && (state.blockedUntil === 0 || blockExpired)) {
      store.delete(key);
    }
  }
}

export function clientIpFromRequest(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    forwardedFor ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "unknown"
  );
}

export function loginRateLimitKey(request: NextRequest, email: string): string {
  return `${clientIpFromRequest(request)}:${email.toLowerCase()}`;
}

export function assertLoginAllowed(key: string): void {
  cleanupExpiredAttempts();
  const state = loginAttempts.get(key);
  if (state && state.blockedUntil > now()) {
    throw new AuthError("登录失败次数过多，请稍后再试", 429);
  }
}

export function recordLoginFailure(key: string): void {
  recordAttemptFailure(loginAttempts, key, windowMs, blockMs, maxFailures);
}

export function clearLoginFailures(key: string): void {
  loginAttempts.delete(key);
}

export function activationCodeRateLimitKey(request: NextRequest, userId: string): string {
  return `${clientIpFromRequest(request)}:${userId}`;
}

export function assertActivationCodeExchangeAllowed(key: string): void {
  cleanupExpiredAttempts();
  const state = activationCodeAttempts.get(key);
  if (state && state.blockedUntil > now()) {
    throw new AuthError("激活码错误次数过多，请稍后再试", 429);
  }
}

export function recordActivationCodeExchangeFailure(key: string): void {
  recordAttemptFailure(activationCodeAttempts, key, activationCodeWindowMs, activationCodeBlockMs, activationCodeMaxFailures);
}

export function clearActivationCodeExchangeFailures(key: string): void {
  activationCodeAttempts.delete(key);
}

// 折扣码：每用户每 IP 10 分钟内 20 次失败就锁 10 分钟，防止拿接口枚举折扣码。
export function discountCodeRateLimitKey(request: NextRequest, userId: string): string {
  return `${clientIpFromRequest(request)}:${userId}`;
}

export function assertDiscountCodeAttemptAllowed(key: string): void {
  cleanupExpiredAttempts();
  const state = discountCodeAttempts.get(key);
  if (state && state.blockedUntil > now()) {
    throw new AuthError("折扣码尝试次数过多，请稍后再试", 429);
  }
}

export function recordDiscountCodeFailure(key: string): void {
  recordAttemptFailure(discountCodeAttempts, key, discountCodeWindowMs, discountCodeBlockMs, discountCodeMaxFailures);
}

export function clearDiscountCodeFailures(key: string): void {
  discountCodeAttempts.delete(key);
}

function recordAttemptFailure(
  store: Map<string, LoginAttemptState>,
  key: string,
  attemptWindowMs: number,
  attemptBlockMs: number,
  attemptMaxFailures: number,
): void {
  const currentTime = now();
  const existing = store.get(key);
  const state = existing && currentTime - existing.firstAttemptAt <= attemptWindowMs
    ? existing
    : { count: 0, firstAttemptAt: currentTime, blockedUntil: 0 };

  state.count += 1;
  if (state.count >= attemptMaxFailures) {
    state.blockedUntil = currentTime + attemptBlockMs;
  }
  store.set(key, state);
}

/* ---------------------------------------------------------------------------
 * 开放 API：每把密钥 60 请求/分钟的内存令牌桶。
 * 桶状态只在本进程内存里，多实例部署时是「每实例 60/分钟」，够挡住脚本刷量。
 * ------------------------------------------------------------------------- */

const apiKeyBuckets = new Map<string, TokenBucketState>();
const apiKeyBucketIdleMs = 5 * 60 * 1000;

function cleanupIdleApiKeyBuckets(currentTime: number): void {
  if (apiKeyBuckets.size < 1000) {
    return;
  }
  for (const [key, state] of apiKeyBuckets.entries()) {
    if (currentTime - state.updatedAtMs > apiKeyBucketIdleMs) {
      apiKeyBuckets.delete(key);
    }
  }
}

export function acquireApiKeyToken(keyId: string, currentTime = now()): { allowed: boolean; retryAfterSeconds: number } {
  cleanupIdleApiKeyBuckets(currentTime);
  const result = consumeToken(apiKeyBuckets.get(keyId), apiKeyRateLimit, currentTime);
  apiKeyBuckets.set(keyId, result.state);
  return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
}

export function assertApiKeyRateLimit(keyId: string): void {
  const result = acquireApiKeyToken(keyId);
  if (!result.allowed) {
    throw rateLimitedError(
      `请求过于频繁，每把密钥限 ${apiKeyRateLimit.capacity} 次/分钟，请 ${result.retryAfterSeconds} 秒后重试`,
      result.retryAfterSeconds,
    );
  }
}

/** 仅供测试重置进程内的桶状态。 */
export function resetApiKeyRateLimit(): void {
  apiKeyBuckets.clear();
}
