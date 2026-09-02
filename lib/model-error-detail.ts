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
