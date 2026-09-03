import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

// lib/db 依赖 node:sqlite，只能在 node:test 里跑；由 tests/db-data-billing.test.ts 桥接进 bun test。
const workspace = mkdtempSync(path.join(tmpdir(), "canvas-realm-api-v1-test-"));
process.env.DATABASE_URL = path.join(workspace, "app.db");
process.env.IMAGE_STORAGE_DIR = path.join(workspace, "images");
process.env.API_SIGNING_SECRET = "canvas-realm-test-signing-secret";

after(() => {
  rmSync(workspace, { force: true, recursive: true });
});

type DbModule = typeof import("../lib/db");
type AuthModule = typeof import("../lib/auth");
type ApiKeysModule = typeof import("../lib/api-keys");
type SignedUrlModule = typeof import("../lib/signed-url");

async function load(): Promise<{
  db: DbModule;
  auth: AuthModule;
  apiKeys: ApiKeysModule;
  signedUrl: SignedUrlModule;
}> {
  const [db, auth, apiKeys, signedUrl] = await Promise.all([
    import("../lib/db"),
    import("../lib/auth"),
    import("../lib/api-keys"),
    import("../lib/signed-url"),
  ]);
  return { db, auth, apiKeys, signedUrl };
}

let userSeq = 0;

async function createTestUser(name: string): Promise<{ id: string }> {
  const { db } = await load();
  userSeq += 1;
  return db.createUser({
    email: `api-${userSeq}@example.test`,
    name,
    passwordHash: "hash",
    role: "member",
    groupId: db.getDefaultGroup().id,
    monthlyQuota: 1000,
  });
}

