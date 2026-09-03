import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import zlib from "node:zlib";
import { fetchWithOriginHost } from "@/lib/origin-fetch";

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let server: http.Server;
let baseUrl = "";
let lastRequest: CapturedRequest | null = null;

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    lastRequest = {
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body,
    };

    const url = request.url ?? "/";
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
        url: request.url,
        contentType: request.headers["content-type"] ?? null,
        bodyLength: body.byteLength,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("测试服务器没有拿到端口");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

  test("连接失败按原样抛出网络错误，而不是伪装成 DOMException", async () => {
    // 端口 1 基本不会有服务在听。
    let failure: unknown = null;
    try {
      await fetchWithOriginHost("http://127.0.0.1:1/echo", { method: "GET" }, "s2a.laolin.ai");
    } catch (error) {
      failure = error;
    }

    expect(failure instanceof Error).toBe(true);
    expect(failure instanceof DOMException).toBe(false);
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
