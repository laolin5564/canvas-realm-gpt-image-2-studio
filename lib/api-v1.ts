import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import type {
  GeneratedImageRow,
  GenerationMode,
  GenerationTaskRow,
  TaskProgressStage,
  TaskStatus,
} from "./types";

/**
 * 开放 API 的纯逻辑层：错误码映射、task 契约对象、origin 解析、令牌桶。
 * 这里不许 import lib/db（node:sqlite 在 bun 里跑不起来），保证能被 bun:test 直接覆盖。
 */

export const apiErrorCodes = [
  "unauthorized",
  "forbidden",
  "quota_exceeded",
  "validation_error",
  "not_found",
  "rate_limited",
  "too_many_active_tasks",
  "api_disabled",
  "server_error",
] as const;
export type ApiErrorCode = (typeof apiErrorCodes)[number];

const defaultStatusByCode: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  quota_exceeded: 403,
  validation_error: 400,
  not_found: 404,
  rate_limited: 429,
  too_many_active_tasks: 429,
  api_disabled: 403,
  server_error: 500,
};

/** 只按 HTTP 状态码兜底时的取值；语义更准的 code 由抛错方显式给出。 */
const codeByStatus: Record<number, ApiErrorCode> = {
  400: "validation_error",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  429: "rate_limited",
};

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}

export class ApiError extends Error {
  code: ApiErrorCode;
  status: number;
  retryAfterSeconds: number | null;

  constructor(code: ApiErrorCode, message: string, status?: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status ?? defaultStatusByCode[code];
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function apiError(code: ApiErrorCode, message: string, status?: number): ApiError {
  return new ApiError(code, message, status);
}

export function rateLimitedError(message: string, retryAfterSeconds: number): ApiError {
  return new ApiError("rate_limited", message, 429, Math.max(1, Math.ceil(retryAfterSeconds)));
}

export function apiErrorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export interface ApiFailure {
  code: ApiErrorCode;
  message: string;
  status: number;
  retryAfterSeconds: number | null;
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && (apiErrorCodes as readonly string[]).includes(value);
}

/**
 * 把任意异常收敛成契约错误体。
 * AuthError 这类「带 status 的 Error」用鸭子类型识别，避免 lib/api-v1 反向依赖 lib/auth。
 */
export function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }

  if (error instanceof ZodError) {
    const message = error.issues.map((issue) => issue.message).join("; ");
    return { code: "validation_error", message: message || "请求参数不正确", status: 400, retryAfterSeconds: null };
  }

  if (error instanceof Error) {
    const raw = error as Error & { status?: unknown; code?: unknown };
    const status = typeof raw.status === "number" ? raw.status : 500;
    const code = isApiErrorCode(raw.code) ? raw.code : codeByStatus[status] ?? (status >= 500 ? "server_error" : "forbidden");
    return { code, message: error.message || "服务器处理失败", status, retryAfterSeconds: null };
  }

  return { code: "server_error", message: "服务器处理失败", status: 500, retryAfterSeconds: null };
}

export function apiErrorResponse(error: unknown): NextResponse {
  const failure = toApiFailure(error);
  const headers: Record<string, string> = {};
  if (failure.retryAfterSeconds !== null) {
    headers["Retry-After"] = String(failure.retryAfterSeconds);
  }
  return NextResponse.json(apiErrorBody(failure.code, failure.message), {
    status: failure.status,
    headers,
  });
}

export type ApiRouteContext<P = Record<string, never>> = { params: Promise<P> };

/** 统一包一层：路由里只管抛错，错误体与状态码在这里落地。 */
export function withApiHandler<P = Record<string, never>>(
  handler: (request: NextRequest, context: ApiRouteContext<P>) => Promise<Response>,
): (request: NextRequest, context: ApiRouteContext<P>) => Promise<Response> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      return apiErrorResponse(error);
    }
  };
}

/** 请求体不是合法 JSON 时给出契约里的 validation_error，而不是 500。 */
export async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw apiError("validation_error", "请求体必须是合法 JSON");
  }
}

export interface ResolveOriginInput {
  forwardedProto: string | null;
  forwardedHost: string | null;
  host: string | null;
  fallbackOrigin: string;
}

