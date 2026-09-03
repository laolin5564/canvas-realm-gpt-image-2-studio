import { NextRequest } from "next/server";
import { apiError, readJsonBody, withApiHandler } from "@/lib/api-v1";
import {
  assertApiActiveTaskLimit,
  assertApiQuota,
  authenticateApiRequest,
  decodeBase64Image,
  finalizeApiGeneration,
  saveApiSourceImages,
} from "@/lib/api-v1-server";
import { createGenerationTask, getTemplate } from "@/lib/db";
import { assertTemplateReadAccess } from "@/lib/permissions";
import { contentLengthExceeds, sourceImageTooLargeMessage } from "@/lib/source-image-upload";
import { apiV1EditSchema, maxReferenceImageCount, maxSourceImageUploadBytes } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface PendingImage {
  bytes: Uint8Array;
  mimeType: string | null;
  originalName: string | null;
}

const textFields = [
  "prompt",
  "negative_prompt",
  "size",
  "quality",
  "n",
  "template_id",
  "wait",
  "response_format",
] as const;

async function readMultipart(request: NextRequest): Promise<{ raw: Record<string, unknown>; images: PendingImage[] }> {
  const form = await request.formData();
  const raw: Record<string, unknown> = {};
  for (const field of textFields) {
    const value = form.get(field);
    if (typeof value === "string") {
      raw[field] = value;
    }
  }

  const files = form.getAll("image").filter((value): value is File => value instanceof File);
  const images: PendingImage[] = [];
  for (const file of files) {
    images.push({
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type || null,
      originalName: file.name || null,
    });
  }
  return { raw, images };
}

export const POST = withApiHandler(async (request: NextRequest) => {
  const { user } = authenticateApiRequest(request);
  const contentType = request.headers.get("content-type") ?? "";
  const isMultipart = contentType.toLowerCase().includes("multipart/form-data");

  // 读 body 之前先按 Content-Length 拦：formData() / json() 会把整个请求缓冲进内存。
  // 上限 = 最多 4 张 × 单张 30MB（JSON 里 base64 再放大 4/3）。
  const maxBodyBytes = maxReferenceImageCount * maxSourceImageUploadBytes * (isMultipart ? 1 : 4 / 3);
  if (contentLengthExceeds(request.headers.get("content-length"), maxBodyBytes)) {
    throw apiError("validation_error", `请求体过大：${sourceImageTooLargeMessage}`);
  }

  const { raw, images } = isMultipart
    ? await readMultipart(request)
    : { raw: (await readJsonBody(request)) as Record<string, unknown>, images: [] as PendingImage[] };

  const body = apiV1EditSchema.parse(raw ?? {});
  // 两种传图方式二选一：multipart 的 image 文件，或 JSON body 里的 image_base64。
  const pending = isMultipart ? images : (body.image_base64 ?? []).map((value) => decodeBase64Image(value)).map((decoded) => ({
    bytes: decoded.bytes,
    mimeType: decoded.mimeType,
    originalName: null,
  }));

  if (pending.length === 0) {
    throw apiError("validation_error", isMultipart ? "请至少上传 1 张 image 文件" : "请提供 image_base64 数组");
  }
  if (pending.length > maxReferenceImageCount) {
    throw apiError("validation_error", `参考图最多 ${maxReferenceImageCount} 张`);
  }

  if (body.template_id) {
    const template = getTemplate(body.template_id);
    if (!template) {
      throw apiError("not_found", "模板不存在");
    }
    assertTemplateReadAccess(user, template);
  }

  assertApiActiveTaskLimit(user.id);
  assertApiQuota(user, body.n);

  // 先过完限流与额度再落盘，避免被拒的请求还占磁盘；多张图先全部校验 + 归一化再统一落盘。
  const imageIds = await saveApiSourceImages(user.id, pending);

  // 第一张为主图，其余作为额外参考图，与站内工作台的语义保持一致。
  const referenceImageIds = imageIds.slice(1);
  const task = createGenerationTask({
    userId: user.id,
    mode: "image_to_image",
    prompt: body.prompt,
    negativePrompt: body.negative_prompt,
    size: body.size,
    quality: body.quality,
    quantity: body.n,
    templateId: body.template_id,
    sourceImageId: imageIds[0],
    referenceImageId: referenceImageIds[0] ?? null,
    referenceImageIds,
    referenceStrength: 0.65,
    styleStrength: 0.7,
    source: "api",
  });

  return finalizeApiGeneration({
    request,
    task,
    wait: body.wait,
    responseFormat: body.response_format,
  });
});
