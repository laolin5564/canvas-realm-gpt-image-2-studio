import { NextRequest, NextResponse } from "next/server";
import { listConversations, toPublicConversation } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 30);
    // 工作台左栏一律只列自己的会话：管理员想看别人的内容走管理后台，而不是混进自己的工作台。
    const conversations = listConversations({
      userId: user.id,
      isAdmin: false,
      limit,
    }).map((conversation) => toPublicConversation(conversation));
    return NextResponse.json({ conversations });
  } catch (error) {
    return handleRouteError(error);
  }
}
