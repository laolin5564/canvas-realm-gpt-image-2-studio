import { NextRequest, NextResponse } from "next/server";
import { createUserSession, setSessionCookie } from "@/lib/auth";
import { toPublicUser, upsertExternalUser } from "@/lib/db";
import { handleRouteError, jsonError } from "@/lib/http";
import { loginLaolinyunUser } from "@/lib/laolinyun-auth";
import {
  assertLoginAllowed,
  clearLoginFailures,
  clientIpFromRequest,
  loginRateLimitKey,
  recordLoginFailure,
} from "@/lib/rate-limit";
import { loginSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const input = loginSchema.parse(await request.json());
    const rateLimitKey = loginRateLimitKey(request, input.name);
    assertLoginAllowed(rateLimitKey);

    const externalUser = await loginLaolinyunUser(input, { clientIp: clientIpFromRequest(request) }).catch((error: unknown) => {
      recordLoginFailure(rateLimitKey);
      throw error;
    });
    const user = upsertExternalUser({
      externalId: externalUser.externalId,
      displayName: externalUser.displayName,
    });
    if (user.status === "disabled") {
      recordLoginFailure(rateLimitKey);
      return jsonError("账号已被禁用，请联系管理员", 403);
    }
    clearLoginFailures(rateLimitKey);

    const { token } = createUserSession(user.id);
    const response = NextResponse.json({ user: toPublicUser(user) });
    setSessionCookie(response, token);
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
