import { NextRequest, NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api-v1";
import { authenticateApiRequest } from "@/lib/api-v1-server";
import { getUserQuota } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiHandler(async (request: NextRequest) => {
  const { user } = authenticateApiRequest(request);
  const quota = getUserQuota(user.id);
  return NextResponse.json({
    user: { id: user.id, name: user.name },
    quota: {
      monthlyQuota: quota.monthlyQuota,
      monthUsed: quota.monthUsed,
      remaining: quota.monthlyQuota === null ? null : Math.max(quota.monthlyQuota - quota.monthUsed, 0),
    },
  });
});
