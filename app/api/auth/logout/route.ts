import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, logoutRequest } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    logoutRequest(request);
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response, request.headers.get("host"));
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
