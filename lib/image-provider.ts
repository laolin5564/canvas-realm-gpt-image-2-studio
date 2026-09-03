import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { appConfig, IMAGE_USER_AGENT } from "./config";
import {
  getRuntimeImageSettings,
  getUsableOpenAIOAuthAccount,
  nowIso,
  recordGenerationAttempt,
  updateOpenAIOAuthAccountStatus,
  updateOpenAIOAuthAccountTokens,
} from "./db";
import { apiQualityForOption, apiSizeForOption } from "./image-options";
import { fitReferenceImagesToBudget, type ReferenceImageUpload } from "./image-upload";
import { isImageTimeoutError, runAcrossChannels, runImageGenerationBatches } from "./image-batch";
import { imageErrorStatus, isRetryableImageError } from "./image-retry";
import { modelErrorDetail, UpstreamImageDetailError } from "./model-error-detail";
import { withUpstreamImageSlot } from "./concurrency";
import {
  decodeOpenAIIdToken,
  decryptToken,
  encryptToken,
  refreshOpenAIOAuthToken,
  shouldRefreshOpenAIToken,
  tokenExpiresAt,
} from "./openai-oauth";
import { fetchWithOriginHost } from "./origin-fetch";
import { extractOpenAIOAuthImagesFromResponsesStream } from "./openai-image-bridge";
import { formatModelError, formatModelErrorDetail } from "./model-error";
import { fetchWithOptionalProxy } from "./proxy";
import type { GenerationTaskRow, ImageProvider, OpenAIOAuthAccountRow } from "./types";
import { assertSupportedImage, assertSupportedImageBytes, readStorageFile } from "./storage";

interface ImageApiItem {
  b64_json?: string;
  url?: string;
  mimeType?: string | null;
}

interface ImageApiResponse {
  data?: ImageApiItem[];
}

const maxDownloadedImageBytes = 25 * 1024 * 1024;
const openAIChatGPTCodexResponsesUrl = "https://chatgpt.com/backend-api/codex/responses";
const openAICodexResponsesModel = "gpt-5.4-mini";
const openAICodexUserAgent = "codex_cli_rs/0.125.0";

interface ImageRequestSettings {
  provider: ImageProvider;
  channelId?: string;
  channelName?: string;
  baseUrl: string;
  bearerToken: string;
  hostHeader?: string;
  imageModel: string;
  imageConcurrency: number;
  openaiOAuthProxyUrl?: string;
  oauthAccountId?: string;
  chatGPTAccountId?: string | null;
}

export interface MaterializedImage {
  bytes: Uint8Array;
  mimeType: string | null;
}

/**
 * 生成一个任务需要的图片。
 * @param alreadyDelivered 已经落库的张数（重启续跑时来自 generated_images），只补剩余部分。
 */
export async function callImageModel(
  task: GenerationTaskRow,
  sourceImagePaths: string[],
  signal?: AbortSignal,
  onImage?: (image: MaterializedImage) => Promise<void>,
  alreadyDelivered = 0,
): Promise<MaterializedImage[]> {
  const images: MaterializedImage[] = [];
  if (alreadyDelivered >= task.quantity) {
    return images;
  }

  const candidates = await resolveImageProviderCandidates(signal);
  // 参考图对一个任务只准备一次（读盘 + 压缩到网关预算内），各请求、各渠道复用。
  const references = createReferenceImageLoader(sourceImagePaths);
  let delivered = alreadyDelivered;

  const deliver = async (image: MaterializedImage): Promise<void> => {
    if (onImage) {
      await onImage(image);
    }
    images.push(image);
    delivered += 1;
  };

  await runAcrossChannels({
    channels: candidates,
    run: (settings) =>
      callImageModelWithSettings(task, references, settings, signal, () => delivered, deliver),
    isAbort: (error) => isAbortError(error) || Boolean(signal?.aborted),
    isRetryable: isRetryableImageError,
    exhaustedMessage: "所有模型渠道均调用失败",
  });

  return images;
}

