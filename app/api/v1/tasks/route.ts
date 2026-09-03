import { NextRequest, NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api-v1";
import { apiTaskPayload, authenticateApiRequest, createImageUrlBuilder } from "@/lib/api-v1-server";
import { listApiGenerationTasks } from "@/lib/db";
import { apiV1ListTasksQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiHandler(async (request: NextRequest) => {
  const { user } = authenticateApiRequest(request);
  const query = apiV1ListTasksQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
  const buildImageUrl = createImageUrlBuilder(request);
  const tasks = listApiGenerationTasks(user.id, query.limit).map((task) => apiTaskPayload(task, buildImageUrl));
  return NextResponse.json({ tasks });
});
