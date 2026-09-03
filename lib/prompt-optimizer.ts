import type { ImageProvider, OpenAIOAuthAccountRow } from "./types";
import { describeNetworkError } from "./model-error-detail";
import { fetchWithOriginHost, type OriginFetchInit } from "./origin-fetch";

export interface PromptOptimizationInput {
  prompt: string;
  mode?: string | null;
  sizeLabel?: string | null;
  negativePrompt?: string | null;
  templateName?: string | null;
  templateDescription?: string | null;
  variables?: Record<string, string>;
}

interface ResponsesPayload {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
  }>;
}

interface ChatCompletionsPayload {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface PromptOptimizerRuntimeSettings {
  provider: ImageProvider;
  baseUrl: string;
  bearerToken: string;
  hostHeader?: string;
  model: string;
  openaiOAuthProxyUrl?: string | null;
  oauthAccountId?: string | null;
  chatGPTAccountId?: string | null;
}

const openAIChatGPTCodexResponsesUrl = "https://chatgpt.com/backend-api/codex/responses";
const promptOptimizerTimeoutMs = 60_000;
const openAICodexUserAgent = "codex_cli_rs/0.125.0";

const promptOptimizerBaseRules = [
  "你是 Canvas Realm Studio 的 GPT-image-2 生产提示词总监。",
  "你的任务是把用户的中文图片生成 prompt 优化成可直接用于生产的最终 prompt。",
  "只输出 JSON：{\"prompt\":\"...\"}，prompt 的值是纯提示词文本，不要解释，不要 Markdown。",
  "优化原则：",
  "1. 保留用户原意，不虚构品牌、产品、人物身份或具体文字。",
  "2. 空变量不要写入最终 prompt，不要出现占位符、变量名或“可为空”。",
  "3. 电商图强调产品轮廓、材质、真实阴影和干净背景。",
  "4. 封面图强调标题安全区、主体不要贴边、适合平台信息流裁切。",
  "5. 海报图强调单一强主视觉、信息层级、色调统一，避免杂乱拼贴。",
  "6. 避免文字乱码、多余小字、低清晰度、廉价促销感、畸形结构。",
];

const textToImageRules = [
  "本次是文生图：可以把提示词补全为完整画面描述。",
  "把提示词整理为场景、主体、构图、安全区、材质光影、输出约束。",
];

// 图生图的 prompt 是「对已有图片的修改指令」，改写成整幅场景描述会让模型重画一张新图。
const imageToImageRules = [
  "本次是图生图：用户的 prompt 是对已有参考图的编辑指令，不是一整幅新画面的描述。",
  "保持编辑指令的语义和作用范围，只把指令表达得更精确（改哪里、改成什么、保留什么）。",
  "不要把编辑指令改写成完整场景描述，不要补充原图里没有出现的主体、背景或版式。",
  "明确要求未提及的区域、构图和风格保持与原图一致。",
];

export function buildPromptOptimizerSystemPrompt(mode?: string | null): string {
  const modeRules = mode === "image_to_image" || mode === "edit_image" ? imageToImageRules : textToImageRules;
  return [...promptOptimizerBaseRules, ...modeRules].join("\n");
}

const generationModeLabels: Record<string, string> = {
  text_to_image: "文生图（从零生成一张新图）",
  image_to_image: "图生图（在已有参考图上做编辑）",
  edit_image: "图生图（在已有参考图上做编辑）",
};

export function buildPromptOptimizerUserPrompt(input: PromptOptimizationInput): string {
  const variables = Object.entries(input.variables ?? {})
    .filter(([, value]) => value.trim())
    .map(([key, value]) => `${key}: ${value.trim()}`)
    .join("\n");
  const mode = input.mode ?? "text_to_image";
  const negativePrompt = input.negativePrompt?.trim();

  return [
    `生成模式：${generationModeLabels[mode] ?? mode}`,
    `目标规格：${input.sizeLabel?.trim() || "不限制"}`,
    input.templateName ? `生产模板：${input.templateName}` : "",
    input.templateDescription ? `模板说明：${input.templateDescription}` : "",
    variables ? `已填写变量：\n${variables}` : "",
    negativePrompt ? `需要规避的内容（不要写进最终 prompt，只用于约束表达）：\n${negativePrompt}` : "",
    "当前 prompt：",
    input.prompt,
  ].filter(Boolean).join("\n\n");
}

export function extractOptimizedPrompt(payload: unknown): string {
  const maybeJson = extractTextPayload(payload).trim();
  if (!maybeJson) {
    throw new Error("提示词优化模型返回为空");
  }

  const fenced = maybeJson.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const raw = fenced || maybeJson;
  try {
    const parsed = JSON.parse(raw) as { prompt?: unknown };
    if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
      return parsed.prompt.trim();
    }
  } catch {
    // Some compatible providers ignore the JSON-only instruction. Plain text is still useful.
  }

