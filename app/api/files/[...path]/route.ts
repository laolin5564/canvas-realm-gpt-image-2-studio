import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { getGeneratedImageByFilePath, getSourceImageByFilePath } from "@/lib/db";
import { handleRouteError, jsonError } from "@/lib/http";
import { assertGeneratedImageAccess, assertSourceImageAccess } from "@/lib/permissions";
import { readStorageFile, thumbnailPathFor } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  try {
    const user = requireUser(request);
    const { path } = await context.params;
    const relativePath = path.map(decodeURIComponent).join("/");
    const generated = getGeneratedImageByFilePath(relativePath);
    const source = generated ? null : getSourceImageByFilePath(relativePath);
    if (generated) {
      assertGeneratedImageAccess(user, generated);
    } else if (source) {
      assertSourceImageAccess(user, source);
    } else {
      return jsonError("图片不存在", 404);
    }

    const wantsThumbnail = request.nextUrl.searchParams.get("thumb") === "1";
    const file = wantsThumbnail
      ? await readStorageFile(thumbnailPathFor(relativePath)).catch(() => readStorageFile(relativePath))
      : await readStorageFile(relativePath);
    const body = file.bytes.buffer.slice(
      file.bytes.byteOffset,
      file.bytes.byteOffset + file.bytes.byteLength,
    ) as ArrayBuffer;

    return new Response(body, {
      headers: {
        "Content-Type": file.mimeType,
        // private：仅允许浏览器本地缓存。public 会让 Cloudflare 等共享缓存把鉴权后的
        // 图片缓存在边缘，任何拿到 URL 的人都能绕过登录读取（2026-08-31 实测确认过）。
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "图片路径不合法") {
      return jsonError("图片路径不合法", 400);
    }
    return handleRouteError(error);
  }
}