async function callImageModelWithSettings(
  task: GenerationTaskRow,
  references: ReferenceImageLoader,
  settings: ImageRequestSettings,
  signal: AbortSignal | undefined,
  delivered: () => number,
  deliver: (image: MaterializedImage) => Promise<void>,
): Promise<void> {
  const taskConcurrency = normalizeTaskImageConcurrency(task.requested_concurrency, settings.imageConcurrency);

  await runImageGenerationBatches<MaterializedImage>({
    total: task.quantity,
    delivered,
    concurrency: taskConcurrency,
    // 每个 n=1 请求独立跑完整条链路：拿数据 → materialize → 落库。
    request: async () => {
      const payload =
        task.mode === "text_to_image"
          ? await requestTextToImage(task, settings, 1, signal)
          : await requestImageEdit(task, references, settings, 1, signal);
      const items = normalizeImageItems(payload);
      return Promise.all(items.map((item) => materializeImageItem(item, signal)));
    },
    deliver,
    isAbort: (error) => isAbortError(error) || Boolean(signal?.aborted),
    isRetryable: isRetryableImageError,
    // 超时不在本渠道补发：直接换下一个渠道，别让用户等两个超时窗口。
    shouldSwitchChannel: isImageTimeoutError,
    maxRetriesPerBatch: 1,
  });
}

export interface ReferenceImageLoader {
  /** 原始参考图字节（OpenAI OAuth 走 data URL 用）。 */
  raw: () => Promise<ReferenceImageUpload[]>;
  /** 压缩到网关上传预算内的参考图（multipart 上传用）。 */
  forUpload: () => Promise<ReferenceImageUpload[]>;
  count: number;
}

export function createReferenceImageLoader(sourceImagePaths: string[]): ReferenceImageLoader {
  let rawPromise: Promise<ReferenceImageUpload[]> | null = null;
  let uploadPromise: Promise<ReferenceImageUpload[]> | null = null;

  const raw = (): Promise<ReferenceImageUpload[]> => {
    rawPromise ??= Promise.all(
      sourceImagePaths.map(async (sourceImagePath) => {
        const image = await readStorageFile(sourceImagePath);
        return { ...image, fileName: path.basename(sourceImagePath) };
      }),
    );
    return rawPromise;
  };

  const forUpload = (): Promise<ReferenceImageUpload[]> => {
    uploadPromise ??= raw().then((images) =>
      fitReferenceImagesToBudget(images, appConfig.sub2apiMaxUploadBytes),
    );
    return uploadPromise;
  };

  return { raw, forUpload, count: sourceImagePaths.length };
}

/**
 * 给一次上游 n=1 请求记一条遥测（成功、失败都记）。
 * 记录只包在实际请求外面，不含等信号量槽位的时间，耗时才是渠道自己的表现。
 * 遥测写库失败只打日志：可观测性不该反过来把生成任务弄挂。
 */
