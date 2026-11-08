import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const workspace = mkdtempSync(path.join(tmpdir(), "prompt-optimizer-routing-"));
process.env.DATABASE_URL = path.join(workspace, "app.db");
process.env.IMAGE_STORAGE_DIR = path.join(workspace, "images");
process.env.SUB2API_HOST_HEADER = "s2a.example.test";

let db: typeof import("../lib/db");
let optimize: typeof import("../lib/prompt-optimizer");
let server: http.Server;
let baseUrl = "";
const calls: Array<{ path: string; authorization?: string; host?: string; model: string }> = [];

before(async () => {
  db = await import("../lib/db");
  optimize = await import("../lib/prompt-optimizer");
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string };
      calls.push({ path: request.url ?? "", authorization: request.headers.authorization, host: request.headers.host, model: body.model });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output_text: JSON.stringify({ prompt: "优化后的编辑指令" }) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  calls.length = 0;
  db.setAppSetting("image_provider", "sub2api");
  db.setAppSetting("image_concurrency", "0");
  db.setAppSetting("prompt_optimizer_base_url", "");
  db.setAppSetting("prompt_optimizer_api_key", "");
  db.setAppSetting("prompt_optimizer_model", "text-test-model");
  db.saveImageProviderChannels([{ id: "image", name: "图片", enabled: true, priority: 1, baseUrl: `${baseUrl}/image/v1`, model: "image-test-model", apiKey: "image-fixture-key" }]);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.getDb().close();
  rmSync(workspace, { force: true, recursive: true });
});

test("独立文字接口使用自己的URL和Key，切换图片渠道也不改变优化路由", async () => {
  db.savePromptOptimizerConnection({ baseUrl: `${baseUrl}/text/v1/`, apiKey: "text-fixture-key" });
  assert.equal(await optimize.optimizePromptWithModel({ prompt: "把圆形改成绿色", mode: "image_to_image" }), "优化后的编辑指令");
  db.saveImageProviderChannels([{ id: "other-image", name: "其他图片", enabled: true, priority: 1, baseUrl: `${baseUrl}/other-image/v1`, model: "other-image-model", apiKey: "other-image-fixture-key" }]);
  await optimize.optimizePromptWithModel({ prompt: "一只橘猫" });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.path === "/text/v1/responses" && call.authorization === "Bearer text-fixture-key" && call.model === "text-test-model" && call.host === "s2a.example.test"));
  assert.equal(db.getRuntimeImageSettings().imageModel, "other-image-model");
  assert.equal(db.getImageConcurrencySetting(), 0);
});

test("独立文字接口不依赖图片OAuth账号", async () => {
  db.setAppSetting("image_provider", "openai_oauth");
  db.savePromptOptimizerConnection({ baseUrl: `${baseUrl}/text/v1`, apiKey: "text-fixture-key" });
  await optimize.optimizePromptWithModel({ prompt: "一只橘猫" });
  assert.equal(calls[0]?.path, "/text/v1/responses");
});

test("独立接口缺Key时拒绝保存且不向文字服务泄漏图片Key", async () => {
  assert.throws(() => db.savePromptOptimizerConnection({ baseUrl: `${baseUrl}/text/v1` }), /自己的 API Key/);
  assert.equal(db.getPromptOptimizerSettings().baseUrl, "");
  db.setAppSetting("prompt_optimizer_base_url", `${baseUrl}/text/v1`);
  await assert.rejects(optimize.optimizePromptWithModel({ prompt: "一只橘猫" }), /API Key 未配置/);
  assert.equal(calls.length, 0);
});

test("留空Key保存时保留原凭据，公开设置只返回已配置状态", () => {
  db.savePromptOptimizerConnection({ baseUrl: `${baseUrl}/text/v1`, apiKey: "text-fixture-key" });
  db.savePromptOptimizerConnection({ baseUrl: `${baseUrl}/text/v1`, apiKey: "" });
  assert.equal(db.getPromptOptimizerSettings().apiKey, "text-fixture-key");
  const settings = db.getPublicAdminSettings();
  assert.equal(settings.promptOptimizerBaseUrl, `${baseUrl}/text/v1`);
  assert.equal(settings.promptOptimizerApiKeyConfigured, true);
  assert.equal(JSON.stringify(settings).includes("text-fixture-key"), false);
});

test("独立URL留空时兼容原来的图片接口复用行为", async () => {
  db.savePromptOptimizerConnection({ baseUrl: `${baseUrl}/text/v1`, apiKey: "text-fixture-key" });
  db.savePromptOptimizerConnection({ baseUrl: "" });
  await optimize.optimizePromptWithModel({ prompt: "一只橘猫" });
  assert.equal(calls[0]?.path, "/image/v1/responses");
  assert.equal(calls[0]?.authorization, "Bearer image-fixture-key");
});
