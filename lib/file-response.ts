import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { mimeFromFileName, resolveStoragePath, thumbnailPathFor } from "./storage";

// private：仅允许浏览器本地缓存。public 会让 Cloudflare 等共享缓存把鉴权后的
// 图片缓存在边缘，任何拿到 URL 的人都能绕过登录读取（2026-08-31 实测确认过）。
export const imageCacheControl = "private, max-age=31536000, immutable";

// 落盘后的图片文件不会被改写，只会被整体删除，所以 ETag 用路径的稳定 hash 就够了。
export function etagForPath(relativePath: string): string {
  return `"${createHash("sha256").update(relativePath).digest("hex").slice(0, 32)}"`;
}

export function etagMatches(header: string | null, etag: string): boolean {
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

/**
 * 按相对路径流式返回图片（带 ETag / 304）；文件不存在时返回 null，由调用方决定错误体。
 * ?thumb=1 先找缩略图，没有再回退原图。
 */
export async function streamStorageFile(input: {
  relativePath: string;
  wantsThumbnail: boolean;
  ifNoneMatch: string | null;
}): Promise<Response | null> {
  const candidates = input.wantsThumbnail
    ? [thumbnailPathFor(input.relativePath), input.relativePath]
    : [input.relativePath];

  let target: { relativePath: string; absolutePath: string; size: number } | null = null;
  for (const candidate of candidates) {
    target = await resolveReadableFile(candidate);
    if (target) {
      break;
    }
  }
  if (!target) {
    return null;
  }

  const etag = etagForPath(target.relativePath);
  const baseHeaders: Record<string, string> = {
    ETag: etag,
    "Cache-Control": imageCacheControl,
    "X-Content-Type-Options": "nosniff",
  };

  if (etagMatches(input.ifNoneMatch, etag)) {
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
}
