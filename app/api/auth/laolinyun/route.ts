import { NextRequest, NextResponse } from "next/server";
import { createUserSession, setSessionCookie } from "@/lib/auth";
import { upsertExternalUser } from "@/lib/db";
import { handleRouteError, jsonError } from "@/lib/http";
import { getLaolinyunUserBySecret } from "@/lib/laolinyun-auth";
import { clientIpFromRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const secret = request.nextUrl.searchParams.get("secret")?.trim() || "";
    const redirectTo = safeRedirectPath(request.nextUrl.searchParams.get("redirect"));
    const externalUser = await getLaolinyunUserBySecret(secret, { clientIp: clientIpFromRequest(request) });
    const user = upsertExternalUser({
      externalId: externalUser.externalId,
      displayName: externalUser.displayName,
    });
    if (user.status === "disabled") {
      return jsonError("账号已被禁用，请联系管理员", 403);
    }
    const { token } = createUserSession(user.id);
    const response = NextResponse.redirect(new URL(redirectTo, getRequestOrigin(request)));
    setSessionCookie(response, token);
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}

function safeRedirectPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

function getRequestOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host") || request.nextUrl.host;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedSsl = request.headers.get("x-forwarded-ssl")?.trim().toLowerCase();
  const proto = forwardedProto || (forwardedSsl === "on" ? "https" : request.nextUrl.protocol.replace(":", ""));
  return `${proto}://${host}`;
}