async function bearerRequest(secret: string | null): Promise<InstanceType<typeof import("next/server").NextRequest>> {
  const { NextRequest } = await import("next/server");
  return new NextRequest("http://localhost:3000/api/v1/me", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : null;
}

function errorStatus(error: unknown): number | null {
  return error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : null;
}

test("自助密钥：只存哈希、展示前缀正确、撤销后立刻失效", async () => {
  const { db, apiKeys } = await load();
  const user = await createTestUser("密钥主人");
  const secret = apiKeys.generateApiKeySecret();

  const key = db.createUserApiKey({ userId: user.id, name: "线上验收", secret });
  assert.equal(key.name, "线上验收");
  assert.equal(key.status, "active");
  assert.equal(key.request_count, 0);
  assert.equal(key.last_used_at, null);
  assert.equal(key.key_prefix, apiKeys.apiKeyPrefix(secret));
  assert.equal(key.key_prefix.length, 7);
  assert.equal(key.key_hash, apiKeys.hashApiKeySecret(secret));
  assert.notEqual(key.key_hash, secret);

  assert.equal(db.getActiveUserApiKeyByHash(apiKeys.hashApiKeySecret(secret))?.id, key.id);
  assert.equal(db.listUserApiKeys(user.id).length, 1);
  assert.equal(db.toPublicUserApiKey(key).prefix, key.key_prefix);

  const revoked = db.revokeUserApiKey(key.id);
  assert.equal(revoked?.status, "revoked");
  assert.ok(revoked?.revoked_at);
  assert.equal(db.getActiveUserApiKeyByHash(apiKeys.hashApiKeySecret(secret)), null);
});

test("自助密钥：每个账号最多 5 把有效密钥，撤销后可以再建", async () => {
  const { db, apiKeys } = await load();
  const user = await createTestUser("密钥上限");

  const created = [];
  for (let index = 0; index < apiKeys.maxActiveApiKeysPerUser; index += 1) {
    created.push(db.createUserApiKey({ userId: user.id, name: `密钥 ${index}`, secret: apiKeys.generateApiKeySecret() }));
  }
  assert.equal(db.countActiveUserApiKeys(user.id), 5);

  assert.throws(
    () => db.createUserApiKey({ userId: user.id, name: "第六把", secret: apiKeys.generateApiKeySecret() }),
    (error: unknown) => errorStatus(error) === 403,
  );

  db.revokeUserApiKey(created[0].id);
  assert.equal(db.countActiveUserApiKeys(user.id), 4);
  db.createUserApiKey({ userId: user.id, name: "补位", secret: apiKeys.generateApiKeySecret() });
  assert.equal(db.countActiveUserApiKeys(user.id), 5);
});

test("Bearer 鉴权：有效密钥通过并记录用量，缺失/伪造/撤销一律 401", async () => {
  const { db, auth, apiKeys } = await load();
  const user = await createTestUser("Bearer 用户");
  const secret = apiKeys.generateApiKeySecret();
  const key = db.createUserApiKey({ userId: user.id, name: "Bearer", secret });

  const principal = auth.requireApiKeyUser(await bearerRequest(secret));
  assert.equal(principal.user.id, user.id);
  assert.equal(principal.keyId, key.id);

  const used = db.getUserApiKey(key.id);
  assert.equal(used?.request_count, 1);
  assert.ok(used?.last_used_at);

  await assert.rejects(
    async () => auth.requireApiKeyUser(await bearerRequest(null)),
    (error: unknown) => errorCode(error) === "unauthorized" && errorStatus(error) === 401,
  );
  await assert.rejects(
    async () => auth.requireApiKeyUser(await bearerRequest("hj_000000000000000000000000")),
    (error: unknown) => errorCode(error) === "unauthorized",
  );
  await assert.rejects(
    async () => auth.requireApiKeyUser(await bearerRequest("not-a-key")),
    (error: unknown) => errorCode(error) === "unauthorized",
  );

  db.revokeUserApiKey(key.id);
  await assert.rejects(
    async () => auth.requireApiKeyUser(await bearerRequest(secret)),
    (error: unknown) => errorCode(error) === "unauthorized",
  );
});

test("Bearer 鉴权：账号被禁用后密钥立刻失效", async () => {
  const { db, auth, apiKeys } = await load();
  const user = await createTestUser("待禁用");
  const secret = apiKeys.generateApiKeySecret();
  db.createUserApiKey({ userId: user.id, name: "禁用测试", secret });

  assert.equal(auth.requireApiKeyUser(await bearerRequest(secret)).user.id, user.id);

  db.updateUser(user.id, { status: "disabled" });
  await assert.rejects(
    async () => auth.requireApiKeyUser(await bearerRequest(secret)),
    (error: unknown) => errorCode(error) === "unauthorized" && errorStatus(error) === 401,
  );
});

test("站点设置 api_enabled=false 时开放 API 一律 403 api_disabled", async () => {
  const { db, auth } = await load();
  assert.equal(db.isApiEnabled(), true);
  assert.equal(db.getPublicSiteSettings().apiEnabled, true);
  auth.assertApiEnabled();

  db.setAppSetting("api_enabled", "false");
  try {
    assert.equal(db.isApiEnabled(), false);
    assert.equal(db.getPublicSiteSettings().apiEnabled, false);
    assert.equal(db.getPublicAdminSettings().apiEnabled, false);
    assert.throws(
      () => auth.assertApiEnabled(),
      (error: unknown) => errorCode(error) === "api_disabled" && errorStatus(error) === 403,
    );
  } finally {
    db.setAppSetting("api_enabled", "true");
  }
  assert.equal(db.isApiEnabled(), true);
});

test("source=api 的任务不建会话、不写会话消息，站内任务照旧挂会话", async () => {
  const { db } = await load();
  const user = await createTestUser("来源区分");

  const apiTask = db.createGenerationTask({
    userId: user.id,
    mode: "text_to_image",
    prompt: "开放 API 提交的任务",
    negativePrompt: null,
    size: "auto",
    quantity: 1,
    templateId: null,
    sourceImageId: null,
    referenceStrength: 0.6,
    styleStrength: 0.7,
    source: "api",
  });
  assert.equal(apiTask.source, "api");
  assert.equal(apiTask.conversation_id, null);
  assert.equal(db.listConversations({ userId: user.id, isAdmin: false }).length, 0);

  const webTask = db.createGenerationTask({
    userId: user.id,
    mode: "text_to_image",
    prompt: "工作台提交的任务",
    negativePrompt: null,
    size: "auto",
    quantity: 1,
    templateId: null,
    sourceImageId: null,
    referenceStrength: 0.6,
    styleStrength: 0.7,
  });
  assert.equal(webTask.source, "web");
  assert.ok(webTask.conversation_id);
  assert.equal(db.listConversationMessages(webTask.conversation_id ?? "").length, 1);

  // 出图照常落 generated_images，历史页仍然看得到 API 任务的图。
  const image = db.createGeneratedImage({
    taskId: apiTask.id,
    filePath: "2026/09/03/api/img.png",
    width: 1024,
    height: 1024,
    prompt: apiTask.prompt,
    mode: "text_to_image",
    templateId: null,
  });
  assert.equal(db.getTaskImages(apiTask.id)[0]?.id, image.id);

  const apiTasks = db.listApiGenerationTasks(user.id, 20);
  assert.equal(apiTasks.length, 1);
  assert.equal(apiTasks[0].id, apiTask.id);
});

test("活跃任务上限：queued/processing 的 API 任务计入，终态不计", async () => {
  const { db } = await load();
  const user = await createTestUser("活跃上限");

  const tasks = [];
  for (let index = 0; index < 5; index += 1) {
    tasks.push(
      db.createGenerationTask({
        userId: user.id,
        mode: "text_to_image",
        prompt: `并发任务 ${index}`,
        negativePrompt: null,
        size: "auto",
        quantity: 1,
        templateId: null,
        sourceImageId: null,
        referenceStrength: 0.6,
        styleStrength: 0.7,
        source: "api",
      }),
    );
  }
  assert.equal(db.countActiveApiTasks(user.id), 5);

  db.cancelGenerationTask(tasks[0].id);
  assert.equal(db.countActiveApiTasks(user.id), 4);

  // 工作台任务不占开放 API 的并发名额。
  db.createGenerationTask({
    userId: user.id,
    mode: "text_to_image",
    prompt: "工作台任务",
    negativePrompt: null,
    size: "auto",
    quantity: 1,
    templateId: null,
    sourceImageId: null,
    referenceStrength: 0.6,
    styleStrength: 0.7,
  });
  assert.equal(db.countActiveApiTasks(user.id), 4);
});

test("签名 URL：用 getApiSigningSecret 签出来的链接能验回去，改路径或过期即失效", async () => {
  const { db, signedUrl } = await load();
  const secret = db.getApiSigningSecret();
  assert.equal(secret, "canvas-realm-test-signing-secret");

  const filePath = "2026/09/03/task_sign/img_sign.png";
  const expUnix = signedUrl.signedUrlExpiry();
  const url = signedUrl.signedFileUrl({ origin: "https://img.example.com", filePath, secret, expUnix });
  const parsed = new URL(url);
  const sig = parsed.searchParams.get("sig");

  assert.equal(signedUrl.verifyFilePath({ filePath, sig, exp: expUnix, secret }), true);
  assert.equal(signedUrl.verifyFilePath({ filePath: `${filePath}.thumb.webp`, sig, exp: expUnix, secret }), false);
  assert.equal(signedUrl.verifyFilePath({ filePath, sig, exp: expUnix - 1, secret }), false);
  assert.equal(
    signedUrl.verifyFilePath({ filePath, sig, exp: expUnix, secret, nowMs: expUnix * 1000 + 1 }),
    false,
  );
});

test("没配 API_SIGNING_SECRET 时会在 app_settings 里生成一次并复用", async () => {
  const { db } = await load();
  const original = process.env.API_SIGNING_SECRET;
  delete process.env.API_SIGNING_SECRET;
  try {
    assert.equal(db.getAppSetting("api_signing_secret"), null);
    const generated = db.getApiSigningSecret();
    assert.ok(generated.length >= 32);
    assert.equal(db.getApiSigningSecret(), generated);
    assert.equal(db.getAppSetting("api_signing_secret"), generated);
  } finally {
    process.env.API_SIGNING_SECRET = original;
  }
});

test("toApiImageData：response_format=b64_json 时从磁盘读原图编码", async () => {
  const { db } = await load();
  const server = await import("../lib/api-v1-server");
  const { mkdirSync, writeFileSync } = await import("node:fs");

  const user = await createTestUser("b64 用户");
  const task = db.createGenerationTask({
    userId: user.id,
    mode: "text_to_image",
    prompt: "b64 编码验证",
    negativePrompt: null,
    size: "auto",
    quantity: 1,
    templateId: null,
    sourceImageId: null,
    referenceStrength: 0.6,
    styleStrength: 0.7,
    source: "api",
  });

  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const relative = `2026/09/03/${task.id}/img_b64.png`;
  const absolute = path.resolve(process.env.IMAGE_STORAGE_DIR ?? "data/images", relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, Buffer.from(pngBase64, "base64"));

  const image = db.createGeneratedImage({
    taskId: task.id,
    filePath: relative,
    width: 1,
    height: 1,
    prompt: task.prompt,
    mode: "text_to_image",
    templateId: null,
  });

  const buildUrl = (filePath: string, thumb: boolean) => `https://example.test/${filePath}${thumb ? "?thumb=1" : ""}`;
  const urlOnly = await server.toApiImageData([image], buildUrl, "url");
  assert.equal(urlOnly.length, 1);
  assert.equal(urlOnly[0].id, image.id);
  assert.equal(urlOnly[0].b64_json, undefined);

  const withBase64 = await server.toApiImageData([image], buildUrl, "b64_json");
  assert.equal(withBase64[0].b64_json, pngBase64);
});

test("requireOwnApiTask：别人的任务与不存在的任务都归 not_found", async () => {
  const { db } = await load();
  const server = await import("../lib/api-v1-server");
  const owner = await createTestUser("任务主人");
  const outsider = await createTestUser("路人");

  const task = db.createGenerationTask({
    userId: owner.id,
    mode: "text_to_image",
    prompt: "归属校验",
    negativePrompt: null,
    size: "auto",
    quantity: 1,
    templateId: null,
    sourceImageId: null,
    referenceStrength: 0.6,
    styleStrength: 0.7,
    source: "api",
  });

  assert.equal(server.requireOwnApiTask(owner.id, task.id).id, task.id);
  assert.throws(
    () => server.requireOwnApiTask(outsider.id, task.id),
    (error: unknown) => errorCode(error) === "not_found" && errorStatus(error) === 404,
  );
  assert.throws(
    () => server.requireOwnApiTask(owner.id, "task_missing"),
    (error: unknown) => errorCode(error) === "not_found",
  );
});

test("createImageUrlBuilder：按 x-forwarded 头拼绝对地址并签名", async () => {
  const server = await import("../lib/api-v1-server");
  const { signedUrl } = await load();
  const { NextRequest } = await import("next/server");

  const request = new NextRequest("http://127.0.0.1:3000/api/v1/tasks", {
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "img.example.com", host: "127.0.0.1:3000" },
  });
  const buildUrl = server.createImageUrlBuilder(request);
  const filePath = "2026/09/03/task_url/img_url.png";
  const url = buildUrl(filePath, false);
  const thumbUrl = buildUrl(filePath, true);

  assert.ok(url.startsWith("https://img.example.com/api/files/2026/09/03/task_url/img_url.png?"));
  assert.ok(thumbUrl.includes("thumb=1"));

  const parsed = new URL(url);
  assert.equal(
    signedUrl.verifyFilePath({
      filePath,
      sig: parsed.searchParams.get("sig"),
      exp: parsed.searchParams.get("exp"),
      secret: "canvas-realm-test-signing-secret",
    }),
    true,
  );
});

