import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { listDiscountRedemptions } from "@/lib/db";
import { handleRouteError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireAdmin(request);
    const { id } = await context.params;
    return NextResponse.json({ redemptions: listDiscountRedemptions(id) });
  } catch (error) {
    return handleRouteError(error);
  }
}
