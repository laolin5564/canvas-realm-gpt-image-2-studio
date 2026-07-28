import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createAiCreditOrder, getLocalAiImageQuota, grantAiCreditsOnce, markAiCreditOrderPaidAndGrant } from "@/lib/db";
import { handleRouteError, jsonError } from "@/lib/http";
import { createLaolinyunAiImagePaymentOrder, exchangeLaolinyunActivationCode, getLaolinyunOrderStatus } from "@/lib/laolinyun-auth";
import {
  activationCodeRateLimitKey,
  assertActivationCodeExchangeAllowed,
  clearActivationCodeExchangeFailures,
  recordActivationCodeExchangeFailure,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unitSize = 10;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    const orderId = request.nextUrl.searchParams.get("orderId")?.trim();
    if (orderId) {
      if (!user.externalId) {
        return jsonError("当前账号未绑定老林云用户", 403);
      }
      const status = await getLaolinyunOrderStatus(user.externalId, orderId);
      const grant = status.paid ? markAiCreditOrderPaidAndGrant(orderId, user.id) : null;
      return NextResponse.json({ status, quota: grant?.quota ?? getLocalAiImageQuota(user.id), unitSize });
    }
    const quota = getLocalAiImageQuota(user.id);
    return NextResponse.json({ quota, unitSize });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    if (!user.externalId) {
      return jsonError("当前账号未绑定老林云用户", 403);
    }
    const body = await request.json().catch(() => ({})) as { code?: unknown; unitCount?: unknown };
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    if (code) {
      const rateLimitKey = activationCodeRateLimitKey(request, user.id);
      assertActivationCodeExchangeAllowed(rateLimitKey);
      const exchange = await exchangeLaolinyunActivationCode(user.externalId, code).catch((error: unknown) => {
        recordActivationCodeExchangeFailure(rateLimitKey);
        throw error;
      });
      if (exchange.generationCount <= 0) {
        recordActivationCodeExchangeFailure(rateLimitKey);
        return jsonError("激活码兑换成功，但老林云接口未返回AI图片生成次数，无法本地入账", 502);
      }
      clearActivationCodeExchangeFailures(rateLimitKey);
      const { quota } = grantAiCreditsOnce({
        eventKey: `activation:${code}`,
        userId: user.id,
        creditCount: exchange.generationCount,
        source: "laolinyun_activation_code",
      });
      return NextResponse.json({ quota, unitSize, message: "激活码兑换成功，额度已刷新。" });
    }
    const unitCount = Math.max(Number.parseInt(String(body.unitCount ?? "1"), 10) || 1, 1);
    const order = await createLaolinyunAiImagePaymentOrder(user.externalId, unitCount);
    createAiCreditOrder({
      orderId: order.orderId,
      userId: user.id,
      creditCount: order.generationCount,
      totalPriceFen: order.totalPriceFen,
    });
    return NextResponse.json({ order, unitSize });
  } catch (error) {
    return handleRouteError(error);
  }
}