async function withAttemptTelemetry<T>(
  task: GenerationTaskRow,
  settings: ImageRequestSettings,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = nowIso();
  const startedTs = Date.now();

  const save = (ok: boolean, statusCode: number | null, errorMessage: string | null): void => {
    try {
      recordGenerationAttempt({
        taskId: task.id,
        channelId: settings.channelId ?? null,
        channelName: settings.channelName ?? null,
        statusCode,
        ok,
        durationMs: Date.now() - startedTs,
        errorMessage,
        startedAt,
      });
    } catch (error) {
      console.error(
        `record generation attempt failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  };

  try {
    const result = await operation();
    // 能走到这里说明响应已经是 2xx（非 2xx 在 readModelResponse 里就抛了）。
    save(true, 200, null);
    return result;
  } catch (error) {
    if (isAbortError(error)) {
      // 用户主动停止：不是渠道的锅，不计进渠道统计。
      throw error;
    }
    const reason = modelErrorDetail(error) ?? (error instanceof Error ? error.message : String(error ?? ""));
    save(false, imageErrorStatus(error), reason);
    throw error;
  }
}

function normalizeTaskImageConcurrency(value: number | null, fallback: number): number {
  if (value === null || value === undefined) {
    return fallback;
  }
  return Math.min(Math.max(1, Math.floor(value)), Math.max(1, fallback));
}

async function resolveImageProviderCandidates(signal?: AbortSignal): Promise<ImageRequestSettings[]> {
  const settings = getRuntimeImageSettings();
  if (settings.imageProvider === "openai_oauth") {
    const account = getUsableOpenAIOAuthAccount();
    if (!account) {
      throw new Error("已选择 OpenAI OAuth 模式，但后台没有可用 OpenAI 账号");
    }
    const accessToken = await getFreshOpenAIAccessToken(account, settings.openaiOAuthProxyUrl, signal);
    return [{
      provider: "openai_oauth",
      channelId: account.id,
      channelName: account.email ?? "OpenAI OAuth",
      baseUrl: appConfig.openaiOAuthApiBaseUrl.replace(/\/+$/, ""),
      bearerToken: accessToken,
      imageModel: settings.imageModel,
      imageConcurrency: settings.imageConcurrency,
      openaiOAuthProxyUrl: settings.openaiOAuthProxyUrl,
      oauthAccountId: account.id,
      chatGPTAccountId: account.account_id,
    }];
  }

  const channels = settings.imageProviderChannels.filter((channel) => channel.enabled && channel.apiKey);
  if (channels.length === 0 && !settings.sub2apiApiKey) {
    throw new Error("SUB2API_API_KEY 未配置，无法调用 image-2");
  }

  const fallbackChannel = settings.sub2apiApiKey
    ? [{
        id: "legacy_sub2api",
        name: "默认 API Key 渠道",
        enabled: true,
        priority: 999,
        baseUrl: settings.sub2apiBaseUrl,
        model: settings.imageModel,
        apiKey: settings.sub2apiApiKey,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }]
    : [];

  const resolvedChannels = channels.length > 0 ? channels : fallbackChannel;
  return resolvedChannels.map((channel) => ({
    provider: "sub2api" as const,
    channelId: channel.id,
    channelName: channel.name,
    baseUrl: channel.baseUrl.replace(/\/+$/, ""),
    bearerToken: channel.apiKey,
    hostHeader: appConfig.sub2apiHostHeader,
    imageModel: channel.model,
    imageConcurrency: settings.imageConcurrency,
  }));
}

async function getFreshOpenAIAccessToken(
  account: OpenAIOAuthAccountRow,
  proxyUrl?: string | null,
  signal?: AbortSignal,
): Promise<string> {
  if (!shouldRefreshOpenAIToken(account.expires_at)) {
    return decryptToken(account.access_token_ciphertext);
  }

  try {
    const currentRefreshToken = decryptToken(account.refresh_token_ciphertext);
    const refreshed = await refreshOpenAIOAuthToken({
      refreshToken: currentRefreshToken,
      clientId: account.client_id,
      proxyUrl,
      signal: requestSignal(signal),
    });
    const userInfo = decodeOpenAIIdToken(refreshed.id_token);
    const nextRefreshToken = refreshed.refresh_token || currentRefreshToken;
    updateOpenAIOAuthAccountTokens(account.id, {
      accessTokenCiphertext: encryptToken(refreshed.access_token),
      refreshTokenCiphertext: encryptToken(nextRefreshToken),
      expiresAt: tokenExpiresAt(refreshed.expires_in),
      email: userInfo.email,
      accountId: userInfo.accountId,
      userId: userInfo.userId,
      organizationId: userInfo.organizationId,
      planType: userInfo.planType,
    });
    return refreshed.access_token;
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenAI OAuth token refresh failed";
    updateOpenAIOAuthAccountStatus(account.id, "error", message);
    throw new Error(`OpenAI OAuth token 刷新失败：${message}`);
  }
}

async function requestTextToImage(
  task: GenerationTaskRow,
  settings: ImageRequestSettings,
  quantity: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (settings.provider === "openai_oauth") {
    return requestOpenAIOAuthImage(task, emptyReferenceImageLoader, settings, signal);
  }

  const body: Record<string, string | number> = {
    model: settings.imageModel,
    prompt: buildPrompt(task, 0),
    n: quantity,
  };

  const apiSize = apiSizeForOption(task.size);
  if (apiSize) {
    body.size = apiSize;
  }
  const apiQuality = apiQualityForOption(task.quality);
  if (apiQuality) {
    body.quality = apiQuality;
  }

  return withUpstreamImageSlot(() =>
    withAttemptTelemetry(task, settings, async () => {
      const response = await fetchWithOriginHost(`${settings.baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.bearerToken}`,
          "Content-Type": "application/json",
          "User-Agent": IMAGE_USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: requestSignal(signal),
      }, settings.hostHeader);

      return readModelResponse(response, "image generation failed", settings);
    }),
  );
}

async function requestImageEdit(
  task: GenerationTaskRow,
  references: ReferenceImageLoader,
  settings: ImageRequestSettings,
  quantity: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (settings.provider === "openai_oauth") {
    return requestOpenAIOAuthImage(task, references, settings, signal);
  }

  if (references.count === 0) {
    throw new Error("缺少参考图，无法调用图片编辑接口");
  }

  const uploadImages = await references.forUpload();
  const form = new FormData();
  form.append("model", settings.imageModel);
  for (const image of uploadImages) {
    const blob = new Blob([new Uint8Array(image.bytes)], { type: image.mimeType });
    form.append("image", blob, image.fileName);
  }
  form.append("prompt", buildPrompt(task, references.count));
  form.append("n", String(quantity));
  const apiSize = apiSizeForOption(task.size);
  if (apiSize) {
    form.append("size", apiSize);
  }
  const apiQuality = apiQualityForOption(task.quality);
  if (apiQuality) {
    form.append("quality", apiQuality);
  }
  if (appConfig.imageEditInputFidelity) {
    form.append("input_fidelity", appConfig.imageEditInputFidelity);
  }

  return withUpstreamImageSlot(() =>
    withAttemptTelemetry(task, settings, async () => {
      const response = await fetchWithOriginHost(`${settings.baseUrl}/images/edits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.bearerToken}`,
          "User-Agent": IMAGE_USER_AGENT,
        },
        body: form,
        signal: requestSignal(signal),
      }, settings.hostHeader);

      return readModelResponse(response, "image edit failed", settings);
    }),
  );
}

const emptyReferenceImageLoader: ReferenceImageLoader = {
  raw: async () => [],
  forUpload: async () => [],
  count: 0,
};

async function requestOpenAIOAuthImage(
  task: GenerationTaskRow,
  references: ReferenceImageLoader,
  settings: ImageRequestSettings,
  signal?: AbortSignal,
): Promise<ImageApiResponse> {
  const body = await buildOpenAIOAuthResponsesBody(task, references, settings);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${settings.bearerToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    "User-Agent": openAICodexUserAgent,
  };
  if (settings.chatGPTAccountId) {
    headers["chatgpt-account-id"] = settings.chatGPTAccountId;
  }
  if (task.conversation_id) {
    const sessionId = `canvas-realm-${task.conversation_id}`;
    headers.conversation_id = sessionId;
    headers.session_id = sessionId;
  }

  return withUpstreamImageSlot(() =>
    withAttemptTelemetry(task, settings, async () => {
      const response = await fetchWithOptionalProxy(openAIChatGPTCodexResponsesUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: requestSignal(signal),
      }, settings.openaiOAuthProxyUrl);

      if (!response.ok) {
        const text = await response.text();
        const fallback = "OpenAI OAuth Codex image generation failed";
        const message = formatModelError(response.status, text, fallback);
        if (response.status === 401 && settings.oauthAccountId) {
          updateOpenAIOAuthAccountStatus(settings.oauthAccountId, "error", message);
        }
        throw new UpstreamImageDetailError(
          message,
          response.status,
          formatModelErrorDetail(response.status, text, fallback),
        );
      }

      const text = await response.text();
      const images = extractOpenAIOAuthImagesFromResponsesStream(text);
      if (images.length === 0) {
        throw new Error("OpenAI OAuth Codex Responses 未返回图片数据");
      }
      return { data: images };
    }),
  );
}

async function buildOpenAIOAuthResponsesBody(
  task: GenerationTaskRow,
  references: ReferenceImageLoader,
  settings: ImageRequestSettings,
): Promise<Record<string, unknown>> {
  const content: Array<Record<string, string>> = [
    { type: "input_text", text: buildPrompt(task, references.count) },
  ];
  if (task.mode !== "text_to_image") {
    if (references.count === 0) {
      throw new Error("缺少参考图，无法调用图片编辑接口");
    }
    for (const source of await references.raw()) {
      content.push({
        type: "input_image",
        image_url: `data:${source.mimeType};base64,${Buffer.from(source.bytes).toString("base64")}`,
      });
    }
  }

  const tool: Record<string, unknown> = {
    type: "image_generation",
    action: task.mode === "text_to_image" ? "generate" : "edit",
    model: settings.imageModel,
    output_format: "png",
  };
  const apiSize = apiSizeForOption(task.size);
  if (apiSize) {
    tool.size = apiSize;
  }
  const apiQuality = apiQualityForOption(task.quality);
  if (apiQuality) {
    tool.quality = apiQuality;
  }

  return {
    instructions: "",
    stream: true,
    reasoning: { effort: "medium", summary: "auto" },
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    model: openAICodexResponsesModel,
    store: false,
    tool_choice: { type: "image_generation" },
    input: [{ type: "message", role: "user", content }],
    tools: [tool],
  };
}

export function buildPrompt(task: GenerationTaskRow, referenceCount: number): string {
  const parts = [task.prompt.trim()];
  if (task.negative_prompt && task.negative_prompt.trim() !== "") {
    parts.push(`避免出现：${task.negative_prompt.trim()}`);
  }

  // 强度数字对上游是纯噪声（模型并不按这两个小数调节），只有多图时的主图/参考图关系才有信息量。
  if (task.mode !== "text_to_image" && referenceCount > 1) {
    parts.push("图片参考关系：第一张是主图，后续是参考图；请以主图为基础，结合参考图和文字提示进行二次生成。");
  }

  return parts.join("\n");
}

async function readModelResponse(
  response: Response,
  fallback: string,
  settings: ImageRequestSettings,
): Promise<unknown> {
  if (!response.ok) {
    const text = await response.text();
    const messagePrefix = settings.channelName ? `${settings.channelName}：` : "";
    const message = `${messagePrefix}${formatModelError(response.status, text, fallback)}`;
    if (settings.provider === "openai_oauth" && response.status === 401 && settings.oauthAccountId) {
      updateOpenAIOAuthAccountStatus(settings.oauthAccountId, "error", message);
    }
    // 带上 status，让上层区分「换渠道有救」（5xx/429/408）和「换几次都白搭」（其余 4xx）；
    // detail 是给管理员看的原文，用户看到的仍然只有上面那句短文案。
    throw new UpstreamImageDetailError(
      message,
      response.status,
      `${messagePrefix}${formatModelErrorDetail(response.status, text, fallback)}`,
    );
  }

  return response.json();
}

function normalizeImageItems(payload: unknown): ImageApiItem[] {
  const response = payload as ImageApiResponse;
  if (!Array.isArray(response.data)) {
    return [];
  }

  return response.data.filter((item) => item.b64_json || item.url);
}

async function materializeImageItem(item: ImageApiItem, signal?: AbortSignal): Promise<MaterializedImage> {
  if (item.b64_json) {
    const bytes = new Uint8Array(Buffer.from(item.b64_json, "base64"));
    if (bytes.byteLength > maxDownloadedImageBytes) {
      throw new Error("模型返回图片过大");
    }
    return {
      bytes,
      mimeType: item.mimeType || "image/png",
    };
  }

  if (item.url) {
    return downloadImage(item.url, signal);
  }

  throw new Error("image-2 返回了无法识别的图片格式");
}

async function downloadImage(url: string, signal?: AbortSignal): Promise<MaterializedImage> {
  await assertSafeImageDownloadUrl(url);
  const response = await fetch(url, {
    headers: {
      "User-Agent": IMAGE_USER_AGENT,
    },
    signal: requestSignal(signal),
  });

  if (!response.ok) {
    throw new Error(`图片下载失败: ${response.status}`);
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null;
  assertSupportedImage(contentType);

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxDownloadedImageBytes) {
    throw new Error("图片下载失败：文件过大");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("图片下载失败：响应体为空");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxDownloadedImageBytes) {
      throw new Error("图片下载失败：文件过大");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assertSupportedImageBytes(bytes, contentType);
  return { bytes, mimeType: contentType };
}

async function assertSafeImageDownloadUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("图片下载失败：URL 不合法");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("图片下载失败：仅允许 HTTP/HTTPS URL");
  }

  const addresses = isIP(parsed.hostname)
    ? [{ address: parsed.hostname }]
    : await lookup(parsed.hostname, { all: true, verbatim: true });
  if (addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error("图片下载失败：不允许访问内网地址");
  }
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address.toLowerCase().startsWith("fe80:")) {
    return true;
  }

  if (address.startsWith("fc") || address.startsWith("fd")) {
    return true;
  }

  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(appConfig.imageRequestTimeoutMs);
  if (!signal) {
    return timeoutSignal;
  }
  return AbortSignal.any([signal, timeoutSignal]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
