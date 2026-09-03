import { NextRequest, NextResponse } from "next/server";
import { withApiHandler, type ApiRouteContext } from "@/lib/api-v1";
import {
  apiTaskPayload,
  authenticateApiRequest,
  createImageUrlBuilder,
  requireOwnApiTask,
} from "@/lib/api-v1-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiHandler<{ id: string }>(
  async (request: NextRequest, context: ApiRouteContext<{ id: string }>) => {
    const { user } = authenticateApiRequest(request);
    const { id } = await context.params;
    const task = requireOwnApiTask(user.id, id);
    return NextResponse.json({ task: apiTaskPayload(task, createImageUrlBuilder(request)) });
  },
);
