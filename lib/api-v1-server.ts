import { NextRequest, NextResponse } from "next/server";
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
  getApiSigningSecret,
  getGenerationTask,
  getTaskImages,
} from "./db";
import { assertQuotaAvailable } from "./permissions";
import { assertApiKeyRateLimit } from "./rate-limit";
import { signedFileUrl, signedUrlExpiry } from "./signed-url";
import { storeSourceImages } from "./source-image-store";
import { detectImageMime, prepareSourceImage, type PreparedSourceImage } from "./source-image-upload";
import { ImageValidationError, readStorageFile } from "./storage";
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

/**
 * 开放 API 的参考图落盘：先把所有图校验 + 归一化完，再统一写盘建记录（两阶段），任何一张有问题都不会
 * 留下孤儿文件 / 记录。只有 ImageValidationError（用户的图有问题）收敛成 validation_error，
 * 其余异常（sharp 不可用、磁盘写失败……）原样上抛走 500，不把内部错误当参数错误回给调用方。
 */
export async function saveApiSourceImages(
  userId: string,
  images: readonly { bytes: Uint8Array; mimeType: string | null; originalName: string | null }[],
): Promise<string[]> {
  const prepared: PreparedSourceImage[] = [];
  for (const image of images) {
    try {
      prepared.push(await prepareSourceImage(image));
    } catch (error) {
      if (error instanceof ImageValidationError) {
        throw apiError("validation_error", error.message);
      }
      throw error;
    }
  }
  const rows = await storeSourceImages(userId, prepared);
  return rows.map((row) => row.id);
}

/** 单张便捷入口，语义同 saveApiSourceImages。 */
export async function saveApiSourceImage(input: {
  userId: string;
  bytes: Uint8Array;
  mimeType: string | null;
  originalName: string | null;
}): Promise<string> {
  const [id] = await saveApiSourceImages(input.userId, [input]);
  return id;
}

/** data URL 与纯 base64 都收；识别不出内容类型时按魔数兜底。 */
export { detectImageMime };

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