test("assertApiActiveTaskLimit / assertApiQuota 抛的是契约里的 code", async () => {
  const { db } = await load();
  const server = await import("../lib/api-v1-server");
  const user = await createTestUser("闸门用户");

  server.assertApiActiveTaskLimit(user.id);
  for (let index = 0; index < server.maxActiveApiTasksPerUser; index += 1) {
    db.createGenerationTask({
      userId: user.id,
      mode: "text_to_image",
      prompt: `闸门 ${index}`,
      negativePrompt: null,
      size: "auto",
      quantity: 1,
      templateId: null,
      sourceImageId: null,
      referenceStrength: 0.6,
      styleStrength: 0.7,
      source: "api",
    });
  }
  assert.throws(
    () => server.assertApiActiveTaskLimit(user.id),
    (error: unknown) => errorCode(error) === "too_many_active_tasks" && errorStatus(error) === 429,
  );

  const quotaUser = await createTestUser("额度用户");
  db.updateUser(quotaUser.id, { monthlyQuota: 1 });
  const current = db.getUserById(quotaUser.id);
  assert.ok(current);
  const asCurrentUser = {
    id: quotaUser.id,
    email: current.email,
    externalId: null,
    name: current.name,
    role: current.role,
    groupId: current.group_id,
    groupName: null,
  };
  server.assertApiQuota(asCurrentUser, 1);
  db.createGenerationTask({
    userId: quotaUser.id,
    mode: "text_to_image",
    prompt: "把额度用掉",
    negativePrompt: null,
    size: "auto",
    quantity: 1,
    templateId: null,
    sourceImageId: null,
    referenceStrength: 0.6,
    styleStrength: 0.7,
    source: "api",
  });
  assert.throws(
    () => server.assertApiQuota(asCurrentUser, 1),
    (error: unknown) => errorCode(error) === "quota_exceeded" && errorStatus(error) === 403,
  );
});

