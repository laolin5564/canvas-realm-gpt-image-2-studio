import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { hashApiKeySecret, isApiKeySecret, parseBearerToken } from "./api-keys";
import { apiError } from "./api-v1";
import {
  countUsers,
  createSession,
  deleteSessionByTokenHash,
  getActiveUserApiKeyByHash,
  getDefaultGroup,
  getRegistrationSettings,
  getSessionByTokenHash,
  getUserById,
  getUserGroup,
  getUserQuota,
  isApiEnabled,
  recordUserApiKeyUsage,
} from "./db";
import type { CurrentUser, UserRow } from "./types";

export const sessionCookieName = "image_gen_session";

const sessionDurationMs = 1000 * 60 * 60 * 24 * 14;
const passwordKeyLength = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, passwordKeyLength).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, salt, hash] = stored.split(":");
  if (algorithm !== "scrypt" || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function createSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function sessionExpiresAt(): string {
  return new Date(Date.now() + sessionDurationMs).toISOString();
}

function shouldUseSecureCookie(): boolean {
  const explicit = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (explicit === "true") {
    return true;
  }
  if (explicit === "false") {
    return false;
  }
  return process.env.APP_BASE_URL?.startsWith("https://") ?? false;
}

export function cookieDomainForHost(requestHost: string | null | undefined): string | undefined {
  const configured = process.env.SESSION_COOKIE_DOMAIN?.trim();
  if (!configured) {
    return undefined;
  }
  const host = (requestHost ?? "").split(":")[0].trim().toLowerCase();
  const domain = configured.toLowerCase();
  const bare = domain.startsWith(".") ? domain.slice(1) : domain;
  // 只有当请求域名属于配置域时才下发 Domain 属性（让 cookie 覆盖 imgd 等兄弟子域）；
  // 从 m.laolin.me 等其他入口访问时保持 host-only，避免浏览器因域不匹配拒收 cookie。
  if (host === bare || host.endsWith(`.${bare}`)) {
    return domain.startsWith(".") ? domain : `.${domain}`;
  }
  return undefined;
}

export function setSessionCookie(response: NextResponse, token: string, requestHost?: string | null): void {
  response.cookies.set(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: Math.floor(sessionDurationMs / 1000),
    ...(cookieDomainForHost(requestHost) ? { domain: cookieDomainForHost(requestHost) } : {}),
  });
}

export function clearSessionCookie(response: NextResponse, requestHost?: string | null): void {
  response.cookies.set(sessionCookieName, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: 0,
    ...(cookieDomainForHost(requestHost) ? { domain: cookieDomainForHost(requestHost) } : {}),
  });
}

export function createUserSession(userId: string): { token: string } {
  const token = createSessionToken();
  createSession({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: sessionExpiresAt(),
  });
  return { token };
}

export function getRequestUser(request: NextRequest): CurrentUser | null {
  const token = request.cookies.get(sessionCookieName)?.value;
  if (!token) {
    return null;
  }

  const session = getSessionByTokenHash(hashSessionToken(token));
  if (!session) {
    return null;
  }

  const user = getUserById(session.user_id);
  if (!user || user.status === "disabled") {
    return null;
  }
  return toCurrentUser(user);
}

export function logoutRequest(request: NextRequest): void {
  const token = request.cookies.get(sessionCookieName)?.value;
  if (token) {
    deleteSessionByTokenHash(hashSessionToken(token));
  }
}

export function requireUser(request: NextRequest): CurrentUser {
  const user = getRequestUser(request);
  if (!user) {
    throw new AuthError("请先登录", 401);
  }
  return user;
}

export interface ApiKeyPrincipal {
  user: CurrentUser;
  keyId: string;
}

/**
 * last_used_at / request_count 每把密钥最多一分钟写一次库，
 * 间隔内的调用先在内存里攒着，下次落盘时一起加上，避免每请求一次写。
 */
const apiKeyUsageFlushIntervalMs = 60_000;
const apiKeyUsageBuffer = new Map<string, { pending: number; flushedAt: number }>();

function recordApiKeyUsageThrottled(keyId: string, nowMs = Date.now()): void {
  const buffered = apiKeyUsageBuffer.get(keyId);
  const pending = (buffered?.pending ?? 0) + 1;
  if (buffered && nowMs - buffered.flushedAt < apiKeyUsageFlushIntervalMs) {
    apiKeyUsageBuffer.set(keyId, { pending, flushedAt: buffered.flushedAt });
    return;
  }

  apiKeyUsageBuffer.set(keyId, { pending: 0, flushedAt: nowMs });
  try {
    recordUserApiKeyUsage(keyId, pending);
  } catch {
    // 用量统计写失败不该拖垮整个调用。
  }
}

/** 站点设置里的开放 API 总开关；关掉之后 /api/v1 与密钥创建一律 403 api_disabled。 */
export function assertApiEnabled(): void {
  if (!isApiEnabled()) {
    throw apiError("api_disabled", "站点已关闭开放 API，请联系管理员开启");
  }
}

/** Bearer 密钥鉴权：解析 → sha256 → 查有效密钥 → 用户仍启用 → 记一次用量。 */
export function requireApiKeyUser(request: NextRequest): ApiKeyPrincipal {
  const token = parseBearerToken(request.headers.get("authorization"));
  if (!token || !isApiKeySecret(token)) {
    throw apiError("unauthorized", "缺少或无效的 API 密钥，请在 Authorization 头里带上 Bearer hj_...");
  }

  const key = getActiveUserApiKeyByHash(hashApiKeySecret(token));
  if (!key) {
    throw apiError("unauthorized", "API 密钥无效或已撤销");
  }

  const user = getUserById(key.user_id);
  if (!user || user.status === "disabled") {
    throw apiError("unauthorized", "API 密钥对应的账号已被禁用");
  }

  recordApiKeyUsageThrottled(key.id);
  return { user: toCurrentUser(user), keyId: key.id };
}

export function requireAdmin(request: NextRequest): CurrentUser {
  const user = requireUser(request);
  if (user.role !== "admin") {
    throw new AuthError("需要管理员权限", 403);
  }
  return user;
}

/**
 * 只做身份，不做账务。
 * 之前这里走 toPublicUser()，等于每个带鉴权的请求都要对 generation_tasks 做一次
 * 当月聚合；用量改由需要展示额度的地方（/api/auth/me）显式调 withUserQuota 补。
 */
export function toCurrentUser(user: UserRow): CurrentUser {
  const group = user.group_id ? getUserGroup(user.group_id) : null;
  return {
    id: user.id,
    email: user.email,
    externalId: user.external_id,
    name: user.name,
    role: user.role,
    groupId: user.group_id,
    groupName: group?.name ?? null,
  };
}

/** 给 CurrentUser 补上当月用量与限额（会跑一次月度聚合，只在真正要展示额度时调）。 */
export function withUserQuota(user: CurrentUser): CurrentUser {
  const quota = getUserQuota(user.id);
  return { ...user, monthlyQuota: quota.monthlyQuota, monthUsed: quota.monthUsed };
}

export function nextUserRoleForRegistration(): "admin" | "member" {
  return countUsers() === 0 ? "admin" : "member";
}

export function defaultGroupIdForRegistration(): string {
  return getRegistrationSettings().registrationDefaultGroupId || getDefaultGroup().id;
}

export function isRegistrationOpen(): boolean {
  return getRegistrationSettings().registrationEnabled || countUsers() === 0;
}

export class AuthError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
