import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { expectContinueMinBytes, fetchWithOriginHost, sniServerName } from "@/lib/origin-fetch";

// Node 独有的行为（SNI 真正发出去、Expect 等 100 Continue、写正文途中收到 413 后停笔）
// 在 tests/origin-fetch.node.ts 里用 node:test 覆盖：`node --import tsx --test tests/origin-fetch.node.ts`。

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let server: http.Server;
let baseUrl = "";
let lastRequest: CapturedRequest | null = null;
let tlsServer: https.Server;
let tlsBaseUrl = "";
// 服务端故意不读正文、不关连接的用例会留下挂着的 socket，收尾时统一销毁，别让 server.close() 干等。
const openSockets = new Set<Socket>();

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function attachRoutes(target: http.Server): void {
  target.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });

  target.on("checkContinue", (request, response) => {
    response.writeContinue();
    target.emit("request", request, response);
  });

  target.on("request", async (request, response) => {
    const url = request.url ?? "/";
    const body = await readBody(request);
    lastRequest = {
      method: request.method ?? "",
      url,
      headers: request.headers,
      body,
    };

    if (url.startsWith("/slow")) {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("late");
      }, 400);
      return;
    }
    if (url.startsWith("/gzip")) {
      const compressed = zlib.gzipSync(Buffer.from("压缩后的正文 hello gzip", "utf8"));
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": String(compressed.byteLength),
      });
      response.end(compressed);
      return;
    }
    if (url.startsWith("/br")) {
      const compressed = zlib.brotliCompressSync(Buffer.from("压缩后的正文 hello brotli", "utf8"));
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-encoding": "br",
        "content-length": String(compressed.byteLength),
      });
      response.end(compressed);
      return;
    }
    if (url.startsWith("/too-large")) {
      response.writeHead(413, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "request entity too large" }));
      return;
    }
    if (url.startsWith("/no-content")) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.startsWith("/redirect")) {
      response.writeHead(302, { location: `${baseUrl}/echo` });
      response.end("moved");
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        host: request.headers.host ?? null,
        method: request.method,
        url,
        contentType: request.headers["content-type"] ?? null,
        expect: request.headers.expect ?? null,
        bodyLength: body.byteLength,
        tls: target === tlsServer,
      }),
    );
  });
}

async function listen(target: http.Server): Promise<number> {
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
  const address = target.address();
  if (!address || typeof address === "string") {
    throw new Error("测试服务器没有拿到端口");
  }
  return address.port;
}

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "origin-tls");

/**
 * 「服务端提前 413 / 不读正文 / 中途断连」这类用例各自起一个一次性服务器：
 * bun 的 keep-alive 客户端会把写了一半正文的连接复用给下一个请求，共用服务器会串台成 400。
 */
