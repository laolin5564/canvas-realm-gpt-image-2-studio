import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import zlib from "node:zlib";
import { appConfig } from "./config";
import { normalizeHttpHostHeader } from "./http-host";

/**
 * 真正带自定义 Host 头的 HTTP 请求。
 *
 * Node 25 / undici 7 的全局 fetch 会静默丢弃调用方传入的 Host 头（无论大小写），
 * 所以「baseUrl 写源站 IP + Host 写域名」这种直连源站的玩法用 fetch 根本发不出去。
 * 这里在需要覆盖 Host 时改用 node:http / node:https 自己发请求，其余情况原样走 fetch。
 *
 * 和 undici fetch 保持一致的三条约定：
 * - 传输层错误统一抛 `TypeError("fetch failed", { cause })`，原始的 ECONNREFUSED/ENOTFOUND
 *   （含源站 IP、端口）只放在 cause 里，不会进用户可见的 message；
 * - signal 触发时抛 signal.reason（TimeoutError / AbortError）；
 * - 服务端「先回 413/4xx 再断连」时，只要响应头已经到手就把响应交给调用方，
 *   而不是让随后的 EPIPE/ECONNRESET 把响应吞掉。
 */

export interface OriginFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  signal?: AbortSignal;
  /**
   * 大请求体是否带 `Expect: 100-continue`（先只发头，等网关点头再传正文）。
   * 不传就用 `ORIGIN_FETCH_EXPECT_CONTINUE`（默认关）：经 Cloudflare 的渠道对 Expect 的行为未经验证，
   * 万一被回 417 会直接杀掉备用渠道，所以只在确认网关支持后显式打开。
   */
  expectContinue?: boolean;
}

/**
 * 开了 Expect 开关时，请求体不小于这个体积才带 `Expect: 100-continue`。
 * nginx 会在收到请求头时就按 Content-Length 对照 client_max_body_size，超限直接回 413——
 * 此时正文还没发出去，既不白传十几 MB，也不会因为服务端带着未读数据关连接而触发 RST 把 413 冲掉。
 * 开关关着时不带 Expect，靠「响应头先到就以响应为准」兜住早断连的 413。
 */
export const expectContinueMinBytes = 1024 * 1024;
/** 网关不理会 Expect（不回 100 也不回最终响应）时，等这么久就照常把正文发出去。 */
export const expectContinueTimeoutMs = 1000;

export async function fetchWithOriginHost(
  url: string,
  init: OriginFetchInit = {},
  hostHeader?: string,
): Promise<Response> {
  const host = normalizeHttpHostHeader(hostHeader);
  if (!host) {
    return fetch(url, init);
  }

  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TypeError(`fetchWithOriginHost 仅支持 http/https：${target.protocol}`);
  }

  const { signal } = init;
  if (signal?.aborted) {
    throw signal.reason;
  }

  const payload = await serializeBody(init.body);
  if (signal?.aborted) {
    throw signal.reason;
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    if (key.toLowerCase() === "host") {
      continue;
    }
    headers[key] = value;
  }
  const expectContinueEnabled = init.expectContinue ?? appConfig.originFetchExpectContinue;
  const useExpectContinue =
    expectContinueEnabled && payload !== null && payload.buffer.byteLength >= expectContinueMinBytes;
  if (payload) {
    if (payload.contentType && !hasHeader(headers, "content-type")) {
      headers["Content-Type"] = payload.contentType;
    }
    headers["Content-Length"] = String(payload.buffer.byteLength);
    if (useExpectContinue) {
      headers.Expect = "100-continue";
    }
  }
  headers.Host = host;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let continueTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (continueTimer) {
        clearTimeout(continueTimer);
        continueTimer = null;
      }
      fn();
    };

    const requestOptions: https.RequestOptions = {
      method: init.method ?? "GET",
      headers,
    };
    if (target.protocol === "https:") {
      const servername = sniServerName(host);
      if (servername) {
        requestOptions.servername = servername;
      }
    }

    const transport = target.protocol === "https:" ? https : http;
    // 响应头一到就记下来：之后请求体写入再报 EPIPE/ECONNRESET，也要把这份响应交出去。
    let received: { response: http.IncomingMessage; chunks: Buffer[] } | null = null;

    const request = transport.request(target.href, requestOptions, (response) => {
      const chunks: Buffer[] = [];
      received = { response, chunks };
      let ended = false;

      const settleWith = (): void => {
        finish(() => {
          try {
            resolve(buildResponse(response, Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
          // 响应已经完整拿到，正文还没写完（服务端提前拒绝）就别再往外传了。
          if (!request.writableFinished) {
            request.destroy();
          }
        });
      };

      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        ended = true;
        settleWith();
      });
      response.on("error", (error) => {
        if (ended) {
          return;
        }
        // 非 2xx 的响应头本身就是明确答案（413 / 401 …），正文残缺只影响管理员详情，照样交出去。
        if (isDefinitiveStatus(response.statusCode)) {
          settleWith();
          return;
        }
        finish(() => reject(toNetworkError(error)));
      });
      response.on("close", () => {
        if (ended || settled) {
          return;
        }
        if (isDefinitiveStatus(response.statusCode)) {
          settleWith();
          return;
        }
        finish(() => reject(toNetworkError(new Error("响应在收完之前被断开"))));
      });
    });

    // 保持和 undici fetch 一致的拒绝语义：signal 触发时抛的是 signal.reason
    //（AbortSignal.timeout → DOMException TimeoutError；用户停止 → AbortError），
    // 上层的 isImageTimeoutError / isAbortError 都靠这个区分。
    function onAbort(): void {
      finish(() => {
        request.destroy();
        reject(signal?.reason);
      });
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    request.on("error", (error) => {
      if (received) {
        // 响应头已经到手：交给 response 的 end/close 去收尾（服务端先回 413 再关连接的典型路径）。
        return;
      }
      finish(() => reject(toNetworkError(error)));
    });

    if (!payload) {
      request.end();
      return;
    }
    if (!useExpectContinue) {
      request.end(payload.buffer);
      return;
    }

    let bodySent = false;
    const sendBody = (): void => {
      if (bodySent || settled) {
        return;
      }
      bodySent = true;
      if (continueTimer) {
        clearTimeout(continueTimer);
        continueTimer = null;
      }
      request.end(payload.buffer);
    };
    request.on("continue", sendBody);
    continueTimer = setTimeout(sendBody, expectContinueTimeoutMs);
    // 只发头，等 100 Continue（或超时兜底）再发正文。
    request.flushHeaders();
  });
}

