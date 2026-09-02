import { appConfig } from "./config";

// 老林云侧偶发长时间不响应，超过这个时间就当作网络故障返回，避免请求线程被挂死。
const laolinyunRequestTimeoutMs = 15_000;

interface LaolinyunApiResponse {
  code?: number | string;
  msg?: string;
  data?: unknown;
  num?: unknown;
  generationCount?: unknown;
  generation_count?: unknown;
  ai_image_num?: unknown;
  privilege?: unknown;
  privileges?: unknown;
  temp?: unknown;
  time?: unknown;
  total_price?: unknown;
  token?: unknown;
  new?: unknown;
  sn?: unknown;
  login?: unknown;
}

interface LaolinyunUserInfo {
  createBy?: unknown;
  name?: unknown;
  nickname?: unknown;
  phone?: unknown;
  mail?: unknown;
}

interface LaolinyunRequestOptions {
  clientIp?: string;
  acceptedCodes?: number[];
  failureStatus?: number;
}

export interface LaolinyunAuthUser {
  externalId: string;
  displayName: string;
  secret: string;
  token: string | null;
  isNew?: boolean;
}

export interface LaolinyunQrCode {
  imageUrl: string;
  webCode: string;
}

export interface LaolinyunQrStatus {
  login: boolean;
  state: number | string;
  user?: LaolinyunAuthUser;
}

export interface LaolinyunAiImagePaymentOrder {
  qrCodeUrl: string;
  orderId: string;
  totalPriceFen: number;
  unitCount: number;
  generationCount: number;
}

export interface LaolinyunOrderStatus {
  complete: number;
  paid: boolean;
}

export interface LaolinyunActivationExchangeResult {
  generationCount: number;
}

export async function loginLaolinyunUser(
  input: { name: string; password: string },
  options: LaolinyunRequestOptions = {},
): Promise<LaolinyunAuthUser> {
  const payload = await requestLaolinyunUserApi({
    type: "login",
    name: input.name,
    password: input.password,
  }, { ...options, failureStatus: 401 });

  return toAuthUser(payload, input.name);
}

export async function getLaolinyunLoginQrCode(options: {
  inviteApikey?: string | null;
  inviteFun?: string | null;
  clientIp?: string;
} = {}): Promise<LaolinyunQrCode> {
  const params: Record<string, string> = { type: "get_login_qrcode" };
  if (options.inviteApikey) {
    params.invite_apikey = options.inviteApikey;
  }
  if (options.inviteFun) {
    params.invite_fun = options.inviteFun;
  }

  const payload = await requestLaolinyunUserApi(params, { clientIp: options.clientIp, failureStatus: 400 });
  const imageUrl = typeof payload.data === "string" ? payload.data.trim() : "";
  const webCode = typeof payload.sn === "string" || typeof payload.sn === "number" ? String(payload.sn).trim() : "";
  if (!imageUrl || !webCode) {
    throw new LaolinyunUserApiError("老林云二维码接口返回格式不正确", 502);
  }
  return { imageUrl, webCode };
}

export async function getLaolinyunLoginQrStatus(
  webCode: string,
  options: LaolinyunRequestOptions = {},
): Promise<LaolinyunQrStatus> {
  const payload = await requestLaolinyunUserApi({
    type: "get_login_qrcode_status",
    web_code: webCode,
  }, { ...options, failureStatus: 400 });
  const state = typeof payload.data === "string" || typeof payload.data === "number" ? payload.data : 0;
  const login = Number(payload.login) === 1 && typeof payload.data === "string" && payload.data.trim().length === 32;
  const user = login ? await toAuthUserWithRemoteInfo(payload, "微信扫码用户", options) : undefined;
  return {
    login,
    state,
    user,
  };
}