test("acquireApiKeyToken：同一把密钥每分钟只放行 60 次", async () => {
  const rateLimit = await import("../lib/rate-limit");
  rateLimit.resetApiKeyRateLimit();

  const keyId = "apikey_rate_limit_demo";
  const base = Date.UTC(2026, 8, 3, 0, 0, 0);
  let allowed = 0;
  for (let index = 0; index < 60; index += 1) {
    if (rateLimit.acquireApiKeyToken(keyId, base).allowed) {
      allowed += 1;
    }
  }
  assert.equal(allowed, 60);

  const blocked = rateLimit.acquireApiKeyToken(keyId, base);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(rateLimit.acquireApiKeyToken(keyId, base + 1_000).allowed, true);
  rateLimit.resetApiKeyRateLimit();
});

/* ---------------------------------------------------------------------------
 * 参考图上传入口：saveApiSourceImage(s) → 30MB 上限 → 魔数 → 归一化 → 落盘 webp/原格式 → 写真实宽高。
 * ------------------------------------------------------------------------- */

async function listStoredSourceFiles(): Promise<string[]> {
  const { readdirSync, existsSync } = await import("node:fs");
  const root = path.join(process.env.IMAGE_STORAGE_DIR as string, "source");
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.(png|jpg|jpeg|webp)$/.test(entry))
    .sort();
}

