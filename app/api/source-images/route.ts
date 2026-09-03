import { NextRequest, NextResponse } from "next/server";
import { imagePublicUrl } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handleRouteError, jsonError } from "@/lib/http";
import { storeSourceImage } from "@/lib/source-image-store";
import { contentLengthExceeds, prepareSourceImage, sourceImageTooLargeMessage } from "@/lib/source-image-upload";
import { maxSourceImageUploadBytes } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    // 读 body 之前先按 Content-Length 拦：formData() 会把整个请求缓冲进内存。
    if (contentLengthExceeds(request.headers.get("content-length"), maxSourceImageUploadBytes)) {
      return jsonError(sourceImageTooLargeMessage, 413);
    }
    const formData = await request.formData();
    const value = formData.get("image");

    if (!(value instanceof File)) {
      return jsonError("请上传参考图", 400);
    }

    // 上限 → 魔数 → 归一化（转正 / 缩放 / 压缩，避免大图一路带到图生图请求里撞网关 body 上限）。
    const prepared = await prepareSourceImage({
      bytes: new Uint8Array(await value.arrayBuffer()),
      mimeType: value.type || null,
      originalName: value.name,
    });
    const source = await storeSourceImage(user.id, prepared);

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