interface SerializedBody {
  buffer: Buffer;
  contentType: string | null;
}

async function serializeBody(body: BodyInit | null | undefined): Promise<SerializedBody | null> {
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body === "string") {
    return { buffer: Buffer.from(body, "utf8"), contentType: "text/plain;charset=UTF-8" };
  }
  if (Buffer.isBuffer(body)) {
    return { buffer: body, contentType: null };
  }
  if (body instanceof Uint8Array) {
    return { buffer: Buffer.from(body.buffer, body.byteOffset, body.byteLength), contentType: null };
  }
  // FormData / Blob / URLSearchParams / ArrayBuffer / ReadableStream：
  // 借 Response 做序列化，multipart 的 boundary 和 Content-Type 都由它生成。
  // Content-Type 要在读 body 之前取：部分运行时消费完 body 后就不再保留这个头。
  const wrapped = new Response(body);
  const contentType = wrapped.headers.get("content-type");
  return {
    buffer: Buffer.from(await wrapped.arrayBuffer()),
    contentType,
  };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/** 响应头里的状态码已经是明确结论（非 2xx）：即便正文没收完也值得交给调用方。 */
function isDefinitiveStatus(status: number | undefined): boolean {
  return typeof status === "number" && status >= 300;
}

/**
 * 传输层错误包成和 undici 一样的 `TypeError("fetch failed")`：
 * 原始 message（`connect ECONNREFUSED 1.2.3.4:80`、`getaddrinfo ENOTFOUND …`）带着源站 IP 与端口，
 * 只能留在 cause 里给管理员详情用，不能落到用户可见的 error_message。
 */
export function toNetworkError(error: unknown): TypeError {
  if (error instanceof TypeError && error.message === "fetch failed") {
    return error;
  }
  return new TypeError("fetch failed", { cause: error });
}

/** SNI 只认主机名：去掉端口，IP 字面量不能当 servername。 */
export function sniServerName(host: string): string | null {
  const name = host.replace(/:[0-9]{1,5}$/, "");
  return name && !isIP(name) ? name : null;
}

const nullBodyStatuses = new Set([204, 205, 304]);

function buildResponse(response: http.IncomingMessage, rawBody: Buffer): Response {
  const status = response.statusCode ?? 0;
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  const encoding = headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  let body = rawBody;
  if (encoding && rawBody.byteLength > 0) {
    try {
      body = decodeBody(rawBody, encoding);
    } catch (error) {
      // 正文残缺（服务端提前断连）时解压必然失败：非 2xx 的响应保留原始字节，别把状态码也弄丢。
      if (!response.complete && status >= 300) {
        body = Buffer.alloc(0);
      } else {
        throw error;
      }
    }
    headers.delete("content-encoding");
    headers.delete("content-length");
  }

  const init: ResponseInit = { status, statusText: response.statusMessage ?? "", headers };
  if (nullBodyStatuses.has(status)) {
    return new Response(null, init);
  }
  return new Response(new Uint8Array(body), init);
}

function decodeBody(raw: Buffer, encoding: string): Buffer {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(raw);
    case "deflate":
      try {
        return zlib.inflateSync(raw);
      } catch {
        return zlib.inflateRawSync(raw);
      }
    case "br":
      return zlib.brotliDecompressSync(raw);
    case "identity":
      return raw;
    default:
      throw new Error(`不支持的响应编码：${encoding}`);
  }
}