async function withScratchServer(
  setup: (target: http.Server) => void,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const target = http.createServer();
  const sockets = new Set<Socket>();
  target.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  setup(target);
  const origin = `http://127.0.0.1:${await listen(target)}`;
  try {
    await run(origin);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
}
let previousTlsReject: string | undefined;

beforeAll(async () => {
  server = http.createServer();
  attachRoutes(server);
  baseUrl = `http://127.0.0.1:${await listen(server)}`;

  // 自签证书只在本测试文件里放行；生产线 cf_domain 渠道走的就是这条 https 分支。
  previousTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  tlsServer = https.createServer({
    key: readFileSync(path.join(fixtureDir, "key.pem")),
    cert: readFileSync(path.join(fixtureDir, "cert.pem")),
  });
  attachRoutes(tlsServer);
  tlsBaseUrl = `https://127.0.0.1:${await listen(tlsServer)}`;
});

afterAll(async () => {
  if (previousTlsReject === undefined) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsReject;
  }
  for (const socket of openSockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
});

describe("fetchWithOriginHost", () => {
  test("配置了 Host 时，服务端收到的 host 头就是配置值，路径与方法不变", async () => {
    const response = await fetchWithOriginHost(
      `${baseUrl}/v1/images/generations?x=1`,
      { method: "POST", headers: { Authorization: "Bearer test", Host: "should-be-overridden" }, body: "{}" },
      "s2a.laolin.ai",
    );

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { host: string; method: string; url: string };
    expect(payload.host).toBe("s2a.laolin.ai");
    expect(payload.method).toBe("POST");
    expect(payload.url).toBe("/v1/images/generations?x=1");
    expect(lastRequest?.headers.authorization).toBe("Bearer test");
    expect(lastRequest?.headers["accept-encoding"]).toBe(undefined);
  });

  test("FormData 多部分体完整到达：服务端能按 boundary 解析出文件字节与字段", async () => {
    const fileBytes = new Uint8Array(3000);
    for (let index = 0; index < fileBytes.length; index += 1) {
      fileBytes[index] = (index * 31 + 7) & 0xff;
    }
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", "把背景换成浅灰摄影棚");
    form.append("image", new Blob([fileBytes], { type: "image/png" }), "ref.png");

    const response = await fetchWithOriginHost(
      `${baseUrl}/v1/images/edits`,
      { method: "POST", headers: { Authorization: "Bearer test" }, body: form },
      "s2a.laolin.ai",
    );
    expect(response.status).toBe(200);

    const contentType = lastRequest?.headers["content-type"] ?? "";
    expect(contentType.startsWith("multipart/form-data; boundary=")).toBe(true);
    expect(lastRequest?.headers["content-length"]).toBe(String(lastRequest?.body.byteLength));

    const parsed = await new Response(new Uint8Array(lastRequest?.body ?? []), {
      headers: { "content-type": contentType },
    }).formData();
    expect(parsed.get("model")).toBe("gpt-image-2");
    expect(parsed.get("prompt")).toBe("把背景换成浅灰摄影棚");
    const file = parsed.get("image");
    expect(file instanceof Blob).toBe(true);
    expect((file as File).name).toBe("ref.png");
    expect((file as Blob).type).toBe("image/png");
    const received = new Uint8Array(await (file as Blob).arrayBuffer());
    expect(received.byteLength).toBe(fileBytes.byteLength);
    expect(Buffer.compare(Buffer.from(received), Buffer.from(fileBytes))).toBe(0);
  });

  test("JSON 体与 Content-Type 原样送达", async () => {
    const body = JSON.stringify({ model: "gpt-image-2", prompt: "一只橘猫", n: 1 });
    const response = await fetchWithOriginHost(
      `${baseUrl}/v1/images/generations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body,
      },
      "s2a.laolin.ai",
    );

    expect(response.ok).toBe(true);
    expect(lastRequest?.headers["content-type"]).toBe("application/json");
    expect(lastRequest?.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(lastRequest?.body.toString("utf8")).toBe(body);
  });

  test("没有配置 Host 时走原生 fetch：Host 就是 URL 里的 127.0.0.1:port", async () => {
    const response = await fetchWithOriginHost(`${baseUrl}/echo`, { method: "GET" });

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { host: string };
    expect(payload.host).toBe(new URL(baseUrl).host);
    expect(payload.host.startsWith("127.0.0.1:")).toBe(true);
  });

  test("AbortSignal.timeout 触发时 reject 的是 TimeoutError（DOMException）", async () => {
    let failure: unknown = null;
    try {
      await fetchWithOriginHost(
        `${baseUrl}/slow`,
        { method: "GET", signal: AbortSignal.timeout(50) },
        "s2a.laolin.ai",
      );
    } catch (error) {
      failure = error;
    }

    expect(failure instanceof DOMException).toBe(true);
    expect((failure as DOMException).name).toBe("TimeoutError");
  });

  test("手动 abort 时 reject 的是 AbortError", async () => {
    const controller = new AbortController();
    const pending = fetchWithOriginHost(
      `${baseUrl}/slow`,
      { method: "GET", signal: controller.signal },
      "s2a.laolin.ai",
    );
    setTimeout(() => controller.abort(), 30);

    let failure: unknown = null;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }

    expect(failure instanceof DOMException).toBe(true);
    expect((failure as DOMException).name).toBe("AbortError");
  });

  test("已经 abort 的 signal 直接以 signal.reason 拒绝", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("任务已停止", "AbortError"));

    let failure: unknown = null;
    try {
      await fetchWithOriginHost(`${baseUrl}/echo`, { signal: controller.signal }, "s2a.laolin.ai");
    } catch (error) {
      failure = error;
    }

    expect((failure as DOMException).name).toBe("AbortError");
    expect((failure as DOMException).message).toBe("任务已停止");
  });

  test("非 2xx 响应：ok=false、status 与 text() 正确", async () => {
    const response = await fetchWithOriginHost(
      `${baseUrl}/too-large`,
      { method: "POST", body: "x".repeat(10) },
      "s2a.laolin.ai",
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(JSON.stringify({ error: "request entity too large" }));
  });

  test("gzip 响应会被解压成正确文本", async () => {
    const response = await fetchWithOriginHost(`${baseUrl}/gzip`, { method: "GET" }, "s2a.laolin.ai");

    expect(response.ok).toBe(true);
    expect(response.headers.get("content-encoding")).toBe(null);
    expect(await response.text()).toBe("压缩后的正文 hello gzip");
  });

  test("br 响应会被解压成正确文本", async () => {
    const response = await fetchWithOriginHost(`${baseUrl}/br`, { method: "GET" }, "s2a.laolin.ai");

    expect(response.ok).toBe(true);
    expect(response.headers.get("content-encoding")).toBe(null);
    expect(await response.text()).toBe("压缩后的正文 hello brotli");
  });

  test("204 响应 body 为 null", async () => {
    const response = await fetchWithOriginHost(`${baseUrl}/no-content`, { method: "DELETE" }, "s2a.laolin.ai");

    expect(response.status).toBe(204);
    expect(response.body).toBe(null);
  });

  test("不跟随重定向", async () => {
    const response = await fetchWithOriginHost(`${baseUrl}/redirect`, { method: "GET" }, "s2a.laolin.ai");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${baseUrl}/echo`);
  });

  test("连接失败抛的是和 undici 一致的 TypeError('fetch failed')，源站 IP/端口只在 cause 里", async () => {
    // 端口 1 基本不会有服务在听。
    let failure: unknown = null;
    try {
      await fetchWithOriginHost("http://127.0.0.1:1/echo", { method: "GET" }, "s2a.laolin.ai");
    } catch (error) {
      failure = error;
    }

    expect(failure instanceof TypeError).toBe(true);
    expect(failure instanceof DOMException).toBe(false);
    expect((failure as Error).message).toBe("fetch failed");
    const cause = (failure as Error).cause as { code?: string; message?: string };
    expect(typeof cause?.code).toBe("string");
    expect(cause.code === "ECONNREFUSED" || cause.code === "ECONNRESET").toBe(true);
    // Node 的原文形如「connect ECONNREFUSED 127.0.0.1:1」（origin-fetch.node.ts 里断言），bun 只给 code。
    expect(typeof cause.message).toBe("string");
  });

  test("Expect 开关默认关：大请求体也不带 Expect 头，正文直接完整到达", async () => {
    const size = expectContinueMinBytes + 1024;
    const body = new Uint8Array(size);
    for (let index = 0; index < body.length; index += 4096) {
      body[index] = index & 0xff;
    }

    const response = await fetchWithOriginHost(`${baseUrl}/echo`, { method: "POST", body }, "s2a.laolin.ai");

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { expect: string | null; bodyLength: number };
    expect(payload.expect).toBe(null);
    expect(payload.bodyLength).toBe(size);
    expect(lastRequest?.headers["content-length"]).toBe(String(size));
    expect(Buffer.compare(lastRequest?.body ?? Buffer.alloc(0), Buffer.from(body))).toBe(0);
  });

  test("显式打开 Expect：大请求体带 Expect: 100-continue，网关点头后正文完整到达", async () => {
    const size = expectContinueMinBytes + 1024;
    const body = new Uint8Array(size);
    for (let index = 0; index < body.length; index += 4096) {
      body[index] = (index >> 3) & 0xff;
    }

    const response = await fetchWithOriginHost(
      `${baseUrl}/echo`,
      { method: "POST", body, expectContinue: true },
      "s2a.laolin.ai",
    );

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { expect: string | null; bodyLength: number };
    expect(payload.expect).toBe("100-continue");
    expect(payload.bodyLength).toBe(size);
    expect(Buffer.compare(lastRequest?.body ?? Buffer.alloc(0), Buffer.from(body))).toBe(0);
  });

  test("显式打开 Expect 但请求体小于 1MB：不带 Expect 头", async () => {
    const response = await fetchWithOriginHost(
      `${baseUrl}/echo`,
      { method: "POST", body: new Uint8Array(64 * 1024), expectContinue: true },
      "s2a.laolin.ai",
    );

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { expect: string | null; bodyLength: number };
    expect(payload.expect).toBe(null);
    expect(payload.bodyLength).toBe(64 * 1024);
  });

  test("显式打开 Expect：网关在收到请求头时就 413 并断连，拿到 413 响应", async () => {
    await withScratchServer(
      (target) => {
        // 模拟 nginx：请求头里的 Content-Length 超过 client_max_body_size，正文一个字节都不读直接 413。
        target.on("checkContinue", (request, response) => {
          response.writeHead(413, { "content-type": "application/json", connection: "close" });
          response.end(JSON.stringify({ error: "request entity too large" }));
          setTimeout(() => request.socket.destroy(), 30);
        });
      },
      async (origin) => {
        const response = await fetchWithOriginHost(
          `${origin}/reject-before-body`,
          { method: "POST", body: new Uint8Array(4 * 1024 * 1024), expectContinue: true },
          "s2a.laolin.ai",
        );

        expect(response.status).toBe(413);
        expect(await response.text()).toBe(JSON.stringify({ error: "request entity too large" }));
      },
    );
  });

  test("服务端先回 413 再不等正文收完就关连接：仍返回 413 响应", async () => {
    await withScratchServer(
      (target) => {
        // 服务端先回 413、随后不等正文收完就关连接：客户端这边写正文会吃到 EPIPE/ECONNRESET。
        target.on("request", (request, response) => {
          response.writeHead(413, { "content-type": "application/json", connection: "close" });
          response.end(JSON.stringify({ error: "too large, closing" }));
          setTimeout(() => request.socket.destroy(), 20);
        });
      },
      async (origin) => {
        const response = await fetchWithOriginHost(
          `${origin}/early-413`,
          { method: "POST", body: new Uint8Array(512 * 1024) },
          "s2a.laolin.ai",
        );

        expect(response.status).toBe(413);
        expect(await response.text()).toBe(JSON.stringify({ error: "too large, closing" }));
      },
    );
  });

  test("服务端回 413 但不读正文也不关连接：响应头一到就交出去，不等 16MB 正文写完", async () => {
    await withScratchServer(
      (target) => {
        target.on("request", (_request, response) => {
          response.writeHead(413, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "too large, not reading" }));
        });
      },
      async (origin) => {
        const startedAt = Date.now();
        const response = await fetchWithOriginHost(
          `${origin}/413-without-reading`,
          { method: "POST", body: new Uint8Array(16 * 1024 * 1024) },
          "s2a.laolin.ai",
        );

        expect(response.status).toBe(413);
        expect(await response.text()).toBe(JSON.stringify({ error: "too large, not reading" }));
        // 服务端永远不读正文：要是非得等正文写完才 resolve，这里会一直挂着直到测试超时。
        expect(Date.now() - startedAt < 5_000).toBe(true);
      },
    );
  });

  test("https 源站：Host 头与正文经 TLS 送达", async () => {
    const response = await fetchWithOriginHost(
      `${tlsBaseUrl}/v1/images/edits`,
      { method: "POST", headers: { Authorization: "Bearer test" }, body: "{}" },
      "example.test:8443",
    );

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { host: string; tls: boolean; url: string };
    expect(payload.host).toBe("example.test:8443");
    expect(payload.tls).toBe(true);
    expect(payload.url).toBe("/v1/images/edits");
  });

  test("非法 Host 值直接拒绝", async () => {
    let failure: unknown = null;
    try {
      await fetchWithOriginHost(`${baseUrl}/echo`, { method: "GET" }, "s2a.laolin.ai\r\nX-Test: injected");
    } catch (error) {
      failure = error;
    }

    expect(failure instanceof Error).toBe(true);
    expect((failure as Error).message.includes("SUB2API_HOST_HEADER")).toBe(true);
  });
});

describe("sniServerName", () => {
  test("域名去掉端口后作为 SNI", () => {
    expect(sniServerName("s2a.laolin.ai")).toBe("s2a.laolin.ai");
    expect(sniServerName("example.test:8443")).toBe("example.test");
  });

  test("IP 字面量不能当 SNI", () => {
    expect(sniServerName("10.0.0.1")).toBe(null);
    expect(sniServerName("69.63.221.194:443")).toBe(null);
  });
});
