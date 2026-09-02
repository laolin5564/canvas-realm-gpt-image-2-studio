import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import assert from "node:assert/strict";

// 先按「加 image_count 之前」的表结构造一个旧库，再让 lib/db 打开它，
// 验证补列 + 回填走通，老用户当月已用额度不会被清零。
const workspace = mkdtempSync(path.join(tmpdir(), "canvas-realm-db-migration-test-"));
const databasePath = path.join(workspace, "app.db");

after(() => {
  rmSync(workspace, { force: true, recursive: true });
});

const legacyUserId = "user_legacy";

function seedLegacyDatabase(): void {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE generation_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      conversation_id TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('text_to_image', 'image_to_image', 'edit_image')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
      prompt TEXT NOT NULL,
      negative_prompt TEXT,
      size TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity IN (1, 2, 4)),
      template_id TEXT,
      source_image_id TEXT,
      reference_strength REAL NOT NULL DEFAULT 0.6,
      style_strength REAL NOT NULL DEFAULT 0.7,
      cost_estimate REAL NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE generated_images (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('text_to_image', 'image_to_image', 'edit_image')),
      template_id TEXT,
      created_at TEXT NOT NULL
    );
  `);

  const now = new Date().toISOString();
  const insertTask = legacy.prepare(
    `
    INSERT INTO generation_tasks (
      id, user_id, mode, status, prompt, negative_prompt, size, quantity,
      template_id, source_image_id, reference_strength, style_strength, cost_estimate,
      error_message, created_at, started_at, completed_at
    ) VALUES (?, ?, 'text_to_image', ?, '旧任务', NULL, 'auto', ?, NULL, NULL, 0.6, 0.7, 0, NULL, ?, ?, ?)
  `,
  );
  // 图片还在的成功任务：按真实张数回填。
  insertTask.run("task_kept", legacyUserId, "succeeded", 2, now, now, now);
  // 图片已被保留期清理掉的成功任务：回落到 quantity，不能因为查不到图就退额。
  insertTask.run("task_pruned", legacyUserId, "succeeded", 4, now, now, now);
  // 排队中的任务：仍按 quantity 预占。
  insertTask.run("task_queued", legacyUserId, "queued", 2, now, null, null);
  // 一张都没出的失败任务：不计费。
  insertTask.run("task_failed", legacyUserId, "failed", 4, now, now, now);

  const insertImage = legacy.prepare(
    `
    INSERT INTO generated_images (id, task_id, file_path, width, height, prompt, mode, template_id, created_at)
    VALUES (?, ?, ?, 1024, 1024, '旧任务', 'text_to_image', NULL, ?)
  `,
  );
  insertImage.run("img_kept_1", "task_kept", "task_kept-1.png", now);
  insertImage.run("img_kept_2", "task_kept", "task_kept-2.png", now);
  legacy.close();
}

test("旧库补上 image_count 时会回填，历史用量不被清零", async () => {
  seedLegacyDatabase();
  process.env.DATABASE_URL = databasePath;
  process.env.IMAGE_STORAGE_DIR = path.join(workspace, "images");

  const db = await import("../lib/db");
  const counts = new Map(
    (
      db.getDb().prepare("SELECT id, image_count FROM generation_tasks").all() as Array<{
        id: string;
        image_count: number;
      }>
    ).map((row) => [row.id, row.image_count]),
  );

  // 首启迁移：新增列 / 新增表都得在老库上补出来，且不影响既有数据。
  const taskColumns = (
    db.getDb().prepare("PRAGMA table_info(generation_tasks)").all() as Array<{ name: string }>
  ).map((column) => column.name);
  assert.equal(taskColumns.includes("image_count"), true);
  assert.equal(taskColumns.includes("error_detail"), true);
  const attemptsTable = db
    .getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generation_attempts'")
    .get();
  assert.notEqual(attemptsTable, undefined);

  assert.equal(counts.get("task_kept"), 2);
  assert.equal(counts.get("task_pruned"), 4);
  assert.equal(counts.get("task_queued"), 0);
  assert.equal(counts.get("task_failed"), 0);

  // 2（有图）+ 4（图被清理但仍按 quantity 记账）+ 2（排队预占）+ 0（空失败）
  assert.equal(db.getUserMonthImageUsage(legacyUserId), 8);

  // 回填只在补列那一次跑，之后 getDb() 不会再重算。
  db.getDb().prepare("UPDATE generation_tasks SET image_count = 0 WHERE id = ?").run("task_kept");
  db.getDb();
  const after = db.getDb().prepare("SELECT image_count FROM generation_tasks WHERE id = ?").get("task_kept") as {
    image_count: number;
  };
  assert.equal(after.image_count, 0);
});
