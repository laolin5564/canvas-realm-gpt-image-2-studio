/** 带上 HTTP 状态码的请求错误，方便调用方区分 401 / 5xx；沿用 Error.message 不影响老调用点。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/** AbortController 取消在途请求时抛的不是业务错误，调用方一律静默丢弃。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : (error as Error | null)?.name === "AbortError";
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(payload?.error || `请求失败：${response.status}`, response.status);
  }

  return response.json() as Promise<T>;
}

export async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("当前浏览器不允许自动复制，请手动复制。");
  }
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export const modeLabels = {
  text_to_image: "文生图",
  image_to_image: "图生图",
  edit_image: "图生图",
} as const;

export const statusLabels = {
  queued: "排队中",
  processing: "生成中",
  succeeded: "完成",
  failed: "失败",
} as const;

export const progressStageLabels = {
  queued: "排队中",
  requesting: "请求中",
  generating: "生成中",
  saving: "保存中",
  completed: "完成",
  failed: "失败",
  canceled: "已停止",
} as const;

export const categoryLabels = {
  use_case: "用途模板",
  platform: "平台模板",
  company: "公司模板",
} as const;
