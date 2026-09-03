import { isModelTimeoutMessage } from "./model-error";

// 上游返回的 HTTP 错误：带上 status，让调用方能区分「换个渠道也许能成」和「换几次都白搭」。
export class UpstreamImageError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "UpstreamImageError";
    this.status = status;
  }
}

// 参数错误 / 内容审核拒绝：换渠道也是同样的结果，直接终止更省时间和额度。
const nonRetryablePatterns =
  /(content[_\s-]?policy|content[_\s-]?filter|moderation|safety system|invalid[_\s-]?request|invalid[_\s-]?prompt|invalid parameter|unsupported|内容审核|内容政策|违规|涉及敏感|参数错误|不支持|缺少参考图|参考图压缩后仍超过|参考图无法解码|图片路径不合法)/i;

export function imageErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

/**
 * 判断一个上游错误值不值得重试 / 切换渠道。
 * 可重试：5xx、429、408、413、3xx、网络错误、超时。
 * 不可重试：其余 4xx、内容审核拒绝、参数错误。
 *
 * 413 是网关的请求体上限，属于渠道级配置（一个 nginx 默认 1m，另一个可能是 100m），
 * 同一份参考图换个渠道完全可能过，所以归入可换渠道；同渠道原样补发则由调用方避免。
 * 3xx 是源站主机块在做跳转（典型：80 端口的 http→https）——fetchWithOriginHost 不跟随重定向，
 * 这是该渠道自己的 baseUrl/Host 配置问题，换下一个渠道多半能过，同渠道补发则毫无意义。
 */
export function isRetryableImageError(error: unknown): boolean {
  if (error instanceof DOMException) {
    // AbortError 由调用方单独处理（任务被停止）；TimeoutError 属于超时，可以重试。
    return error.name === "TimeoutError";
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = imageErrorStatus(error);

  if (status !== null) {
    if (status === 408 || status === 413 || status === 429) {
      return true;
    }
    if (status >= 400 && status < 500) {
      return false;
    }
    return status >= 300;
  }

  if (isModelTimeoutMessage(message)) {
    return true;
  }
  if (nonRetryablePatterns.test(message)) {
    return false;
  }

  // 网络错误 / 未知错误：保持原有的换渠道行为。
  return true;
}
