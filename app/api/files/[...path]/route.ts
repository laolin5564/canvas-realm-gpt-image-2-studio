import { NextRequest } from "next/server";
import { getRequestUser, requireApiKeyUser } from "@/lib/auth";
import { getApiSigningSecret, getGeneratedImageByFilePath, getSourceImageByFilePath } from "@/lib/db";
import { streamStorageFile } from "@/lib/file-response";
import { handleRouteError, jsonError } from "@/lib/http";
import { assertGeneratedImageAccess, assertSourceImageAccess } from "@/lib/permissions";
import { verifyFilePath } from "@/lib/signed-url";
import type { CurrentUser } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** session cookie 或 Bearer 密钥，任意一个成立就算「有身份」。 */
function resolveViewer(request: NextRequest): CurrentUser | null {
  const cookieUser = getRequestUser(request);
  if (cookieUser) {
    return cookieUser;
  }
  if (!request.headers.get("authorization")) {
    return null;
  }
  try {
    return requireApiKeyUser(request).user;
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  try {
    const { path } = await context.params;
    const relativePath = path.map(decodeURIComponent).join("/");
    const searchParams = request.nextUrl.searchParams;

    const viewer = resolveViewer(request);
    // 三选一：cookie、Bearer 密钥、开放 API 下发的签名链接。
    if (!viewer) {
      const signed = verifyFilePath({
        filePath: relativePath,
        sig: searchParams.get("sig"),
        exp: searchParams.get("exp"),
        secret: getApiSigningSecret(),
      });
      if (!signed) {
        return jsonError(searchParams.get("sig") ? "图片访问签名无效或已过期" : "请先登录", 401);
      }
    }

    const generated = getGeneratedImageByFilePath(relativePath);
    const source = generated ? null : getSourceImageByFilePath(relativePath);
    if (!generated && !source) {
      return jsonError("图片不存在", 404);
    }
    if (viewer) {
      if (generated) {
        assertGeneratedImageAccess(viewer, generated);
      } else if (source) {
        assertSourceImageAccess(viewer, source);
      }
    }

    const response = await streamStorageFile({
      relativePath,
      wantsThumbnail: searchParams.get("thumb") === "1",
      ifNoneMatch: request.headers.get("if-none-match"),
    });
    return response ?? jsonError("图片不存在", 404);
  } catch (error) {
    if (error instanceof Error && error.message === "图片路径不合法") {
      return jsonError("图片路径不合法", 400);
    }
    return handleRouteError(error);
  }
}
