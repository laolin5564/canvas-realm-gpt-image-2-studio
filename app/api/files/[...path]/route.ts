import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { getGeneratedImageByFilePath, getSourceImageByFilePath } from "@/lib/db";
import { handleRouteError, jsonError } from "@/lib/http";
import { assertGeneratedImageAccess, assertSourceImageAccess } from "@/lib/permissions";
import { mimeFromFileName, resolveStoragePath, thumbnailPathFor } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// private：仅允许浏览器本地缓存。public 会让 Cloudflare 等共享缓存把鉴权后的
// 图片缓存在边缘，任何拿到 URL 的人都能绕过登录读取（2026-08-31 实测确认过）。
const cacheControl = "private, max-age=31536000, immutable";

// 落盘后的图片文件不会被改写，只会被整体删除，所以 ETag 用路径的稳定 hash 就够了。
function etagForPath(relativePath: string): string {
  return `"${createHash("sha256").update(relativePath).digest("hex").slice(0, 32)}"`;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) {
    return false;
  }
  return header
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag || value.replace(/^W\//, "") === etag);
}

async function resolveReadableFile(
  relativePath: string,
): Promise<{ relativePath: string; absolutePath: string; size: number } | null> {
  const absolutePath = resolveStoragePath(relativePath);
  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile()) {
      return null;
    }
    return { relativePath, absolutePath, size: stats.size };
  } catch {
    return null;
  }
}

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
    const candidates = wantsThumbnail
      ? [thumbnailPathFor(relativePath), relativePath]
      : [relativePath];

    let target: { relativePath: string; absolutePath: string; size: number } | null = null;
    for (const candidate of candidates) {
      target = await resolveReadableFile(candidate);
      if (target) {
        break;
      }
    }
    if (!target) {
      return jsonError("图片不存在", 404);
    }

    const etag = etagForPath(target.relativePath);
    const baseHeaders: Record<string, string> = {
      ETag: etag,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    };

    if (etagMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: baseHeaders });
    }

    // 流式返回：大图不再整份读进内存再拷一次 ArrayBuffer。
    const body = Readable.toWeb(createReadStream(target.absolutePath)) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        ...baseHeaders,
        "Content-Type": mimeFromFileName(target.relativePath),
        "Content-Length": String(target.size),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "图片路径不合法") {
      return jsonError("图片路径不合法", 400);
    }
    return handleRouteError(error);
  }
}
