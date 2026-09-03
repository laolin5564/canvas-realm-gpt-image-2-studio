// 生产跑的是 Node，这几条只有 Node 的 http/tls 客户端才能真正验证（bun 的 node:http 客户端
// 不发 SNI、不等 100 Continue、写正文的时机也不同）。运行方式：
//   node --import tsx --test tests/origin-fetch.node.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import path from "node:path";
import test, { after, before } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { fetchWithOriginHost } from "../lib/origin-fetch";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "origin-tls");
const openSockets = new Set<Socket>();

async function listen(target: http.Server): Promise<string> {
  target.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
  const address = target.address();
  if (!address || typeof address === "string") {
    throw new Error("测试服务器没有拿到端口");
  }
  return `127.0.0.1:${address.port}`;
}

function closeServer(target: http.Server): Promise<void> {
  return new Promise((resolve) => target.close(() => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let previousTlsReject: string | undefined;

before(() => {
  previousTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
});

after(() => {
  if (previousTlsReject === undefined) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsReject;
  }
  for (const socket of openSockets) {
    socket.destroy();
  }
});

test("https：SNI 用 Host 去掉端口后的主机名；IP 字面量不设 SNI；Host 头仍是配置值", async () => {
  const key = readFileSync(path.join(fixtureDir, "key.pem"));
  const cert = readFileSync(path.join(fixtureDir, "cert.pem"));
  const seen: Array<{ servername: string | false | null; host: string | null }> = [];
  const server = https.createServer(
    {
      key,
      cert,
      // 关掉会话复用：复用会话时不会再走 SNI 协商，servername 会读不到。
      sessionTimeout: 0,
      SNICallback: (_servername, callback) => callback(null, tls.createSecureContext({ key, cert })),
    },
    (request, response) => {
      const socket = request.socket as tls.TLSSocket;
      seen.push({ servername: socket.servername ?? null, host: request.headers.host ?? null });
      response.writeHead(200, { "content-type": "text/plain", connection: "close" });
      response.end("ok");
    },
  );
  const origin = `https://${await listen(server)}`;

  try {
    const withPort = await fetchWithOriginHost(`${origin}/v1`, { method: "POST", body: "{}" }, "example.test:8443");
    assert.equal(withPort.status, 200);
    const ipLiteral = await fetchWithOriginHost(`${origin}/v1`, { method: "POST", body: "{}" }, "69.63.221.194");
    assert.equal(ipLiteral.status, 200);
    const bare = await fetchWithOriginHost(`${origin}/v1`, { method: "GET" }, "example.test");
    assert.equal(bare.status, 200);

    assert.deepEqual(seen, [
      { servername: "example.test", host: "example.test:8443" },
      // Node 对没发 SNI 的连接把 servername 置为 false。
      { servername: false, host: "69.63.221.194" },
      { servername: "example.test", host: "example.test" },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("显式打开 Expect：网关在 100-continue 阶段就 413，正文一个字节都没发出去", async () => {
  let bodyBytesReceived = -1;
  const server = http.createServer();
  server.on("checkContinue", (request, response) => {
    let received = 0;
    request.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
    });
    response.writeHead(413, { "content-type": "text/plain", connection: "close" });
    response.end("too large");
    setTimeout(() => {
      bodyBytesReceived = received;
      request.socket.destroy();
    }, 30);
  });
  const origin = `http://${await listen(server)}`;

  try {
    const response = await fetchWithOriginHost(
      `${origin}/v1/images/edits`,
      { method: "POST", body: new Uint8Array(8 * 1024 * 1024), expectContinue: true },
      "s2a.laolin.ai",
    );
    assert.equal(response.status, 413);
    assert.equal(await response.text(), "too large");
    await sleep(80);
    assert.equal(bodyBytesReceived, 0);
  } finally {
    await closeServer(server);
  }
});

test("写正文途中收到 413（服务端不读正文、不关连接）：立刻以 413 resolve，并停止继续写正文", async () => {
  const total = 16 * 1024 * 1024;
  let received = 0;
  let serverSocketClosed = false;
  const server = http.createServer((request, response) => {
    request.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
    });
    request.socket.on("close", () => {
      serverSocketClosed = true;
    });
    // 不 resume 正文，只回 413，连接留着。
    response.writeHead(413, { "content-type": "text/plain" });
    response.end("too large");
  });
  server.keepAliveTimeout = 60_000;
  const origin = `http://${await listen(server)}`;

  try {
    const startedAt = Date.now();
    const response = await fetchWithOriginHost(
      `${origin}/v1/images/edits`,
      { method: "POST", body: new Uint8Array(total) },
      "s2a.laolin.ai",
    );
    assert.equal(response.status, 413);
    assert.equal(await response.text(), "too large");
    assert.ok(Date.now() - startedAt < 5_000, "不该等正文写完才拿到响应");

    // 响应到手后 request.destroy()：服务端这边连接随即关闭，正文远没传完。
    await sleep(200);
    assert.equal(serverSocketClosed, true);
    assert.ok(received < total, `正文不该被写完（已收 ${received} / ${total}）`);
  } finally {
    await closeServer(server);
  }
});

test("服务端先回 413、随后断连：拿到的是 413 响应而不是 EPIPE/ECONNRESET", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(413, { "content-type": "text/plain", connection: "close" });
    response.end("too large, closing");
    setTimeout(() => request.socket.destroy(), 20);
  });
  const origin = `http://${await listen(server)}`;

  try {
    const response = await fetchWithOriginHost(
      `${origin}/v1/images/edits`,
      { method: "POST", body: new Uint8Array(512 * 1024) },
      "s2a.laolin.ai",
    );
    assert.equal(response.status, 413);
    assert.equal(await response.text(), "too large, closing");
  } finally {
    await closeServer(server);
  }
});

test("连接被拒绝：抛 TypeError('fetch failed')，源站 IP/端口只在 cause 里", async () => {
  await assert.rejects(
    fetchWithOriginHost("http://127.0.0.1:1/v1", { method: "POST", body: "{}" }, "s2a.laolin.ai"),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, "fetch failed");
      const cause = error.cause as { code?: string; message?: string };
      assert.equal(cause.code, "ECONNREFUSED");
      assert.match(String(cause.message), /127\.0\.0\.1:1/);
      return true;
    },
  );
});
