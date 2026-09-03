import { NextRequest, NextResponse } from "next/server";
import { apiError, withApiHandler, type ApiRouteContext } from "@/lib/api-v1";
import { requireUser } from "@/lib/auth";
import { getUserApiKey, revokeUserApiKey } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = withApiHandler<{ id: string }>(
  async (request: NextRequest, context: ApiRouteContext<{ id: string }>) => {
    const user = requireUser(request);
    const { id } = await context.params;

    const key = getUserApiKey(id);
    // 别人的密钥一律当作不存在，避免拿接口枚举 id。
    if (!key || key.user_id !== user.id) {
      throw apiError("not_found", "密钥不存在");
    }

    revokeUserApiKey(id);
    return NextResponse.json({ ok: true });
  },
);
