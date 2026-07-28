import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { appConfig, IMAGE_USER_AGENT } from "./config";
import {
  getRuntimeImageSettings,
  getUsableOpenAIOAuthAccount,
  updateOpenAIOAuthAccountStatus,
  updateOpenAIOAuthAccountTokens,
} from "./db";
import { apiSizeForOption } from "./image-options";
import { fitReferenceImagesToBudget } from "./image-upload";
import {
  decodeOpenAIIdToken,
  decryptToken,
  encryptToken,
  refreshOpenAIOAuthToken,
  shouldRefreshOpenAIToken,
  tokenExpiresAt,
} from "./openai-oauth";
import { withOptionalHostHeader } from "./http-host";
import { extractOpenAIOAuthImagesFromResponsesStream } from "./openai-image-bridge";
import { formatModelError } from "./model-error";
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

export async function callImageModel(
  task: GenerationTaskRow,
  sourceImagePaths: string[],
  signal?: AbortSignal,
): Promise<MaterializedImage[]> {
  const candidates = await resolveImageProviderCandidates(signal);
  let lastError: unknown = null;

  for (const settings of candidates) {
    try {
      return await callImageModelWithSettings(task, sourceImagePaths, settings, signal);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("所有模型渠道均调用失败");
}

async function callImageModelWithSettings(
  task: GenerationTaskRow,
  sourceImagePaths: string[],
  settings: ImageRequestSettings,
  signal?: AbortSignal,
): Promise<MaterializedImage[]> {
  const taskConcurrency = normalizeTaskImageConcurrency(task.requested_concurrency, settings.imageConcurrency);

  const images: MaterializedImage[] = [];
  while (images.length < task.quantity) {
    const remaining = task.quantity - images.length;
    const batchSize = Math.min(remaining, taskConcurrency);
    const batch = await Promise.all(
      Array.from({ length: batchSize }, async () => {
        const result =
          task.mode === "text_to_image"
            ? await requestTextToImage(task, settings, 1, signal)
            : await requestImageEdit(task, sourceImagePaths, settings, 1, signal);
        return normalizeImageItems(result);
      }),
    );
    const items = batch.flat();
    if (items.length === 0) {
      throw new Error("image-2 未返回图片数据");
    }

    for (const item of items.slice(0, remaining)) {
      images.push(await materializeImageItem(item, signal));
    }
  }
  return images;
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
    return requestOpenAIOAuthImage(task, [], settings, signal);
  }

  const body: Record<string, string | number> = {
    model: settings.imageModel,
    prompt: buildPrompt(task),
    n: quantity,
  };

  const apiSize = apiSizeForOption(task.size);
  if (apiSize) {
    body.size = apiSize;
  }

  const response = await fetch(`${settings.baseUrl}/images/generations`, {
    method: "POST",
    headers: withOptionalHostHeader({
      Authorization: `Bearer ${settings.bearerToken}`,
      "Content-Type": "application/json",
      "User-Agent": IMAGE_USER_AGENT,
    }, settings.hostHeader),
    body: JSON.stringify(body),
    signal: requestSignal(signal),
  });

  return readModelResponse(response, "image generation failed", settings);
}

async function requestImageEdit(
  task: GenerationTaskRow,
  sourceImagePaths: string[],
  settings: ImageRequestSettings,
  quantity: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (settings.provider === "openai_oauth") {
    return requestOpenAIOAuthImage(task, sourceImagePaths, settings, signal);
  }

  if (sourceImagePaths.length === 0) {
    throw new Error("缺少参考图，无法调用图片编辑接口");
  }

  const form = new FormData();
  form.append("model", settings.imageModel);
  const sourceImages = await Promise.all(
    sourceImagePaths.map(async (sourceImagePath) => {
      const image = await readStorageFile(sourceImagePath);
      return {
        ...image,
        fileName: path.basename(sourceImagePath),
      };
    }),
  );
  const uploadImages = await fitReferenceImagesToBudget(
    sourceImages,
    appConfig.sub2apiMaxUploadBytes,
  );
  for (const image of uploadImages) {
    const blob = new Blob([new Uint8Array(image.bytes)], { type: image.mimeType });
    form.append("image", blob, image.fileName);
  }
  form.append("prompt", buildPrompt(task));
  form.append("n", String(quantity));
  const apiSize = apiSizeForOption(task.size);
  if (apiSize) {
    form.append("size", apiSize);
  }

  const response = await fetch(`${settings.baseUrl}/images/edits`, {
    method: "POST",
    headers: withOptionalHostHeader({
      Authorization: `Bearer ${settings.bearerToken}`,
      "User-Agent": IMAGE_USER_AGENT,
    }, settings.hostHeader),
    body: form,
    signal: requestSignal(signal),
  });

  return readModelResponse(response, "image edit failed", settings);
}

async function requestOpenAIOAuthImage(
  task: GenerationTaskRow,
  sourceImagePaths: string[],
  settings: ImageRequestSettings,
  signal?: AbortSignal,
): Promise<ImageApiResponse> {
  const body = await buildOpenAIOAuthResponsesBody(task, sourceImagePaths, settings);
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

  const response = await fetchWithOptionalProxy(openAIChatGPTCodexResponsesUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: requestSignal(signal),
  }, settings.openaiOAuthProxyUrl);

  if (!response.ok) {
    const text = await response.text();
    const message = formatModelError(response.status, text, "OpenAI OAuth Codex image generation failed");
    if (response.status === 401 && settings.oauthAccountId) {
      updateOpenAIOAuthAccountStatus(settings.oauthAccountId, "error", message);
    }
    throw new Error(message);
  }

  const text = await response.text();
  const images = extractOpenAIOAuthImagesFromResponsesStream(text);
  if (images.length === 0) {
    throw new Error("OpenAI OAuth Codex Responses 未返回图片数据");
  }
  return { data: images };
}

async function buildOpenAIOAuthResponsesBody(
  task: GenerationTaskRow,
  sourceImagePaths: string[],
  settings: ImageRequestSettings,
): Promise<Record<string, unknown>> {
  const content: Array<Record<string, string>> = [{ type: "input_text", text: buildPrompt(task) }];
  if (task.mode !== "text_to_image") {
    if (sourceImagePaths.length === 0) {
      throw new Error("缺少参考图，无法调用图片编辑接口");
    }
    for (const sourceImagePath of sourceImagePaths) {
      const source = await readStorageFile(sourceImagePath);
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

function buildPrompt(task: GenerationTaskRow): string {
  const parts = [task.prompt.trim()];
  if (task.negative_prompt && task.negative_prompt.trim() !== "") {
    parts.push(`避免出现：${task.negative_prompt.trim()}`);
  }

  if (task.mode !== "text_to_image") {
    parts.push(`参考强度：${task.reference_strength.toFixed(2)}；风格强度：${task.style_strength.toFixed(2)}。`);
    if (task.reference_image_id) {
      parts.push("图片参考关系：第一张图片是需要处理的主图，后续图片是额外参考图；请以主图为基础，结合参考图和文字提示进行二次生成。");
    }
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
    throw new Error(message);
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