test("saveApiSourceImage：3000×1500 PNG 落盘为 .webp，入库宽高 2048×1024", async () => {
  const { default: sharp } = await import("sharp");
  const { db } = await load();
  const server = await import("../lib/api-v1-server");
  const user = await createTestUser("上传大图");
  const bytes = new Uint8Array(
    await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "#3366cc" } }).png().toBuffer(),
  );

  const id = await server.saveApiSourceImage({ userId: user.id, bytes, mimeType: "image/png", originalName: "wide.png" });
  const row = db.getSourceImage(id);
  assert.ok(row);
  assert.equal(row.user_id, user.id);
  assert.equal(row.width, 2048);
  assert.equal(row.height, 1024);
  assert.equal(row.mime_type, "image/webp");
  assert.equal(row.original_name, "wide.png");
  assert.match(row.file_path, /^source\/\d{4}\/\d{2}\/\d{2}\/src_[^/]+\.webp$/);

  const { readFileSync } = await import("node:fs");
  const stored = readFileSync(path.resolve(process.env.IMAGE_STORAGE_DIR as string, row.file_path));
  const meta = await sharp(stored).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 2048);
  assert.equal(meta.height, 1024);
});

test("saveApiSourceImage：640×480 PNG 直通，扩展名仍是 .png 且写真实宽高", async () => {
  const { default: sharp } = await import("sharp");
  const { db } = await load();
  const server = await import("../lib/api-v1-server");
  const user = await createTestUser("上传小图");
  const bytes = new Uint8Array(
    await sharp({ create: { width: 640, height: 480, channels: 3, background: "#cc6633" } }).png().toBuffer(),
  );

  const id = await server.saveApiSourceImage({ userId: user.id, bytes, mimeType: null, originalName: null });
  const row = db.getSourceImage(id);
  assert.ok(row);
  assert.equal(row.width, 640);
  assert.equal(row.height, 480);
  assert.equal(row.mime_type, "image/png");
  assert.match(row.file_path, /\.png$/);
  const { readFileSync } = await import("node:fs");
  const stored = readFileSync(path.resolve(process.env.IMAGE_STORAGE_DIR as string, row.file_path));
  assert.equal(Buffer.from(bytes).equals(stored), true);
});

