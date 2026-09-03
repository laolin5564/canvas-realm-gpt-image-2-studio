import { NextRequest, NextResponse } from "next/server";
import { appConfig } from "./config";
import { assertApiEnabled, requireApiKeyUser, type ApiKeyPrincipal } from "./auth";
import {
  apiError,
  isTerminalTaskStatus,
  resolveRequestOrigin,
  toApiTask,
  waitPollIntervalMs,
  waitTimeoutMs,
  type ApiTask,
} from "./api-v1";
import {
  countActiveApiTasks,
  createId,
  createSourceImage,
  getApiSigningSecret,
  getGenerationTask,
  getTaskImages,
} from "./db";
import { assertQuotaAvailable } from "./permissions";
import { assertApiKeyRateLimit } from "./rate-limit";
import { signedFileUrl, signedUrlExpiry } from "./signed-url";
import { assertSupportedImageBytes, readStorageFile, saveSourceImageFile } from "./storage";
import type { CurrentUser, GeneratedImageRow, GenerationTaskRow } from "./types";

/** 每用户同时最多几个 queued/processing 的 API 任务。 */
export const maxActiveApiTasksPerUser = 5;

/** 每个 /api/v1 请求的固定三步：总开关 → Bearer 鉴权 → 每密钥限流。 */
export function authenticateApiRequest(request: NextRequest): ApiKeyPrincipal {
  assertApiEnabled();
  const principal = requireApiKeyUser(request);
  assertApiKeyRateLimit(principal.keyId);
  return principal;
}

export function assertApiActiveTaskLimit(userId: string): void {
  if (countActiveApiTasks(userId) >= maxActiveApiTasksPerUser) {
    throw apiError(
      "too_many_active_tasks",
      `同时进行中的 API 任务已达上限 ${maxActiveApiTasksPerUser} 个，请等待已有任务完成后再提交`,
    );
  }
}

/** assertQuotaAvailable 抛的是 AuthError(403)，这里转成契约里的 quota_exceeded。 */
export function assertApiQuota(user: CurrentUser, quantity: number): void {
  try {
    assertQuotaAvailable(user, quantity);
  } catch (error) {
    throw apiError("quota_exceeded", error instanceof Error ? error.message : "本月生成额度不足");
  }
}

export type ImageUrlBuilder = (filePath: string, thumb: boolean) => string;

/** 出图链接一律是绝对地址 + 7 天签名，拿到就能直接下载，不需要再带鉴权。 */
export function createImageUrlBuilder(request: NextRequest): ImageUrlBuilder {
  const origin = resolveRequestOrigin(request);
  const secret = getApiSigningSecret();
  const expUnix = signedUrlExpiry();
  return (filePath, thumb) => signedFileUrl({ origin, filePath, secret, expUnix, thumb });
}

export function apiTaskPayload(row: GenerationTaskRow, buildImageUrl: ImageUrlBuilder): ApiTask {
  return toApiTask(row, getTaskImages(row.id), buildImageUrl);
}

/** 只让密钥主人读自己的任务；别人的任务一律当作不存在，避免被拿来枚举 id。 */
export function requireOwnApiTask(userId: string, taskId: string): GenerationTaskRow {
  const task = getGenerationTask(taskId);
  if (!task || task.user_id !== userId) {
    throw apiError("not_found", "任务不存在");
  }
  return task;
}

