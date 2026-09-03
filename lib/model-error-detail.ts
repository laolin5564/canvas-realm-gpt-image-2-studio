import { UpstreamImageError } from "./image-retry";

/**
 * 带管理员详情的上游错误。
 * error_message 落库的是面向用户的短文案，管理员想要的状态码 + 上游原文得靠 detail 一路带上来，
 * 否则错误传到 lib/queue 时只剩一句「生成服务暂时不可用」。
 * 继承 UpstreamImageError，isRetryableImageError / instanceof 判定完全不变。
 */
export class UpstreamImageDetailError extends UpstreamImageError {
  readonly detail: string;

  constructor(message: string, status: number, detail: string) {
    super(message, status);
    this.name = "UpstreamImageDetailError";
    this.detail = detail;
  }
}

/** 取出错误上挂的管理员详情；没有就返回 null（网络错误 / 超时等）。 */
export function modelErrorDetail(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const detail = (error as { detail?: unknown }).detail;
  return typeof detail === "string" && detail.trim() !== "" ? detail : null;
}

/** undici / fetchWithOriginHost 的传输层错误：message 固定是「fetch failed」，原因在 cause 里。 */
export function isFetchNetworkError(error: unknown): error is TypeError & { cause?: unknown } {
  return error instanceof TypeError && error.message === "fetch failed";
}

/**
 * 网络错误的用户文案与管理员详情。
 * cause 里的原文（`connect ECONNREFUSED 1.2.3.4:80`、`getaddrinfo ENOTFOUND …`）带着源站 IP 与端口，
 * 只进管理员看的 detail，用户只看到一句中文短文案。
 */
export function describeNetworkError(error: unknown): { message: string; detail: string } | null {
  if (!isFetchNetworkError(error)) {
    return null;
  }
  const cause = error.cause;
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  const causeText = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
  const parts = [typeof code === "string" && code !== "" ? code : null, causeText || null].filter(
    (part): part is string => part !== null,
  );
  return {
    message: "生成服务连接失败，请稍后重试；如果反复失败请联系管理员。",
    detail: `连接模型网关失败${parts.length > 0 ? `（${Array.from(new Set(parts)).join("｜")}）` : ""}：请检查渠道 Base URL、源站网络与 DNS 解析。`,
  };
}

/**
 * 任务失败落库前的文案拆分：error_message 给用户看，error_detail 只在管理员接口下发。
 * - 上游 HTTP 错误：message 已是 formatModelError 的中文短文案，detail 取错误上挂的管理员详情；
 * - 传输层错误（fetch failed）：message 换成中文短文案，ECONNREFUSED/ENOTFOUND 原文（含源站 IP、端口）只进 detail；
 * - 其他错误：原样。
 */
export function describeTaskFailure(error: unknown): { message: string; detail: string | null } {
  const network = describeNetworkError(error);
  const message = network?.message ?? (error instanceof Error ? error.message : "生成任务处理失败");
  const detail = modelErrorDetail(error) ?? network?.detail ?? null;
  return { message, detail };
}
