import { NextRequest, NextResponse } from "next/server";
import { deductUserAiImageCredits } from "@/lib/db";
import { handleRouteError, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = readString(request.nextUrl.searchParams.get("user"));
    const num = readInteger(request.nextUrl.searchParams.get("num"));
    if (!user) {
      return jsonError("扣减用户不能为空", 400);
    }
    if (num <= 0) {
      return jsonError("扣减次数必须大于0", 400);
    }

    const result = deductUserAiImageCredits({
      user,
      creditCount: num,
      source: "laolinyun_activation_destroy",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return handleRouteError(error);
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}