/** wait=true：每 1.5 秒回查一次，最长等 240 秒；超时返回最后一次读到的行。 */
export async function waitForTerminalTask(
  taskId: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<GenerationTaskRow> {
  const timeoutMs = options.timeoutMs ?? waitTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? waitPollIntervalMs;
  const deadline = Date.now() + timeoutMs;

  let latest = getGenerationTask(taskId);
  while (latest && !isTerminalTaskStatus(latest.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    latest = getGenerationTask(taskId);
  }

  if (!latest) {
    throw apiError("not_found", "任务不存在");
  }
  return latest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 建完任务后的统一出口：
 * wait=false 直接 202；wait=true 等到终态则 200 + data，等超时仍回 202。
 */
export async function finalizeApiGeneration(input: {
  request: NextRequest;
  task: GenerationTaskRow;
  wait: boolean;
  responseFormat: "url" | "b64_json";
}): Promise<NextResponse> {
  if (!input.wait) {
    return NextResponse.json({ task: apiTaskPayload(input.task, createImageUrlBuilder(input.request)) }, { status: 202 });
  }

  const latest = await waitForTerminalTask(input.task.id);
  const buildImageUrl = createImageUrlBuilder(input.request);
  const task = apiTaskPayload(latest, buildImageUrl);
  if (!isTerminalTaskStatus(latest.status)) {
    return NextResponse.json({ task }, { status: 202 });
  }

  const data = await toApiImageData(getTaskImages(latest.id), buildImageUrl, input.responseFormat);
  return NextResponse.json({ task, data });
}

export interface ApiImageData {
  id: string;
  url: string;
  width: number;
  height: number;
  b64_json?: string;
}

export async function toApiImageData(
  images: GeneratedImageRow[],
  buildImageUrl: ImageUrlBuilder,
  responseFormat: "url" | "b64_json",
): Promise<ApiImageData[]> {
  const data: ApiImageData[] = [];
  for (const image of images) {
    const item: ApiImageData = {
      id: image.id,
      url: buildImageUrl(image.file_path, false),
      width: image.width,
      height: image.height,
    };
    if (responseFormat === "b64_json") {
      try {
        const file = await readStorageFile(image.file_path);
        item.b64_json = Buffer.from(file.bytes).toString("base64");
      } catch {
        // 原图读不出来时只回 url，不让整次请求失败。
      }
    }
    data.push(item);
  }
  return data;
}

const maxApiUploadBytes = appConfig.sub2apiMaxUploadBytes;

/** 从 multipart 文件或 base64 字符串落一张参考图，归属调用方账号。 */
export async function saveApiSourceImage(input: {
  userId: string;
  bytes: Uint8Array;
  mimeType: string | null;
  originalName: string | null;
}): Promise<string> {
  if (input.bytes.length === 0) {
    throw apiError("validation_error", "参考图内容为空");
  }
  if (input.bytes.length > maxApiUploadBytes) {
    throw apiError("validation_error", `单张参考图不能超过 ${Math.floor(maxApiUploadBytes / 1_000_000)} MB`);
  }

  const mimeType = input.mimeType ?? detectImageMime(input.bytes);
  try {
    assertSupportedImageBytes(input.bytes, mimeType);
  } catch (error) {
    throw apiError("validation_error", error instanceof Error ? error.message : "仅支持 PNG、JPG、WEBP 图片");
  }

  const sourceId = createId("src");
  const filePath = await saveSourceImageFile({
    sourceId,
    fileName: input.originalName ?? `${sourceId}`,
    bytes: input.bytes,
    mimeType,
  });
  const source = createSourceImage({
    userId: input.userId,
    filePath,
    width: 0,
    height: 0,
    originalName: input.originalName,
    mimeType,
  });
  return source.id;
}

/** data URL 与纯 base64 都收；识别不出内容类型时按魔数兜底。 */
export function decodeBase64Image(value: string): { bytes: Uint8Array; mimeType: string | null } {
  const trimmed = value.trim();
  const dataUrl = trimmed.match(/^data:([a-zA-Z0-9.+/-]+);base64,(.*)$/s);
  const payload = (dataUrl ? dataUrl[2] : trimmed).replace(/\s+/g, "");
  if (!payload || !/^[A-Za-z0-9+/=_-]+$/.test(payload)) {
    throw apiError("validation_error", "image_base64 不是合法的 base64 内容");
  }

  const bytes = new Uint8Array(Buffer.from(payload, "base64"));
  if (bytes.length === 0) {
    throw apiError("validation_error", "image_base64 解码后为空");
  }
  return { bytes, mimeType: dataUrl ? dataUrl[1] : detectImageMime(bytes) };
}

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
