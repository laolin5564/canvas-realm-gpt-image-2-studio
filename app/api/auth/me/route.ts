import { NextRequest, NextResponse } from "next/server";
import { getRequestUser, withUserQuota } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // 顶栏要显示「已用/额度」，这是少数真的需要月度用量的接口，在这里显式补上。
    const user = getRequestUser(request);
    return NextResponse.json({ user: user ? withUserQuota(user) : null });
  } catch (error) {
    return handleRouteError(error);
  }
}