test("saveApiSourceImage：超过 30MB → validation_error 400，文案含 30 MB", async () => {
  const server = await import("../lib/api-v1-server");
  const user = await createTestUser("上传超限");
  const bytes = new Uint8Array(30 * 1024 * 1024 + 1);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await assert.rejects(
    () => server.saveApiSourceImage({ userId: user.id, bytes, mimeType: "image/png", originalName: "huge.png" }),
    (error: unknown) =>
      errorCode(error) === "validation_error" &&
      errorStatus(error) === 400 &&
      (error as Error).message.includes("30 MB"),
  );
});

test("saveApiSourceImage：PNG 魔数 + 垃圾字节 → validation_error「图片文件损坏或无法解析」", async () => {
  const server = await import("../lib/api-v1-server");
  const user = await createTestUser("上传坏图");
  const junk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await assert.rejects(
    () => server.saveApiSourceImage({ userId: user.id, bytes: junk, mimeType: "image/png", originalName: null }),
    (error: unknown) =>
      errorCode(error) === "validation_error" &&
      errorStatus(error) === 400 &&
      (error as Error).message === "图片文件损坏或无法解析",
  );
});

test("saveApiSourceImages：多图两阶段——第二张校验失败时第一张也不落盘、不建记录", async () => {
  const { default: sharp } = await import("sharp");
  const server = await import("../lib/api-v1-server");
  const user = await createTestUser("上传多图");
  const good = new Uint8Array(
    await sharp({ create: { width: 320, height: 200, channels: 3, background: "#336633" } }).png().toBuffer(),
  );
  const junk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9, 9, 9, 9, 9]);

  const before = await listStoredSourceFiles();
  await assert.rejects(
    () =>
      server.saveApiSourceImages(user.id, [
        { bytes: good, mimeType: "image/png", originalName: "a.png" },
        { bytes: junk, mimeType: "image/png", originalName: "b.png" },
      ]),
    (error: unknown) => errorCode(error) === "validation_error",
  );
  assert.deepEqual(await listStoredSourceFiles(), before);

  const ids = await server.saveApiSourceImages(user.id, [
    { bytes: good, mimeType: "image/png", originalName: "a.png" },
    { bytes: good, mimeType: "image/png", originalName: "b.png" },
  ]);
  assert.equal(ids.length, 2);
  assert.equal((await listStoredSourceFiles()).length, before.length + 2);
});

test("storeSourceImages：落盘中途失败回滚已写文件与记录", async () => {
  const { default: sharp } = await import("sharp");
  const { db } = await load();
  const store = await import("../lib/source-image-store");
  const upload = await import("../lib/source-image-upload");
  const user = await createTestUser("上传回滚");
  const bytes = new Uint8Array(
    await sharp({ create: { width: 200, height: 100, channels: 3, background: "#999" } }).png().toBuffer(),
  );
  const first = await upload.prepareSourceImage({ bytes, mimeType: "image/png", originalName: "first.png" });
  // 第二张伪造成 storage 不认的类型，saveSourceImageFile 会在写盘前抛错。
  const broken = { ...first, mimeType: "image/gif" as unknown as typeof first.mimeType, originalName: "broken.gif" };

  const countRows = () =>
    Number((db.getDb().prepare("SELECT COUNT(*) AS n FROM source_images WHERE user_id = ?").get(user.id) as { n: number }).n);

  const before = await listStoredSourceFiles();
  assert.equal(countRows(), 0);
  await assert.rejects(() => store.storeSourceImages(user.id, [first, broken]));
  assert.deepEqual(await listStoredSourceFiles(), before);
  assert.equal(countRows(), 0);

  const [row] = await store.storeSourceImages(user.id, [first]);
  assert.equal(countRows(), 1);
  assert.equal(row.width, 200);
  assert.equal(row.height, 100);
});
