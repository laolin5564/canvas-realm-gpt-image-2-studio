import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

// 整个文件共用一个库：getDb 的「只初始化一次」标记是模块级的，必须在首次 import 之前定好路径。
const workspace = mkdtempSync(path.join(tmpdir(), "canvas-realm-db-billing-test-"));
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

async function createTestUser(monthlyQuota: number | null = null) {
  const db = await loadDb();
  userSeq += 1;
  return db.createUser({
    email: `billing-${userSeq}@example.test`,
    name: `计费测试用户 ${userSeq}`,
    passwordHash: "scrypt:00:00",
    role: "member",
    groupId: null,
    monthlyQuota,
  });
}

async function queueTask(userId: string, quantity: 1 | 2 | 4, conversationId?: string) {
  const db = await loadDb();
  return db.createGenerationTask({
    userId,
    conversationId: conversationId ?? null,
    mode: "text_to_image",
    prompt: `计费测试 ${Math.random().toString(36).slice(2, 8)}`,
    negativePrompt: null,
    size: "auto",
    quality: "high",
    quantity,
    templateId: null,
    sourceImageId: null,
    referenceStrength: 0.6,
    styleStrength: 0.7,
    applyFixedPrompt: false,
  });
}

/**
 * 把任务直接推进到 processing。
 * 不用 claimQueuedTasks 是因为它按全局队列顺序领取，会串到别的用例遗留的排队任务上。
 */
async function startTask(taskId: string): Promise<void> {
  const db = await loadDb();
  db.getDb()
    .prepare(
      "UPDATE generation_tasks SET status = 'processing', progress_stage = 'requesting', started_at = ? WHERE id = ?",
    )
    .run(new Date().toISOString(), taskId);
}

async function addImage(taskId: string, suffix: string) {
  const db = await loadDb();
  return db.createGeneratedImage({
    taskId,
    filePath: `${taskId}-${suffix}.png`,
    width: 1024,
    height: 1024,
    prompt: "计费测试",
    mode: "text_to_image",
    templateId: null,
  });
}

test("getDb 只在建连时初始化一次 schema", async () => {
  const db = await loadDb();
  const database = db.getDb();

  // 手动删掉一个索引和一条内置模板；如果 getDb() 每次都重跑 initializeSchema / seedTemplates，
  // 它们会被重新建出来。
  database.exec("DROP INDEX IF EXISTS idx_generated_images_task");
  const seeded = database.prepare("SELECT id FROM templates LIMIT 1").get() as { id: string } | undefined;
  assert.notEqual(seeded, undefined);
  database.prepare("DELETE FROM templates WHERE id = ?").run(seeded!.id);

  db.getDb();
  db.getDb();

  const index = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_generated_images_task'")
    .get();
  assert.equal(index, undefined);
  assert.equal(database.prepare("SELECT id FROM templates WHERE id = ?").get(seeded!.id), undefined);

  // 收拾干净，后面的用例仍跑在完整 schema 上。
  database.exec("CREATE INDEX IF NOT EXISTS idx_generated_images_task ON generated_images (task_id, created_at)");
});

test("建连后写入了 busy_timeout，双进程写冲突不会立刻 database is locked", async () => {
  const db = await loadDb();
  const row = db.getDb().prepare("PRAGMA busy_timeout").get() as { timeout: number };
  assert.equal(row.timeout, 5000);
});

test("补齐了 task_id / file_path 索引", async () => {
  const db = await loadDb();
  const names = (
    db.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
  ).map((row) => row.name);
  assert.equal(names.includes("idx_generated_images_task"), true);
  assert.equal(names.includes("idx_generated_images_file_path"), true);
  assert.equal(names.includes("idx_source_images_file_path"), true);
});