  return raw.trim();
}

function extractTextPayload(payload: unknown): string {
  const responsesPayload = payload as ResponsesPayload;
  if (typeof responsesPayload.output_text === "string") {
    return responsesPayload.output_text;
  }

  const responseText = responsesPayload.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .filter((text): text is string => Boolean(text))
    .join("\n");
  if (responseText) {
    return responseText;
  }

  const chatPayload = payload as ChatCompletionsPayload;
  return chatPayload.choices?.[0]?.message?.content ?? "";
}

export async function optimizePromptWithModel(input: PromptOptimizationInput): Promise<string> {
  const settings = await resolvePromptOptimizerRuntimeSettings();
  const userPrompt = buildPromptOptimizerUserPrompt(input);
  const systemPrompt = buildPromptOptimizerSystemPrompt(input.mode);

  if (settings.provider === "openai_oauth") {
    return requestOpenAIOAuthPromptOptimization(settings, systemPrompt, userPrompt);
  }

  const responsesError = await requestResponsesApi(
    settings.baseUrl,
    settings.model,
    settings.bearerToken,
    systemPrompt,
    userPrompt,
    settings.hostHeader,
  )
    .then((payload) => {
      throw new OptimizedPromptResult(extractOptimizedPrompt(payload));
    })
    .catch((error: unknown) => error);

  if (responsesError instanceof OptimizedPromptResult) {
    return responsesError.prompt;
  }

  const shouldFallbackToChat =
    responsesError instanceof PromptOptimizerHttpError &&
    [400, 404, 405].includes(responsesError.status);

  if (!shouldFallbackToChat && responsesError instanceof Error) {
    throw responsesError;
  }

  const payload = await requestChatCompletionsApi(
    settings.baseUrl,
    settings.model,
    settings.bearerToken,
    systemPrompt,
    userPrompt,
    settings.hostHeader,
  );
  return extractOptimizedPrompt(payload);
}

async function resolvePromptOptimizerRuntimeSettings(): Promise<PromptOptimizerRuntimeSettings> {
  const [{ appConfig }, db] = await Promise.all([
    import("./config"),
    import("./db"),
  ]);
  const imageSettings = db.getRuntimeImageSettings();
  const promptSettings = db.getPromptOptimizerSettings();

  if (imageSettings.imageProvider === "openai_oauth") {
    const account = db.getUsableOpenAIOAuthAccount();
    if (!account) {
      throw new Error("已选择 OpenAI OAuth 模式，但后台没有可用 OpenAI 账号");
    }
    return {
      provider: "openai_oauth",
      baseUrl: appConfig.openaiOAuthApiBaseUrl.replace(/\/+$/, ""),
      bearerToken: await getFreshOpenAIAccessTokenForPrompt(account, imageSettings.openaiOAuthProxyUrl),
      model: promptSettings.model,
      openaiOAuthProxyUrl: imageSettings.openaiOAuthProxyUrl,
      oauthAccountId: account.id,
      chatGPTAccountId: account.account_id,
    };
  }

  if (!imageSettings.sub2apiApiKey) {
    throw new Error("图片接口 API Key 未配置，无法优化提示词。");
  }

  return {
    provider: "sub2api",
    baseUrl: imageSettings.sub2apiBaseUrl.replace(/\/+$/, ""),
    bearerToken: imageSettings.sub2apiApiKey,
    hostHeader: appConfig.sub2apiHostHeader,
    model: promptSettings.model,
  };
}

async function getFreshOpenAIAccessTokenForPrompt(
  account: OpenAIOAuthAccountRow,
  proxyUrl?: string | null,
): Promise<string> {
  const [oauth, db] = await Promise.all([
    import("./openai-oauth"),
    import("./db"),
  ]);

  if (!oauth.shouldRefreshOpenAIToken(account.expires_at)) {
    return oauth.decryptToken(account.access_token_ciphertext);
  }

  try {
    const currentRefreshToken = oauth.decryptToken(account.refresh_token_ciphertext);
    const refreshed = await oauth.refreshOpenAIOAuthToken({
      refreshToken: currentRefreshToken,
      clientId: account.client_id,
      proxyUrl,
    });
    const userInfo = oauth.decodeOpenAIIdToken(refreshed.id_token);
    const nextRefreshToken = refreshed.refresh_token || currentRefreshToken;
    db.updateOpenAIOAuthAccountTokens(account.id, {
      accessTokenCiphertext: oauth.encryptToken(refreshed.access_token),
      refreshTokenCiphertext: oauth.encryptToken(nextRefreshToken),
      expiresAt: oauth.tokenExpiresAt(refreshed.expires_in),
      email: userInfo.email,
      accountId: userInfo.accountId,
      userId: userInfo.userId,
      organizationId: userInfo.organizationId,
      planType: userInfo.planType,
    });
    return refreshed.access_token;
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenAI OAuth token refresh failed";
    db.updateOpenAIOAuthAccountStatus(account.id, "error", message);
    throw new Error(`OpenAI OAuth token 刷新失败：${message}`);
  }
}

