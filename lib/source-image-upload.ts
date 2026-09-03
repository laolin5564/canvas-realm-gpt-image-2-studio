import { appConfig } from "./config";
import { Semaphore } from "./concurrency";
import { normalizeSourceImage, type NormalizedSourceImage } from "./source-image-normalize";
import { assertSupportedImageBytes, ImageValidationError } from "./storage";
import { maxSourceImageUploadBytes } from "./validation";

/**
 * 参考图上传两条入口（web `/api/source-images` 与开放 API `/api/v1/images/edits`）共用的前半段：
 * 上限校验 → 魔数校验 → 归一化。落盘与建记录在 lib/source-image-store.ts（依赖 lib/db，拆开是为了
 * 让这里能在 bun test 里直接测）。
 */

/** 单张参考图原始上限固定 30MB：与前端预检同一常量，不走环境变量。 */
export const sourceImageTooLargeMessage = `单张参考图不能超过 ${Math.round(maxSourceImageUploadBytes / (1024 * 1024))} MB，请压缩后再上传`;

/** 超过 30MB 的图：web 路由用 413，开放 API 由调用方收敛成 validation_error。 */
export class SourceImageTooLargeError extends ImageValidationError {
  status = 413;

  constructor() {
    super(sourceImageTooLargeMessage);
    this.name = "SourceImageTooLargeError";
  }
}

/** Content-Length 预检的余量：multipart 边界、字段名与其他文本字段。 */
export const sourceImageUploadHeadroom = 1.05;

/**
 * 读 body 之前先看 Content-Length：`request.formData()` 会把整个请求读进内存，绕过前端预检的脚本
 * 发 500MB 也得先吃满内存才拿到 413。没有 Content-Length（chunked）的请求放行走现有路径。
 */
export function contentLengthExceeds(header: string | null | undefined, limitBytes: number): boolean {
  if (!header) {
    return false;
  }
  const parsed = Number(header.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return false;
  }
  return parsed > Math.ceil(limitBytes * sourceImageUploadHeadroom);
}

/** 只有 PNG / JPEG / WEBP 会被识别，其余返回 null 交给后面的类型校验报错。 */
export function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** 同一进程最多同时归一化几张图：一张 2048² 的中间缓冲就是十几 MB，工作台一次并行上传 4 张再叠几个用户就会打爆 NAS。 */
export const sourceImageNormalizeMaxInflight = 2;

let normalizeSemaphore: Semaphore | null = null;

export function sourceImageNormalizeSemaphore(): Semaphore {
  if (!normalizeSemaphore) {
    normalizeSemaphore = new Semaphore(sourceImageNormalizeMaxInflight);
  }
  return normalizeSemaphore;
}

export function withSourceImageNormalizeSlot<T>(operation: () => Promise<T>): Promise<T> {
  return sourceImageNormalizeSemaphore().run(operation);
}

export interface PreparedSourceImage extends NormalizedSourceImage {
  originalName: string | null;
}

/**
 * 校验 + 归一化一张待上传的参考图；不落盘。
 * 抛 ImageValidationError（含 SourceImageTooLargeError）表示用户的图有问题，其余异常是服务端故障。
 * 归一化排队在信号量上（同步拿槽位，调用瞬间就能从 semaphore 上看到 active/pending）。
 */
export function prepareSourceImage(input: {
  bytes: Uint8Array;
  mimeType: string | null;
  originalName: string | null;
}): Promise<PreparedSourceImage> {
  if (input.bytes.length === 0) {
    return Promise.reject(new ImageValidationError("参考图内容为空"));
  }
  if (input.bytes.length > maxSourceImageUploadBytes) {
    return Promise.reject(new SourceImageTooLargeError());
  }
  const mimeType = input.mimeType || detectImageMime(input.bytes);
  try {
    assertSupportedImageBytes(input.bytes, mimeType);
  } catch (error) {
    return Promise.reject(error);
  }

  return withSourceImageNormalizeSlot(async () => {
    const normalized = await normalizeSourceImage(input.bytes, mimeType, {
      maxDimension: appConfig.sourceImageMaxDimension,
      targetBytes: appConfig.sourceImageTargetBytes,
    });
    return { ...normalized, originalName: input.originalName };
  });
}
