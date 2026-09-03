import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import zlib from "node:zlib";
import { normalizeHttpHostHeader } from "./http-host";

/**
 * 真正带自定义 Host 头的 HTTP 请求。
 *
 * Node 25 / undici 7 的全局 fetch 会静默丢弃调用方传入的 Host 头（无论大小写），
 * 所以「baseUrl 写源站 IP + Host 写域名」这种直连源站的玩法用 fetch 根本发不出去。
 * 这里在需要覆盖 Host 时改用 node:http / node:https 自己发请求，其余情况原样走 fetch。
 */

export interface OriginFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  signal?: AbortSignal;
}

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
  if (payload) {
    if (payload.contentType && !hasHeader(headers, "content-type")) {
      headers["Content-Type"] = payload.contentType;
    }
    headers["Content-Length"] = String(payload.buffer.byteLength);
  }
  headers.Host = host;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
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
    const request = transport.request(target.href, requestOptions, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("error", (error) => {
        finish(() => reject(error));
      });
      response.on("end", () => {
        finish(() => {
          try {
            resolve(buildResponse(response, Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
        });
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
      finish(() => reject(error));
    });

    if (payload) {
      request.end(payload.buffer);
    } else {
      request.end();
    }
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

/** SNI 只认主机名：去掉端口，IP 字面量不能当 servername。 */
function sniServerName(host: string): string | null {
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
    body = decodeBody(rawBody, encoding);
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
