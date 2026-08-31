import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  countUsers,
  createSession,
  deleteSessionByTokenHash,
  getDefaultGroup,
  getRegistrationSettings,
  getSessionByTokenHash,
  getUserById,
  toPublicUser,
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

export function requireAdmin(request: NextRequest): CurrentUser {
  const user = requireUser(request);
  if (user.role !== "admin") {
    throw new AuthError("需要管理员权限", 403);
  }
  return user;
}

export function toCurrentUser(user: UserRow): CurrentUser {
  const publicUser = toPublicUser(user);
  return {
    id: publicUser.id,
    email: publicUser.email,
    externalId: publicUser.externalId,
    name: publicUser.name,
    role: publicUser.role,
    groupId: publicUser.groupId,
    groupName: publicUser.groupName,
    monthlyQuota: publicUser.monthlyQuota,
    monthUsed: publicUser.monthUsed,
  };
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
