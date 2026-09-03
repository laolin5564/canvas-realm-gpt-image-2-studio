import { NextRequest, NextResponse } from "next/server";
import { createId, createSourceImage, imagePublicUrl } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { handleRouteError, jsonError } from "@/lib/http";
import { normalizeSourceImage } from "@/lib/source-image-normalize";
import { assertSupportedImageBytes, saveSourceImageFile } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    const formData = await request.formData();
    const value = formData.get("image");

    if (!(value instanceof File)) {
      return jsonError("请上传参考图", 400);
    }

    const bytes = new Uint8Array(await value.arrayBuffer());
    if (bytes.length > appConfig.sourceImageMaxUploadBytes) {
      return jsonError(`图片超过 ${uploadLimitLabel(appConfig.sourceImageMaxUploadBytes)}，请压缩后再上传`, 413);
    }
    assertSupportedImageBytes(bytes, value.type);
    // 落盘前转正 / 缩放 / 压缩，避免大图一路带到图生图请求里撞网关 body 上限。
    const normalized = await normalizeSourceImage(bytes, value.type, {
      maxDimension: appConfig.sourceImageMaxDimension,
      targetBytes: appConfig.sourceImageTargetBytes,
    });
    const sourceId = createId("src");
    const filePath = await saveSourceImageFile({
      sourceId,
      fileName: value.name,
      bytes: normalized.bytes,
      mimeType: normalized.mimeType,
    });

    const source = createSourceImage({
      userId: user.id,
      filePath,
      width: normalized.width,
      height: normalized.height,
      originalName: value.name,
      mimeType: normalized.mimeType,
    });

    return NextResponse.json(
      {
        imageId: source.id,
        url: imagePublicUrl(source.file_path),
      },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

function uploadLimitLabel(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
