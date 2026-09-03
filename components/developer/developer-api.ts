/** 开放 API 密钥页用到的契约类型与请求封装（后端合入前先在前端声明字段）。 */
export type DeveloperApiKeyStatus = "active" | "revoked";

export interface DeveloperApiKey {
  id: string;
  name: string;
  prefix: string;
  status: DeveloperApiKeyStatus;
  lastUsedAt: string | null;
  requestCount: number;
  createdAt: string;
}

export interface DeveloperApiKeyListResponse {
  keys: DeveloperApiKey[];
}

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

export interface CreateApiKeyResponse {
  key: CreatedApiKey;
  secret: string;
}

export interface RevokeApiKeyResponse {
  ok: boolean;
}

export const maxActiveApiKeys = 5;
export const apiKeyNameMaxLength = 40;

export const apiKeyStatusLabels: Record<DeveloperApiKeyStatus, string> = {
  active: "生效中",
  revoked: "已撤销",
};

export function countActiveKeys(keys: readonly DeveloperApiKey[]): number {
  return keys.filter((key) => key.status === "active").length;
}

/** 返回 null 表示名称合法，否则返回给用户看的中文提示。 */
export function validateKeyName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return "请先给密钥起个名字，方便日后区分用途。";
  }
  if (trimmed.length > apiKeyNameMaxLength) {
    return `密钥名称最多 ${apiKeyNameMaxLength} 个字符。`;
  }
  return null;
}

/**
 * 站内接口返回 { error: "文案" }，开放 API 返回 { error: { code, message } }，
 * 密钥页两种都可能碰上，统一抽出一句能直接展示的中文。
 */
export function errorMessageFromPayload(payload: unknown, status: number): string {
  const fallback = `请求失败：${status}`;
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) {
      return code;
    }
  }

  return fallback;
}

export async function requestDeveloperJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as unknown;
    throw new Error(errorMessageFromPayload(payload, response.status));
  }

  return response.json() as Promise<T>;
}
