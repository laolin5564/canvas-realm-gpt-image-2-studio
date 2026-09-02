import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

// 同 tests/db-data-billing.node.ts：getDb 的「只初始化一次」标记是模块级的，
// 必须在首次 import lib/db 之前把库路径定好。
const workspace = mkdtempSync(path.join(tmpdir(), "canvas-realm-observability-test-"));
process.env.DATABASE_URL = path.join(workspace, "app.db");
process.env.IMAGE_STORAGE_DIR = path.join(workspace, "images");

after(() => {
  rmSync(workspace, { force: true, recursive: true });
});

type Db = typeof import("../lib/db");

let cachedDb: Db | null = null;

async function loadDb(): Promise<Db> {
  cachedDb ??= await import("../lib/db");
  return cachedDb;
}

let userSeq = 0;

async function createTestUser() {
  const db = await loadDb();
  userSeq += 1;
  return db.createUser({
    email: `observability-${userSeq}@example.test`,
    name: `遥测测试用户 ${userSeq}`,
    passwordHash: "scrypt:00:00",
    role: "member",
    groupId: null,
    monthlyQuota: null,
  });
}

async function queueTask(userId: string) {
  const db = await loadDb();
  return db.createGenerationTask({
    userId,
    conversationId: null,
    mode: "text_to_image",
    prompt: `遥测测试 ${Math.random().toString(36).slice(2, 8)}`,
    negativePrompt: null,
    size: "auto",
    quality: "high",
    quantity: 1,
    templateId: null,
    sourceImageId: null,
    referenceStrength: 0.6,
    styleStrength: 0.7,
    applyFixedPrompt: false,
  });
}

async function startTask(taskId: string): Promise<void> {
  const db = await loadDb();
  db.getDb()
    .prepare(
      "UPDATE generation_tasks SET status = 'processing', progress_stage = 'requesting', started_at = ? WHERE id = ?",
    )
    .run(new Date().toISOString(), taskId);
}

const adminDetail =
  "模型服务暂时不可用（502）：上游网关或模型服务返回错误。（HTTP 502｜上游原文：bad gateway id=7f2）";

test("markTaskFailed 把管理员详情落进 error_detail，用户文案不变", async () => {
  const db = await loadDb();
  const user = await createTestUser();
  const task = await queueTask(user.id);
  await startTask(task.id);

  db.markTaskFailed(task.id, "生成服务暂时不可用，请稍后重试。", adminDetail);

  const failed = db.getGenerationTask(task.id)!;
  assert.equal(failed.error_message, "生成服务暂时不可用，请稍后重试。");
  assert.equal(failed.error_detail, adminDetail);

  // 会话流里给用户看的仍然只有短文案，不含上游原文。
  assert.equal(failed.error_message!.includes("上游原文"), false);
});

test("toPublicTask 默认不下发 errorDetail，只有 includeErrorDetail 才带上", async () => {
  const db = await loadDb();
  const user = await createTestUser();
  const task = await queueTask(user.id);
  await startTask(task.id);
  db.markTaskFailed(task.id, "生成服务暂时不可用，请稍后重试。", adminDetail);
  const failed = db.getGenerationTask(task.id)!;

  const forMember = db.toPublicTask(failed, db.getTaskImages(task.id));
  assert.equal(forMember.errorDetail, null);
  assert.equal(forMember.errorMessage, "生成服务暂时不可用，请稍后重试。");

  const explicitlyOff = db.toPublicTask(failed, [], { includeErrorDetail: false });
  assert.equal(explicitlyOff.errorDetail, null);

  const forAdmin = db.toPublicTask(failed, db.getTaskImages(task.id), { includeErrorDetail: true });
  assert.equal(forAdmin.errorDetail, adminDetail);
  assert.equal(forAdmin.errorMessage, "生成服务暂时不可用，请稍后重试。");
});

test("markTaskFailed 不传详情时 error_detail 为空", async () => {
  const db = await loadDb();
  const user = await createTestUser();
  const task = await queueTask(user.id);
  await startTask(task.id);

  db.markTaskFailed(task.id, "生成任务处理失败");

  const failed = db.getGenerationTask(task.id)!;
  assert.equal(failed.error_detail, null);
  assert.equal(db.toPublicTask(failed, [], { includeErrorDetail: true }).errorDetail, null);
});