/** 反代后面的真实外部地址：优先 x-forwarded-proto/host，缺省退回 nextUrl.origin。 */
export function resolveOrigin(input: ResolveOriginInput): string {
  const host = firstHeaderValue(input.forwardedHost) ?? firstHeaderValue(input.host);
  if (!host) {
    return input.fallbackOrigin.replace(/\/+$/, "");
  }

  const forwardedProto = firstHeaderValue(input.forwardedProto);
  const fallbackProto = input.fallbackOrigin.startsWith("https://") ? "https" : "http";
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : fallbackProto;
  return `${proto}://${host}`;
}

export function resolveRequestOrigin(request: NextRequest): string {
  return resolveOrigin({
    forwardedProto: request.headers.get("x-forwarded-proto"),
    forwardedHost: request.headers.get("x-forwarded-host"),
    host: request.headers.get("host"),
    fallbackOrigin: request.nextUrl.origin,
  });
}

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first ? first : null;
}

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
}

export interface TokenBucketState {
  tokens: number;
  updatedAtMs: number;
}

export interface TokenBucketResult {
  allowed: boolean;
  state: TokenBucketState;
  retryAfterSeconds: number;
}

/** 每把密钥 60 请求/分钟：桶容量 60，按 1 个/秒匀速回填。 */
export const apiKeyRateLimit: TokenBucketOptions = { capacity: 60, refillPerSecond: 1 };

export function consumeToken(
  state: TokenBucketState | undefined,
  options: TokenBucketOptions,
  nowMs: number,
): TokenBucketResult {
  const previous = state ?? { tokens: options.capacity, updatedAtMs: nowMs };
  const elapsedSeconds = Math.max(0, (nowMs - previous.updatedAtMs) / 1000);
  const tokens = Math.min(options.capacity, previous.tokens + elapsedSeconds * options.refillPerSecond);

  if (tokens >= 1) {
    return { allowed: true, state: { tokens: tokens - 1, updatedAtMs: nowMs }, retryAfterSeconds: 0 };
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((1 - tokens) / options.refillPerSecond));
  return { allowed: false, state: { tokens, updatedAtMs: nowMs }, retryAfterSeconds };
}

export interface ApiTaskImage {
  id: string;
  url: string;
  thumbnail_url: string;
  width: number;
  height: number;
}

export interface ApiTask {
  id: string;
  status: TaskStatus;
  progress_stage: TaskProgressStage;
  mode: GenerationMode;
  prompt: string;
  size: string;
  quality: string | null;
  n: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: { message: string } | null;
  images: ApiTaskImage[];
}

/** 与 lib/db 的 publicProgressStage 同一套口径：取消归 canceled，处理中兜底 generating。 */
export function apiProgressStage(row: Pick<GenerationTaskRow, "status" | "progress_stage" | "error_message">): TaskProgressStage {
  if (row.status === "queued") {
    return "queued";
  }
  if (row.status === "succeeded") {
    return "completed";
  }
  if (row.status === "failed") {
    return row.progress_stage === "canceled" || row.error_message === "用户已停止生成" ? "canceled" : "failed";
  }
  if (row.progress_stage === "requesting" || row.progress_stage === "generating" || row.progress_stage === "saving") {
    return row.progress_stage;
  }
  return "generating";
}

export function toApiTask(
  row: GenerationTaskRow,
  images: GeneratedImageRow[],
  buildImageUrl: (filePath: string, thumb: boolean) => string,
): ApiTask {
  return {
    id: row.id,
    status: row.status,
    progress_stage: apiProgressStage(row),
    mode: row.mode,
    prompt: row.prompt,
    size: row.size,
    quality: row.quality,
    n: row.quantity,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error: row.status === "failed" ? { message: row.error_message ?? "生成失败" } : null,
    images: images.map((image) => ({
      id: image.id,
      url: buildImageUrl(image.file_path, false),
      thumbnail_url: buildImageUrl(image.file_path, true),
      width: image.width,
      height: image.height,
    })),
  };
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed";
}

/** wait=true 时服务端最多阻塞 240 秒，每 1.5 秒回查一次。 */
export const waitTimeoutMs = 240_000;
export const waitPollIntervalMs = 1_500;
