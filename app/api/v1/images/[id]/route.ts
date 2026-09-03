import { NextRequest } from "next/server";
import { apiError, withApiHandler, type ApiRouteContext } from "@/lib/api-v1";
import { authenticateApiRequest } from "@/lib/api-v1-server";
import { getGeneratedImage, getGenerationTask } from "@/lib/db";
import { streamStorageFile } from "@/lib/file-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bearer 鉴权下载出图原文件；流式与 ETag 与 /api/files 完全一致。 */
export const GET = withApiHandler<{ id: string }>(
  async (request: NextRequest, context: ApiRouteContext<{ id: string }>) => {
    const { user } = authenticateApiRequest(request);
    const { id } = await context.params;

    const image = getGeneratedImage(id);
    const task = image ? getGenerationTask(image.task_id) : null;
    // 别人的图一律当作不存在，避免被拿来枚举图片 id。
    if (!image || !task || task.user_id !== user.id) {
      throw apiError("not_found", "图片不存在");
    }

    const response = await streamStorageFile({
      relativePath: image.file_path,
      wantsThumbnail: request.nextUrl.searchParams.get("thumb") === "1",
      ifNoneMatch: request.headers.get("if-none-match"),
    });
    if (!response) {
      throw apiError("not_found", "图片文件已不存在");
    }
    return response;
  },
);
