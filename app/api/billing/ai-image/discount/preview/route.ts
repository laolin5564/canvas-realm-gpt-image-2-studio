import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { resolveDiscountForPurchase } from "@/lib/db";
import { handleRouteError, jsonError } from "@/lib/http";
import {
  assertDiscountCodeAttemptAllowed,
  clearDiscountCodeFailures,
  discountCodeRateLimitKey,
  recordDiscountCodeFailure,
} from "@/lib/rate-limit";
import { previewDiscountSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 折扣码试算：只读，不下单、不占名额。
 * 校验全部在服务端，前端拿到的只有可公开的价格与文案。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    const rateLimitKey = discountCodeRateLimitKey(request, user.id);
    assertDiscountCodeAttemptAllowed(rateLimitKey);

    const input = previewDiscountSchema.parse(await request.json().catch(() => ({})));
    const resolved = resolveDiscountForPurchase({
      userId: user.id,
      code: input.discountCode,
      unitCount: input.unitCount,
    });
    if (!resolved.ok) {
      recordDiscountCodeFailure(rateLimitKey);
      return jsonError(resolved.error, 400);
    }

    clearDiscountCodeFailures(rateLimitKey);
    return NextResponse.json({ ok: true, preview: resolved.preview });
  } catch (error) {
    return handleRouteError(error);
  }
}
