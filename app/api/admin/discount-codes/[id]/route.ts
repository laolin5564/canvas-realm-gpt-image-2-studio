import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { disableDiscountCode, toPublicDiscountCode, updateDiscountCode } from "@/lib/db";
import { handleRouteError } from "@/lib/http";
import { updateDiscountCodeSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireAdmin(request);
    const { id } = await context.params;
    const input = updateDiscountCodeSchema.parse(await request.json().catch(() => ({})));
    const code = updateDiscountCode(id, input);
    return NextResponse.json({ code: toPublicDiscountCode(code) });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** 软删：置为 disabled，历史核销记录保留。 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireAdmin(request);
    const { id } = await context.params;
    disableDiscountCode(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
