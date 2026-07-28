import { NextRequest, NextResponse } from "next/server";
import { createUserSession, isRegistrationOpen, setSessionCookie } from "@/lib/auth";
import { toPublicUser, upsertExternalUser } from "@/lib/db";
import { handleRouteError, jsonError } from "@/lib/http";
import { getLaolinyunLoginQrCode, getLaolinyunLoginQrStatus } from "@/lib/laolinyun-auth";
import { clientIpFromRequest } from "@/lib/rate-limit";
import { qrLoginStatusSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    if (!isRegistrationOpen()) {
      return jsonError("当前站点暂未开放扫码注册，请使用已有账号登录", 403);
    }

    const qrCode = await getLaolinyunLoginQrCode({ clientIp: clientIpFromRequest(request) });
    return NextResponse.json(qrCode);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const input = qrLoginStatusSchema.parse(await request.json());
    const status = await getLaolinyunLoginQrStatus(input.webCode, { clientIp: clientIpFromRequest(request) });

    if (!status.login || !status.user) {
      return NextResponse.json({ login: false, state: status.state });
    }

    const user = upsertExternalUser({
      externalId: status.user.externalId,
      displayName: status.user.displayName,
    });
    if (user.status === "disabled") {
      return jsonError("账号已被禁用，请联系管理员", 403);
    }

    const { token } = createUserSession(user.id);
    const response = NextResponse.json({ login: true, state: status.state, user: toPublicUser(user) });
    setSessionCookie(response, token);
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
