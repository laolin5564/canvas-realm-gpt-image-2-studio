import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { createDiscountCode, listDiscountCodes, toPublicDiscountCode } from "@/lib/db";
import { handleRouteError } from "@/lib/http";
import { upsertDiscountCodeSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(request);
    const codes = listDiscountCodes().map(toPublicDiscountCode);
    return NextResponse.json({ codes });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(request);
    const input = upsertDiscountCodeSchema.parse(await request.json().catch(() => ({})));
    const code = createDiscountCode(input);
    return NextResponse.json({ code: toPublicDiscountCode(code) }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