export async function createLaolinyunAiImagePaymentOrder(
  secret: string,
  unitCount: number,
  options: LaolinyunRequestOptions = {},
): Promise<LaolinyunAiImagePaymentOrder> {
  const normalizedUnitCount = Math.max(Math.trunc(unitCount), 1);
  const payload = await requestLaolinyunAppstoreApi({
    type: "get_pay_img",
    secret,
    fun_id: "128",
    time: "1",
    num: String(normalizedUnitCount),
    order_type: "chinaums",
  }, { ...options, failureStatus: 400 });
  const qrCodeUrl = typeof payload.data === "string" ? payload.data.trim() : "";
  const orderId = typeof payload.time === "string" || typeof payload.time === "number" ? String(payload.time).trim() : "";
  const returnedUnitCount = Math.max(readInteger(payload.num, normalizedUnitCount), 1);
  const totalPriceFen = readInteger(payload.total_price, returnedUnitCount * 100);
  if (!qrCodeUrl || !orderId) {
    throw new LaolinyunUserApiError("老林云支付接口返回格式不正确", 502);
  }
  return {
    qrCodeUrl,
    orderId,
    totalPriceFen,
    unitCount: returnedUnitCount,
    generationCount: returnedUnitCount * 10,
  };
}

export async function getLaolinyunOrderStatus(
  secret: string,
  orderId: string,
  options: LaolinyunRequestOptions = {},
): Promise<LaolinyunOrderStatus> {
  const payload = await requestLaolinyunAppstoreApi({
    type: "order_listener",
    secret,
    time: orderId,
  }, { ...options, acceptedCodes: [0, 1], failureStatus: 400 });
  const complete = readInteger(payload.data, 0);
  return {
    complete,
    paid: complete === 1,
  };
}

export async function exchangeLaolinyunActivationCode(
  secret: string,
  code: string,
  options: LaolinyunRequestOptions = {},
): Promise<LaolinyunActivationExchangeResult> {
  const payload = await requestLaolinyunUserApi({
    type: "exchange",
    secret,
    code,
  }, { ...options, failureStatus: 400 });
  return { generationCount: readAiImageGenerationCount(payload) };
}

export async function getLaolinyunUserBySecret(
  secret: string,
  options: LaolinyunRequestOptions = {},
): Promise<LaolinyunAuthUser> {
  const normalizedSecret = secret.trim();
  if (!/^[a-f0-9]{32}$/i.test(normalizedSecret)) {
    throw new LaolinyunUserApiError("授权参数不正确", 400);
  }
  const userInfo = await getLaolinyunUserInfo(normalizedSecret, options);
  const displayName = pickDisplayName(userInfo) || "老林云用户";
  return {
    externalId: normalizedSecret,
    displayName,
    secret: normalizedSecret,
    token: null,
  };
}

async function getLaolinyunUserInfo(secret: string, options: LaolinyunRequestOptions = {}): Promise<LaolinyunUserInfo | null> {
  const payload = await requestLaolinyunUserApi({
    type: "user_info",
    secret,
  }, { ...options, failureStatus: 400 });
  return payload.data && typeof payload.data === "object" ? (payload.data as LaolinyunUserInfo) : null;
}

async function toAuthUserWithRemoteInfo(
  payload: LaolinyunApiResponse,
  fallbackName: string,
  options: LaolinyunRequestOptions = {},
): Promise<LaolinyunAuthUser> {
  const authUser = toAuthUser(payload, fallbackName);
  const userInfo = await getLaolinyunUserInfo(authUser.secret, options).catch(() => null);
  const displayName = pickDisplayName(userInfo) || authUser.displayName;
  return { ...authUser, displayName };
}

async function requestLaolinyunUserApi(
  params: Record<string, string>,
  options: LaolinyunRequestOptions = {},
): Promise<LaolinyunApiResponse> {
  return requestLaolinyunApi(appConfig.laolinyunUserApiUrl, params, options);
}

