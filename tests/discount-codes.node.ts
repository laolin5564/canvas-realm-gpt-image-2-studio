import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// 整个文件共用一个库：getDb 的「只初始化一次」标记是模块级的，必须在首次 import 之前定好路径。
// 这里刻意先造一个「还没有折扣码」的老库，顺带验证首启迁移。
const repoRoot = path.resolve(".");
const workspace = mkdtempSync(path.join(tmpdir(), "canvas-realm-discount-test-"));
const databasePath = path.join(workspace, "app.db");
const imageDir = path.join(workspace, "images");
process.env.DATABASE_URL = databasePath;
process.env.IMAGE_STORAGE_DIR = imageDir;

const legacyOrderId = "legacy-order-1";
const legacyUserId = "user_legacy";

function seedLegacyDatabase(): void {
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE ai_credit_orders (
      order_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credit_count INTEGER NOT NULL,
      total_price_fen INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
      created_at TEXT NOT NULL,
      paid_at TEXT
    );
  `);
  const now = new Date().toISOString();
  legacy
    .prepare(
      `
      INSERT INTO ai_credit_orders (order_id, user_id, credit_count, total_price_fen, status, created_at, paid_at)
      VALUES (?, ?, ?, ?, 'paid', ?, ?)
    `,
    )
    .run(legacyOrderId, legacyUserId, 10, 100, now, now);
  legacy.close();
}

seedLegacyDatabase();

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

async function createTestUser(monthlyQuota: number | null = 0) {
  const db = await loadDb();
  userSeq += 1;
  return db.createUser({
    email: `discount-${userSeq}@example.test`,
    name: `折扣测试用户 ${userSeq}`,
    passwordHash: "scrypt:00:00",
    role: "member",
    groupId: null,
    monthlyQuota,
  });
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

test("首启迁移：老库补出折扣列与折扣表，历史订单不受影响，再开一次也是空操作", async () => {
  const db = await loadDb();
  const database = db.getDb();

  const orderColumns = columnNames(database, "ai_credit_orders");
  for (const column of ["discount_code_id", "units_original", "units_charged", "discount_fen"]) {
    assert.equal(
      orderColumns.filter((name) => name === column).length,
      1,
      `ai_credit_orders 应有且仅有一列 ${column}`,
    );
  }

  const tables = (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('discount_codes', 'discount_code_redemptions')")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  assert.equal([...tables].sort().join(","), "discount_code_redemptions,discount_codes");

  // 历史订单：新列取默认值，老数据一个字节都没动。
  const legacy = db.getAiCreditOrder(legacyOrderId)!;
  assert.equal(legacy.credit_count, 10);
  assert.equal(legacy.status, "paid");
  assert.equal(legacy.discount_code_id, null);
  assert.equal(legacy.discount_fen, 0);

  // 幂等：另起一个进程再打开同一个库，DDL 全部 IF NOT EXISTS / ensureColumn，不该报错也不该重复加列。
  const reopenScript = path.join(workspace, "reopen.ts");
  writeFileSync(
    reopenScript,
    [
      "process.env.DATABASE_URL = process.argv[2];",
      "process.env.IMAGE_STORAGE_DIR = process.argv[3];",
      "import(process.argv[4])",
      "  .then((db) => {",
      "    db.getDb();",
      '    console.log("schema-ok");',
      "  })",
      "  .catch((error) => {",
      "    console.error(error);",
      "    process.exit(1);",
      "  });",
    ].join("\n"),
    "utf8",
  );
  const output = execFileSync(
    path.join(repoRoot, "node_modules", ".bin", "tsx"),
    [reopenScript, databasePath, imageDir, pathToFileURL(path.join(repoRoot, "lib", "db.ts")).href],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(output.includes("schema-ok"), true);
  assert.equal(columnNames(database, "ai_credit_orders").join(","), orderColumns.join(","));
});

test("createDiscountCode 留空时生成 8 位码，避开 0/O/1/I", async () => {
  const db = await loadDb();
  const generated = new Set<string>();
  for (let index = 0; index < 20; index += 1) {
    const created = db.createDiscountCode({ type: "percent", value: 80 });
    assert.equal(created.code.length, 8);
    assert.equal(/^[A-Z0-9]{8}$/.test(created.code), true);
    assert.equal(/[0O1I]/.test(created.code), false);
    assert.equal(generated.has(created.code), false);
    generated.add(created.code);
    assert.equal(created.status, "active");
    assert.equal(created.used_count, 0);
    assert.equal(created.per_user_limit, 1);
    assert.equal(created.min_units, 1);
    assert.equal(created.max_uses, null);
  }
});

test("createDiscountCode 显式码：大写归一、重复报 400、非法数值被拦下", async () => {
  const db = await loadDb();
  const created = db.createDiscountCode({ code: " save20 ", name: " 双十一 ", type: "percent", value: 80 });
  assert.equal(created.code, "SAVE20");
  assert.equal(created.name, "双十一");

  assert.throws(
    () => db.createDiscountCode({ code: "save20", type: "percent", value: 80 }),
    (error: Error & { status?: number }) => error.message === "折扣码已存在" && error.status === 400,
  );
  assert.throws(
    () => db.createDiscountCode({ code: "A", type: "percent", value: 80 }),
    /折扣码为 2-32 位，支持中文、字母和数字/,
  );
  assert.throws(
    () => db.createDiscountCode({ code: "SAVE-20", type: "percent", value: 80 }),
    /折扣码为 2-32 位，支持中文、字母和数字/,
  );
  assert.throws(() => db.createDiscountCode({ type: "percent", value: 100 }), /折扣百分比只能是 1-99/);
  assert.throws(() => db.createDiscountCode({ type: "amount", value: 0 }), /减免金额至少 1 元/);

  // 查码不分大小写。
  assert.equal(db.getDiscountCodeByCode("save20")!.id, created.id);
  assert.equal(db.getDiscountCodeByCode("  SAVE20 ")!.id, created.id);
  assert.equal(db.getDiscountCodeByCode("NOPE404"), null);
});

test("中文折扣码：建码后小写 / 全角 / 带空格变体都能查到，预览照常成立", async () => {
  const db = await loadDb();
  const user = await createTestUser();

  // 纯中文码：2-32 位内的中文一律原样存。
  const festival = db.createDiscountCode({ code: " 双十一 ", type: "bonus", value: 5 });
  assert.equal(festival.code, "双十一");
  assert.equal(db.getDiscountCodeByCode("双十一")!.id, festival.id);
  // 全角空格（\u3000）会被 NFKC + 去空白吃掉。
  assert.equal(db.getDiscountCodeByCode("\u3000双十一\u3000")!.id, festival.id);

  // 中英数混合码：ASCII 大小写归一，中文不动，全角数字折半角。
  const backToSchool = db.createDiscountCode({ code: "开学季8折vip", type: "percent", value: 80, minUnits: 2 });
  assert.equal(backToSchool.code, "开学季8折VIP");
  assert.equal(db.getDiscountCodeByCode("开学季8折vip")!.id, backToSchool.id);
  assert.equal(db.getDiscountCodeByCode(" 开学季 8折 VIP ")!.id, backToSchool.id);
  assert.equal(db.getDiscountCodeByCode("开学季\uff18折\uff56\uff49\uff50")!.id, backToSchool.id);

  // 同一个码换个写法再建一次，UNIQUE 照样拦住。
  assert.throws(
    () => db.createDiscountCode({ code: "开学季\uff18折vip", type: "percent", value: 80 }),
    (error: Error & { status?: number }) => error.message === "折扣码已存在" && error.status === 400,
  );

  // 预览：用户随手打的全角 + 空格 + 小写变体也能命中。
  const preview = db.resolveDiscountForPurchase({
    userId: user.id,
    code: " 开学季 \uff18折 vip ",
    unitCount: 10,
  });
  assert.equal(preview.ok, true);
  if (preview.ok) {
    assert.equal(preview.row.id, backToSchool.id);
    assert.equal(preview.preview.code, "开学季8折VIP");
    assert.equal(preview.preview.chargedUnits, 8);
    assert.equal(preview.preview.creditCount, 100);
    assert.equal(preview.preview.discountFen, 200);
  }

  const bonusPreview = db.resolveDiscountForPurchase({ userId: user.id, code: "双十一", unitCount: 1 });
  assert.equal(bonusPreview.ok, true);
  if (bonusPreview.ok) {
    assert.equal(bonusPreview.preview.creditCount, 15);
  }
});

test("resolveDiscountForPurchase：算得对，且失败原因是中文、不含内部 id", async () => {
  const db = await loadDb();
  const user = await createTestUser();
  const percent = db.createDiscountCode({ code: "PCT80A", type: "percent", value: 80, minUnits: 5 });

  const ok = db.resolveDiscountForPurchase({ userId: user.id, code: "pct80a", unitCount: 10 });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.row.id, percent.id);
    assert.equal(ok.preview.chargedUnits, 8);
    assert.equal(ok.preview.creditCount, 100);
    assert.equal(ok.preview.originalPriceFen, 1000);
    assert.equal(ok.preview.chargedPriceFen, 800);
    assert.equal(ok.preview.discountFen, 200);
    assert.equal(ok.preview.code, "PCT80A");
    assert.equal(ok.preview.summary.includes(percent.id), false);
  }

  const tooFew = db.resolveDiscountForPurchase({ userId: user.id, code: "PCT80A", unitCount: 4 });
  assert.equal(tooFew.ok, false);
  if (!tooFew.ok) {
    assert.equal(tooFew.error, "最低购买 5 份");
  }

  const missing = db.resolveDiscountForPurchase({ userId: user.id, code: "NOSUCH", unitCount: 10 });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error, "折扣码不存在");
  }

  const malformed = db.resolveDiscountForPurchase({ userId: user.id, code: "??", unitCount: 10 });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.error, "折扣码不存在");
  }

  db.updateDiscountCode(percent.id, { status: "disabled" });
  const disabled = db.resolveDiscountForPurchase({ userId: user.id, code: "PCT80A", unitCount: 10 });
  assert.equal(disabled.ok, false);
  if (!disabled.ok) {
    assert.equal(disabled.error, "折扣码已停用");
  }

  const expired = db.createDiscountCode({
    code: "EXPIRED1",
    type: "bonus",
    value: 5,
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(expired.expires_at, "2000-01-01T00:00:00.000Z");
  const expiredResult = db.resolveDiscountForPurchase({ userId: user.id, code: "EXPIRED1", unitCount: 10 });
  assert.equal(expiredResult.ok, false);
  if (!expiredResult.ok) {
    assert.equal(expiredResult.error, "折扣码已过期");
  }

  db.createDiscountCode({ code: "NOTYET01", type: "bonus", value: 5, startsAt: "2999-01-01T00:00:00.000Z" });
  const notYet = db.resolveDiscountForPurchase({ userId: user.id, code: "NOTYET01", unitCount: 10 });
  assert.equal(notYet.ok, false);
  if (!notYet.ok) {
    assert.equal(notYet.error, "折扣码尚未开始");
  }
});

test("下单落折扣字段，未支付的 pending 单也占住每人名额", async () => {
  const db = await loadDb();
  const user = await createTestUser();
  const code = db.createDiscountCode({ code: "HOLD8888", type: "percent", value: 80, perUserLimit: 1 });

  assert.equal(db.countUserDiscountRedemptions(code.id, user.id), 0);

  const order = db.createAiCreditOrder({
    orderId: `order-hold-${user.id}`,
    userId: user.id,
    creditCount: 100,
    totalPriceFen: 800,
    discountCodeId: code.id,
    unitsOriginal: 10,
    unitsCharged: 8,
    discountFen: 200,
  });
  assert.equal(order.discount_code_id, code.id);
  assert.equal(order.units_original, 10);
  assert.equal(order.units_charged, 8);
  assert.equal(order.discount_fen, 200);
  assert.equal(order.credit_count, 100);
  assert.equal(order.status, "pending");

  // 2 小时保护窗口内的 pending 单计入「已用」，防止同一个人连开多单把上限刷穿。
  assert.equal(db.countUserDiscountRedemptions(code.id, user.id), 1);
  const blocked = db.resolveDiscountForPurchase({ userId: user.id, code: "HOLD8888", unitCount: 10 });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.error, "你已使用过该折扣码");
  }

  // 超过窗口的 pending 视为弃单，名额放回。
  db.getDb()
    .prepare("UPDATE ai_credit_orders SET created_at = ? WHERE order_id = ?")
    .run(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), order.order_id);
  assert.equal(db.countUserDiscountRedemptions(code.id, user.id), 0);
  assert.equal(db.resolveDiscountForPurchase({ userId: user.id, code: "HOLD8888", unitCount: 10 }).ok, true);

  // 别人不受影响。
  const other = await createTestUser();
  assert.equal(db.countUserDiscountRedemptions(code.id, other.id), 0);
});

test("支付入账：发原始份数的次数、写 redemption、used_count+1，且重复回调幂等", async () => {
  const db = await loadDb();
  const user = await createTestUser(0);
  const code = db.createDiscountCode({ code: "PAID8888", type: "percent", value: 80, perUserLimit: 1, maxUses: 3 });
  const orderId = `order-paid-${user.id}`;
  db.createAiCreditOrder({
    orderId,
    userId: user.id,
    creditCount: 100,
    totalPriceFen: 800,
    discountCodeId: code.id,
    unitsOriginal: 10,
    unitsCharged: 8,
    discountFen: 200,
  });

  const first = db.markAiCreditOrderPaidAndGrant(orderId, user.id);
  assert.equal(first.granted, true);
  assert.equal(first.quota.monthlyQuota, 100);
  assert.equal(db.getDiscountCodeById(code.id)!.used_count, 1);

  const redemptions = db.listDiscountRedemptions(code.id);
  assert.equal(redemptions.length, 1);
  assert.equal(redemptions[0].userId, user.id);
  assert.equal(redemptions[0].userName, user.name);
  assert.equal(redemptions[0].orderId, orderId);
  assert.equal(redemptions[0].unitsOriginal, 10);
  assert.equal(redemptions[0].unitsCharged, 8);
  assert.equal(redemptions[0].creditCount, 100);
  assert.equal(redemptions[0].discountFen, 200);

  // 轮询会重复命中同一个订单：不能重复加额度，也不能重复核销。
  const second = db.markAiCreditOrderPaidAndGrant(orderId, user.id);
  assert.equal(second.granted, false);
  assert.equal(second.quota.monthlyQuota, 100);
  assert.equal(db.getDiscountCodeById(code.id)!.used_count, 1);
  assert.equal(db.listDiscountRedemptions(code.id).length, 1);

  // 已核销的人再来一单会被每人上限拦下。
  assert.equal(db.countUserDiscountRedemptions(code.id, user.id), 1);
  const again = db.resolveDiscountForPurchase({ userId: user.id, code: "PAID8888", unitCount: 10 });
  assert.equal(again.ok, false);
  if (!again.ok) {
    assert.equal(again.error, "你已使用过该折扣码");
  }
});

test("总上限用满后新用户也用不了；已超限的订单仍照常入账", async () => {
  const db = await loadDb();
  const code = db.createDiscountCode({ code: "CAP00001", type: "bonus", value: 5, maxUses: 1, perUserLimit: 5 });
  const first = await createTestUser(0);
  const second = await createTestUser(0);

  const firstOrder = `order-cap-${first.id}`;
  db.createAiCreditOrder({
    orderId: firstOrder,
    userId: first.id,
    creditCount: 15,
    totalPriceFen: 100,
    discountCodeId: code.id,
    unitsOriginal: 1,
    unitsCharged: 1,
    discountFen: 0,
  });
  // 上限用满前，先把第二单也开出来（模拟并发），随后两单都会支付成功。
  const secondOrder = `order-cap-${second.id}`;
  db.createAiCreditOrder({
    orderId: secondOrder,
    userId: second.id,
    creditCount: 15,
    totalPriceFen: 100,
    discountCodeId: code.id,
    unitsOriginal: 1,
    unitsCharged: 1,
    discountFen: 0,
  });

  db.markAiCreditOrderPaidAndGrant(firstOrder, first.id);
  assert.equal(db.getDiscountCodeById(code.id)!.used_count, 1);

  const blocked = db.resolveDiscountForPurchase({ userId: second.id, code: "CAP00001", unitCount: 1 });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.error, "折扣码已达使用上限");
  }

  // 钱已经付了：即便超了总上限也照样入账，只在日志里留痕。
  const grant = db.markAiCreditOrderPaidAndGrant(secondOrder, second.id);
  assert.equal(grant.granted, true);
  assert.equal(grant.quota.monthlyQuota, 15);
  assert.equal(db.listDiscountRedemptions(code.id).length, 2);
  assert.equal(db.getDiscountCodeById(code.id)!.used_count, 2);
});

test("无折扣码的订单照旧走原路径，不写核销记录", async () => {
  const db = await loadDb();
  const user = await createTestUser(0);
  const orderId = `order-plain-${user.id}`;
  const order = db.createAiCreditOrder({ orderId, userId: user.id, creditCount: 30, totalPriceFen: 300 });
  assert.equal(order.discount_code_id, null);
  assert.equal(order.discount_fen, 0);
  assert.equal(order.units_original, null);

  const grant = db.markAiCreditOrderPaidAndGrant(orderId, user.id);
  assert.equal(grant.granted, true);
  assert.equal(grant.quota.monthlyQuota, 30);
  const total = db.getDb().prepare("SELECT COUNT(*) AS count FROM discount_code_redemptions WHERE order_id = ?").get(orderId) as {
    count: number;
  };
  assert.equal(total.count, 0);
});

test("updateDiscountCode / disableDiscountCode / listDiscountCodes / toPublicDiscountCode", async () => {
  const db = await loadDb();
  const code = db.createDiscountCode({ code: "EDIT0001", type: "percent", value: 90, name: "旧名字" });

  const updated = db.updateDiscountCode(code.id, {
    name: "新名字",
    type: "amount",
    value: 3,
    minUnits: 5,
    maxUses: 100,
    perUserLimit: 2,
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-12-31T00:00:00.000Z",
  });
  assert.equal(updated.name, "新名字");
  assert.equal(updated.type, "amount");
  assert.equal(updated.value, 3);
  assert.equal(updated.min_units, 5);
  assert.equal(updated.max_uses, 100);
  assert.equal(updated.per_user_limit, 2);
  assert.equal(updated.starts_at, "2026-01-01T00:00:00.000Z");
  assert.equal(updated.status, "active");

  // 只改一个字段时，另一半从旧值补齐再校验：amount 类型不接受 0。
  assert.throws(() => db.updateDiscountCode(code.id, { value: 0 }), /减免金额至少 1 元/);
  // 换码要查重。
  db.createDiscountCode({ code: "TAKEN001", type: "bonus", value: 1 });
  assert.throws(() => db.updateDiscountCode(code.id, { code: "TAKEN001" }), /折扣码已存在/);
  assert.equal(db.updateDiscountCode(code.id, { code: "edit0002" }).code, "EDIT0002");
  assert.throws(() => db.updateDiscountCode("dcode_nope", { value: 1 }), /折扣码不存在/);

  const disabled = db.disableDiscountCode(code.id);
  assert.equal(disabled.status, "disabled");

  const publicCode = db.toPublicDiscountCode(disabled);
  assert.equal(publicCode.id, code.id);
  assert.equal(publicCode.code, "EDIT0002");
  assert.equal(publicCode.name, "新名字");
  assert.equal(publicCode.type, "amount");
  assert.equal(publicCode.value, 3);
  assert.equal(publicCode.minUnits, 5);
  assert.equal(publicCode.maxUses, 100);
  assert.equal(publicCode.perUserLimit, 2);
  assert.equal(publicCode.startsAt, "2026-01-01T00:00:00.000Z");
  assert.equal(publicCode.expiresAt, "2026-12-31T00:00:00.000Z");
  assert.equal(publicCode.status, "disabled");
  assert.equal(publicCode.usedCount, 0);
  assert.equal(typeof publicCode.createdAt, "string");
  assert.equal(typeof publicCode.updatedAt, "string");

  assert.equal(
    db.listDiscountCodes().some((row) => row.id === code.id),
    true,
  );
});