export async function requestResponsesApi(
  baseUrl: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  hostHeader: string | undefined,
): Promise<unknown> {
  const response = await fetchOptimizer(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: userPrompt }] },
      ],
    }),
  }, hostHeader);
  return readOptimizerResponse(response, "Responses");
}

export async function requestChatCompletionsApi(
  baseUrl: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  hostHeader: string | undefined,
): Promise<unknown> {
  const response = await fetchOptimizer(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.25,
    }),
  }, hostHeader);
  return readOptimizerResponse(response, "Chat Completions");
}

// 提示词优化是前台同步等待的调用，超过一分钟直接判失败，别让页面一直转圈。
// 直连源站 IP 时 Host 头要真正发出去，所以走 fetchWithOriginHost 而不是裸 fetch；
// hostHeader 是必填位（可为 undefined），免得哪个调用点忘了透传、静默退回裸 IP 的 Host。
async function fetchOptimizer(
  url: string,
  init: OriginFetchInit,
  hostHeader: string | undefined,
): Promise<Response> {
  try {
    return await fetchWithOriginHost(
      url,
      { ...init, signal: AbortSignal.timeout(promptOptimizerTimeoutMs) },
      hostHeader,
    );
  } catch (error) {
    throw toPromptOptimizerNetworkError(error);
  }
}

/**
 * 网络层错误转成前端能直接展示的中文短文案。
 * 这个 message 会经 handleRouteError 原样回给页面，所以「connect ECONNREFUSED 1.2.3.4:80」这类
 * 带源站 IP/端口的原文只能留在 cause 里（服务端日志可看），不能出现在 message。
 */
export function toPromptOptimizerNetworkError(error: unknown): Error {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new Error("提示词优化超时，请稍后重试或直接使用当前提示词。");
  }
  const network = describeNetworkError(error);
  if (network) {
    return new Error("提示词优化服务连接失败，请稍后重试或直接使用当前提示词。", { cause: error });
  }
  return error instanceof Error ? error : new Error("提示词优化调用失败");
}

async function requestOpenAIOAuthPromptOptimization(
  settings: PromptOptimizerRuntimeSettings,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const { fetchWithOptionalProxy } = await import("./proxy");
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

  const response = await fetchWithOptionalProxy(openAIChatGPTCodexResponsesUrl, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(promptOptimizerTimeoutMs),
    body: JSON.stringify({
      instructions: systemPrompt,
      stream: true,
      reasoning: { effort: "medium", summary: "auto" },
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      model: settings.model,
      store: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userPrompt }],
        },
      ],
    }),
  }, settings.openaiOAuthProxyUrl);

  const text = await response.text();
  if (!response.ok) {
    const message = `提示词优化调用失败（OpenAI OAuth ${response.status}）：${text.slice(0, 500)}`;
    if (response.status === 401 && settings.oauthAccountId) {
      const { updateOpenAIOAuthAccountStatus } = await import("./db");
      updateOpenAIOAuthAccountStatus(settings.oauthAccountId, "error", message);
    }
    throw new Error(message);
  }

  return extractOptimizedPrompt(extractOpenAIOAuthTextPayload(text));
}

function extractOpenAIOAuthTextPayload(streamText: string): unknown {
  let outputText = "";
  let lastJson: unknown = null;
  for (const line of streamText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const payload = JSON.parse(data) as {
        type?: string;
        delta?: string;
        response?: unknown;
      };
      lastJson = payload;
      if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
        outputText += payload.delta;
      }
      if (payload.type === "response.completed" && payload.response) {
        const completedText = extractTextPayload(payload.response);
        if (completedText) {
          outputText += completedText;
        }
      }
    } catch {
      // Ignore non-JSON SSE payloads.
    }
  }
  return outputText ? { output_text: outputText } : lastJson;
}

async function readOptimizerResponse(response: Response, endpoint: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new PromptOptimizerHttpError(
      `提示词优化调用失败（${endpoint} ${response.status}）：${text.slice(0, 500)}`,
      response.status,
    );
  }
  return text ? JSON.parse(text) : {};
}

class OptimizedPromptResult extends Error {
  prompt: string;

  constructor(prompt: string) {
    super("optimized prompt ready");
    this.prompt = prompt;
  }
}

class PromptOptimizerHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