test("上游调用遥测按渠道聚合，窗口外的记录不参与统计", async () => {
  const db = await loadDb();
  const user = await createTestUser();
  const task = await queueTask(user.id);
  const now = Date.now();
  const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60 * 1000).toISOString();

  db.recordGenerationAttempt({
    taskId: task.id,
    channelId: "ch_main",
    channelName: "主渠道",
    statusCode: 200,
    ok: true,
    durationMs: 1200,
    errorMessage: null,
    startedAt: at(10),
  });
  db.recordGenerationAttempt({
    taskId: task.id,
    channelId: "ch_main",
    channelName: "主渠道",
    statusCode: 200,
    ok: true,
    durationMs: 800,
    errorMessage: null,
    startedAt: at(20),
  });
  db.recordGenerationAttempt({
    taskId: task.id,
    channelId: "ch_main",
    channelName: "主渠道",
    statusCode: 502,
    ok: false,
    durationMs: 2400,
    errorMessage: adminDetail,
    startedAt: at(30),
  });
  db.recordGenerationAttempt({
    taskId: task.id,
    channelId: "ch_backup",
    channelName: "备用渠道",
    statusCode: null,
    ok: false,
    durationMs: 300_000,
    errorMessage: "生成服务响应超时，请稍后重试。",
    startedAt: at(40),
  });
  // 48 小时前的记录：只应该出现在 7 天窗口里。
  db.recordGenerationAttempt({
    taskId: task.id,
    channelId: "ch_main",
    channelName: "主渠道",
    statusCode: 200,
    ok: true,
    durationMs: 100,
    errorMessage: null,
    startedAt: at(48 * 60),
  });

  const day = db.listRecentAttemptStats(24);
  const main = day.find((row) => row.channelId === "ch_main")!;
  assert.equal(main.total, 3);
  assert.equal(main.succeeded, 2);
  assert.equal(main.failed, 1);
  assert.equal(main.successRate, 66.7);
  assert.equal(main.p50DurationMs, 1200);
  assert.equal(main.p95DurationMs, 2400);
  // 上游原文被截掉，只留可归类的结论。
  assert.equal(main.topErrors.length, 1);
  assert.equal(main.topErrors[0].count, 1);
  assert.equal(main.topErrors[0].message.includes("上游原文"), false);
  assert.equal(main.topErrors[0].message.includes("模型服务暂时不可用（502）"), true);

  const backup = day.find((row) => row.channelId === "ch_backup")!;
  assert.equal(backup.total, 1);
  assert.equal(backup.successRate, 0);
  assert.equal(backup.p95DurationMs, 300_000);

  const week = db.listRecentAttemptStats(24 * 7);
  assert.equal(week.find((row) => row.channelId === "ch_main")!.total, 4);

  // 排序按请求数从多到少。
  assert.equal(day[0].channelId, "ch_main");
});

test("过期遥测会被清理，最近的记录保留", async () => {
  const db = await loadDb();
  const user = await createTestUser();
  const task = await queueTask(user.id);
  const stale = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  db.recordGenerationAttempt({
    taskId: task.id,
    channelId: "ch_stale",
    channelName: "老渠道",
    statusCode: 200,
    ok: true,
    durationMs: 100,
    errorMessage: null,
    startedAt: stale,
  });

  const pruned = db.pruneGenerationAttempts(30);
  assert.equal(pruned >= 1, true);

  const remaining = db
    .getDb()
    .prepare("SELECT COUNT(*) AS count FROM generation_attempts WHERE channel_id = ?")
    .get("ch_stale") as { count: number };
  assert.equal(remaining.count, 0);
  // 24 小时内的记录不受影响。
  assert.equal(db.listRecentAttemptStats(24).length > 0, true);
});

test("generation_attempts 建表与索引幂等，重复 getDb 不会重建", async () => {
  const db = await loadDb();
  const database = db.getDb();

  const indexes = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'generation_attempts' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  const names = indexes.map((row) => row.name);
  assert.equal(names.includes("idx_generation_attempts_task"), true);
  assert.equal(names.includes("idx_generation_attempts_started"), true);

  // error_detail 补列也在。
  const columns = database.prepare("PRAGMA table_info(generation_tasks)").all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === "error_detail"), true);

  const before = (
    database.prepare("SELECT COUNT(*) AS count FROM generation_attempts").get() as { count: number }
  ).count;
  db.getDb();
  db.getDb();
  const afterCount = (
    database.prepare("SELECT COUNT(*) AS count FROM generation_attempts").get() as { count: number }
  ).count;
  assert.equal(afterCount, before);
});
