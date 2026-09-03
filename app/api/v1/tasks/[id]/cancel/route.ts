import { NextRequest, NextResponse } from "next/server";
import { apiError, withApiHandler, type ApiRouteContext } from "@/lib/api-v1";
import {
  apiTaskPayload,
  authenticateApiRequest,
  createImageUrlBuilder,
  requireOwnApiTask,
} from "@/lib/api-v1-server";
import { cancelGenerationTask } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApiHandler<{ id: string }>(
  async (request: NextRequest, context: ApiRouteContext<{ id: string }>) => {
    const { user } = authenticateApiRequest(request);
    const { id } = await context.params;
    requireOwnApiTask(user.id, id);

    // 取消语义与站内一致：落到 failed + progress_stage=canceled，已出的图保留并照常计费。
    const canceled = cancelGenerationTask(id);
    if (!canceled) {
      throw apiError("not_found", "任务不存在");
    }
    return NextResponse.json({ task: apiTaskPayload(canceled, createImageUrlBuilder(request)) });
  },
);