async function requestLaolinyunAppstoreApi(
  params: Record<string, string>,
  options: LaolinyunRequestOptions = {},
): Promise<LaolinyunApiResponse> {
  return requestLaolinyunApi(appConfig.laolinyunAppstoreApiUrl, params, options);
}

async function requestLaolinyunApi(
  url: string,
  params: Record<string, string>,
  options: LaolinyunRequestOptions = {},
): Promise<LaolinyunApiResponse> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (options.clientIp && options.clientIp !== "unknown") {
    headers["X-Forwarded-For"] = options.clientIp;
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(laolinyunRequestTimeoutMs),
    });
    text = await response.text();
  } catch (error) {
    throw toLaolinyunNetworkError(error);
  }

  let payload: LaolinyunApiResponse | null = null;
  try {
    payload = JSON.parse(text) as LaolinyunApiResponse;
  } catch {
    // The upstream endpoint is expected to return JSON.
  }

  if (!response.ok) {
    throw new LaolinyunUserApiError(payload?.msg || `老林云用户接口请求失败：${response.status}`, response.status);
  }
  if (!payload) {
    throw new LaolinyunUserApiError("老林云用户接口返回格式不正确", 502);
  }
  const responseCode = Number(payload.code);
  const acceptedCodes = options.acceptedCodes ?? [1];
  if (!acceptedCodes.includes(responseCode) || (responseCode !== 1 && payload.msg)) {
    throw new LaolinyunUserApiError(payload.msg || "老林云用户认证失败", options.failureStatus ?? 400);
  }
  return payload;
}

function readInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function readAiImageGenerationCount(payload: LaolinyunApiResponse): number {
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
  const direct = readInteger(
    payload.generationCount ??
      payload.generation_count ??
      payload.ai_image_num ??
      data.generationCount ??
      data.generation_count ??
      data.ai_image_num ??
      data.num ??
      payload.num,
    0,
  );
  if (direct > 0) {
    return direct;
  }

  const privileges = [
    ...readArray(data.privilege),
    ...readArray(data.privileges),
    ...readArray(payload.privilege),
    ...readArray(payload.privileges),
    ...readArray(payload.temp),
  ];
  for (const item of privileges) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.privilege !== "ai_image" && record.name !== "ai_image") {
      continue;
    }
    const count = readInteger(record.generationCount ?? record.generation_count ?? record.num, 0);
    if (count > 0) {
      return count;
    }
  }
  return 0;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

class LaolinyunUserApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export { LaolinyunUserApiError };

// fetch 抛出的原生错误（超时/DNS/连接重置）统一转成中文可读错误。
export function toLaolinyunNetworkError(error: unknown): LaolinyunUserApiError {
  if (error instanceof LaolinyunUserApiError) {
    return error;
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new LaolinyunUserApiError("老林云接口响应超时，请稍后重试", 504);
  }
  return new LaolinyunUserApiError("老林云接口网络异常，请稍后重试", 502);
}

function toAuthUser(payload: LaolinyunApiResponse, fallbackName: string): LaolinyunAuthUser {
  const secret = typeof payload.data === "string" ? payload.data.trim() : "";
  if (!secret) {
    throw new Error("老林云用户接口未返回用户标识");
  }

  return {
    externalId: secret,
    displayName: normalizeDisplayName(fallbackName),
    secret,
    token: typeof payload.token === "string" && payload.token.trim() ? payload.token.trim() : null,
    isNew: Number(payload.new) === 1,
  };
}

function normalizeDisplayName(value: string): string {
  const trimmed = value.trim();
  return trimmed || "老林云用户";
}

function pickDisplayName(userInfo: LaolinyunUserInfo | null): string | null {
  if (!userInfo) {
    return null;
  }
  for (const key of ["name", "nickname", "createBy", "phone", "mail"] as const) {
    const value = userInfo[key];
    if (typeof value === "string" && value.trim()) {
      return decodeDisplayName(value.trim());
    }
  }
  return null;
}

function decodeDisplayName(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value;
  }
}