test("会话消息与任务取的是最新 N 条，并按时间升序返回", async () => {
  const db = await loadDb();
  const user = await createTestUser();
  const first = await queueTask(user.id, 1);
  const conversationId = first.conversation_id!;
  assert.notEqual(conversationId, null);

  const total = 105;
  for (let index = 1; index < total; index += 1) {
    await queueTask(user.id, 1, conversationId);
  }

  const tasks = db.listConversationTasks(conversationId);
  // 上限 100，且必须是最新的 100 个 —— 最早那条要被挤掉。
  assert.equal(tasks.length, 100);
  assert.equal(tasks.some((task) => task.id === first.id), false);

  const ascending = tasks.every(
    (task, index) => index === 0 || tasks[index - 1].created_at <= task.created_at,
  );
  assert.equal(ascending, true);

  const allTasks = db.getDb()
    .prepare("SELECT id FROM generation_tasks WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(conversationId) as { id: string };
  assert.equal(tasks.at(-1)!.id, allTasks.id);

  // 每个任务带出一条用户消息，再补一批把总数顶过 200 条上限。
  const oldest = db.listConversationMessages(conversationId)[0];
  for (let index = 0; index < 150; index += 1) {
    db.createConversationMessage({
      conversationId,
      role: "assistant",
      content: `补充消息 ${index}`,
      taskId: null,
      imageId: null,
    });
  }

  const messages = db.listConversationMessages(conversationId);
  assert.equal(messages.length, 200);
  assert.equal(messages.some((message) => message.id === oldest.id), false);
  assert.equal(messages.at(-1)!.content, "补充消息 149");
  const messagesAscending = messages.every(
    (message, index) => index === 0 || messages[index - 1].created_at <= message.created_at,
  );
  assert.equal(messagesAscending, true);
});

test("计费按实际出图张数，排队中的任务按 quantity 预占", async () => {
  const db = await loadDb();
  const user = await createTestUser(100);

  // 刚提交：还没出图，先按 quantity 预占，防止连续提交跑超额度。
  const pending = await queueTask(user.id, 4);
  assert.equal(db.getUserMonthImageUsage(user.id), 4);

  // 出了 2 张仍在跑：预占与已出图取 MAX，不会重复计。
  await startTask(pending.id);
  await addImage(pending.id, "a");
  await addImage(pending.id, "b");
  assert.equal(db.getUserMonthImageUsage(user.id), 4);

  // 取消：只按已经出的 2 张计费，剩下 2 张的预占释放。
  db.cancelGenerationTask(pending.id);
  assert.equal(db.getUserMonthImageUsage(user.id), 2);
  assert.equal(db.getTaskImages(pending.id).length, 2);

  // 一张都没出的失败任务不计费。
  const failing = await queueTask(user.id, 2);
  await startTask(failing.id);
  db.markTaskFailed(failing.id, "上游超时");
  assert.equal(db.getUserMonthImageUsage(user.id), 2);

  // 正常成功的任务按真实出图计费。
  const succeeded = await queueTask(user.id, 2);
  await startTask(succeeded.id);
  await addImage(succeeded.id, "a");
  await addImage(succeeded.id, "b");
  db.markTaskSucceeded(succeeded.id, 2);
  assert.equal(db.getUserMonthImageUsage(user.id), 4);

  assert.equal(db.getUserQuota(user.id).monthUsed, 4);
  assert.equal(db.getLocalAiImageQuota(user.id).remaining, 96);
});

test("删除会话不退还额度", async () => {
  const db = await loadDb();
  const user = await createTestUser(100);

  const task = await queueTask(user.id, 2);
  const conversationId = task.conversation_id!;
  await startTask(task.id);
  await addImage(task.id, "a");
  await addImage(task.id, "b");
  db.markTaskSucceeded(task.id, 2);
  assert.equal(db.getUserMonthImageUsage(user.id), 2);

  const deleted = db.deleteConversationWithGeneratedImages(conversationId);
  assert.equal(deleted.images.length, 2);

  // 图片行删了，但任务行留着且已用额度不变。
  assert.equal(db.getTaskImages(task.id).length, 0);
  assert.equal(db.getUserMonthImageUsage(user.id), 2);

  const orphan = db.getGenerationTask(task.id);
  assert.notEqual(orphan, null);
  assert.equal(orphan!.conversation_id, null);
  assert.equal(db.getConversation(conversationId), null);
  assert.equal(db.listConversationTasks(conversationId).length, 0);
});

test("保留期清理删图后同样不退额", async () => {
  const db = await loadDb();
  const user = await createTestUser(100);

  const task = await queueTask(user.id, 1);
  await startTask(task.id);
  const image = await addImage(task.id, "a");
  db.markTaskSucceeded(task.id, 1);
  assert.equal(db.getUserMonthImageUsage(user.id), 1);

  db.deleteGeneratedImagesByIds([image.id]);
  assert.equal(db.getUserMonthImageUsage(user.id), 1);
});

test("getTaskImagesByTaskIds 一次查出并按任务分组", async () => {
  const db = await loadDb();
  const user = await createTestUser();
  const withImages = await queueTask(user.id, 2);
  const withoutImages = await queueTask(user.id, 1);
  await addImage(withImages.id, "a");
  await addImage(withImages.id, "b");

  const grouped = db.getTaskImagesByTaskIds([withImages.id, withoutImages.id, "task_missing"]);
  assert.equal(grouped.get(withImages.id)!.length, 2);
  assert.equal(grouped.get(withoutImages.id)!.length, 0);
  assert.equal(grouped.get("task_missing")!.length, 0);
  assert.deepEqual(
    grouped.get(withImages.id)!.map((row) => row.id),
    db.getTaskImages(withImages.id).map((row) => row.id),
  );
  assert.equal(db.getTaskImagesByTaskIds([]).size, 0);
});

test("会话详情 ETag 随进度阶段变化", async () => {
  const db = await loadDb();
  const user = await createTestUser();
  const task = await queueTask(user.id, 1);
  const conversationId = task.conversation_id!;

  const snapshot = () => {
    const conversation = db.getConversation(conversationId)!;
    const messages = db.listConversationMessages(conversationId);
    const tasks = db.listConversationTasks(conversationId);
    const taskImages = db.getTaskImagesByTaskIds(tasks.map((row) => row.id));
    return db.conversationDetailEtag({ conversation, messages, tasks, taskImages });
  };

  const initial = snapshot();
  assert.equal(initial.startsWith('W/"conv-'), true);
  assert.equal(snapshot(), initial);

  await startTask(task.id);
  const afterClaim = snapshot();
  assert.notEqual(afterClaim, initial);

  // 只改 progress_stage、不动任何时间戳，ETag 仍要变，否则前端会卡在 304 上看不到进度。
  db.updateTaskProgressStage(task.id, "saving");
  assert.notEqual(snapshot(), afterClaim);
});

test("toPublicTask 输出 quality；取消任务的已出图仍然可见", async () => {
  const db = await loadDb();
  const user = await createTestUser();
  const task = await queueTask(user.id, 2);
  const conversationId = task.conversation_id!;

  await startTask(task.id);
  await addImage(task.id, "a");
  db.cancelGenerationTask(task.id);

  const canceled = db.getGenerationTask(task.id)!;
  const publicTask = db.toPublicTask(canceled, db.getTaskImages(task.id));
  assert.equal(publicTask.quality, "high");
  assert.equal(publicTask.progressStage, "canceled");
  assert.equal(publicTask.images!.length, 1);
  assert.equal(db.isCanceledTaskRow(canceled), true);
  assert.equal(db.isTaskStopped(task.id), true);

  const conversation = db.toPublicConversation(db.getConversation(conversationId)!, {
    messages: db.listConversationMessages(conversationId),
    tasks: db.listConversationTasks(conversationId),
  });
  const assistantMessage = conversation.messages!.find(
    (message) => message.role === "assistant" && message.taskId === task.id,
  );
  assert.notEqual(assistantMessage, undefined);
  assert.equal(assistantMessage!.images.length, 1);
});

test("cleanupExpiredSessions 只删过期会话并返回条数", async () => {
  const db = await loadDb();
  const user = await createTestUser();

  db.createSession({ userId: user.id, tokenHash: `expired-${user.id}`, expiresAt: "2000-01-01T00:00:00.000Z" });
  db.createSession({ userId: user.id, tokenHash: `alive-${user.id}`, expiresAt: "2999-01-01T00:00:00.000Z" });

  assert.equal(db.cleanupExpiredSessions(), 1);
  assert.equal(db.cleanupExpiredSessions(), 0);
  assert.notEqual(db.getSessionByTokenHash(`alive-${user.id}`), null);
  assert.equal(db.getSessionByTokenHash(`expired-${user.id}`), null);
});

test("toCurrentUser 不再做月度聚合，用量由 withUserQuota 显式补", async () => {
  const db = await loadDb();
  const { toCurrentUser, withUserQuota } = await import("../lib/auth");
  const user = await createTestUser(50);

  const task = await queueTask(user.id, 2);
  await startTask(task.id);
  await addImage(task.id, "a");
  await addImage(task.id, "b");
  db.markTaskSucceeded(task.id, 2);

  const current = toCurrentUser(user);
  assert.equal(current.monthUsed, undefined);
  assert.equal(current.monthlyQuota, undefined);
  assert.equal(current.id, user.id);
  assert.equal(current.email, user.email);

  const withQuota = withUserQuota(current);
  assert.equal(withQuota.monthUsed, 2);
  assert.equal(withQuota.monthlyQuota, 50);
});
