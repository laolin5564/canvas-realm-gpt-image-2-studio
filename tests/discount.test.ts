import { describe, expect, test } from "bun:test";
import {
  computeDiscount,
  describeDiscountRule,
  effectiveMinUnits,
  isValidDiscountCode,
  normalizeDiscountCode,
  validateDiscountCodeUsable,
  validateDiscountValue,
  type DiscountCodeDefinition,
} from "../lib/discount";

function definition(overrides: Partial<DiscountCodeDefinition> = {}): DiscountCodeDefinition {
  return {
    code: "SAVE20",
    type: "percent",
    value: 80,
    minUnits: 1,
    maxUses: null,
    perUserLimit: 1,
    startsAt: null,
    expiresAt: null,
    status: "active",
    ...overrides,
  };
}

const now = new Date("2026-09-03T00:00:00.000Z");

describe("normalizeDiscountCode / isValidDiscountCode", () => {
  test("统一大写并去空白", () => {
    expect(normalizeDiscountCode("  save20 ")).toBe("SAVE20");
    expect(normalizeDiscountCode("save-20")).toBe("SAVE-20");
  });

  test("非字符串一律返回空串", () => {
    expect(normalizeDiscountCode(null)).toBe("");
    expect(normalizeDiscountCode(123)).toBe("");
    expect(normalizeDiscountCode(undefined)).toBe("");
  });

  test("格式只放行 4-32 位 A-Z0-9", () => {
    expect(isValidDiscountCode("SAVE")).toBe(true);
    expect(isValidDiscountCode("SAVE20")).toBe(true);
    expect(isValidDiscountCode("ABC")).toBe(false);
    expect(isValidDiscountCode("SAVE-20")).toBe(false);
    expect(isValidDiscountCode("save20")).toBe(false);
    expect(isValidDiscountCode("A".repeat(33))).toBe(false);
    expect(isValidDiscountCode("A".repeat(32))).toBe(true);
  });
});

describe("validateDiscountValue", () => {
  test("percent 只能 1-99", () => {
    expect(validateDiscountValue("percent", 80)).toBe(null);
    expect(validateDiscountValue("percent", 1)).toBe(null);
    expect(validateDiscountValue("percent", 99)).toBe(null);
    expect(validateDiscountValue("percent", 100)).toBe("折扣百分比只能是 1-99");
    expect(validateDiscountValue("percent", 0)).toBe("折扣百分比只能是 1-99");
  });

  test("amount / bonus 至少 1，且必须整数", () => {
    expect(validateDiscountValue("amount", 1)).toBe(null);
    expect(validateDiscountValue("amount", 0)).toBe("减免金额至少 1 元");
    expect(validateDiscountValue("bonus", 5)).toBe(null);
    expect(validateDiscountValue("bonus", 0)).toBe("赠送次数至少 1 次");
    expect(validateDiscountValue("bonus", 1.5)).toBe("折扣数值必须是整数");
  });
});

describe("computeDiscount：percent", () => {
  test("8 折 10 份：付 8 份得 100 次", () => {
    const result = computeDiscount(10, definition({ type: "percent", value: 80 }));
    expect(result.chargedUnits).toBe(8);
    expect(result.creditCount).toBe(100);
    expect(result.unitCount).toBe(10);
    expect(result.originalPriceFen).toBe(1000);
    expect(result.chargedPriceFen).toBe(800);
    expect(result.discountFen).toBe(200);
    expect(result.type).toBe("percent");
    expect(result.value).toBe(80);
    expect(result.code).toBe("SAVE20");
    expect(result.summary).toContain("8 折");
    expect(result.summary).toContain("到账 100 次");
  });

  test("实付份数向上取整，绝不让用户少付", () => {
    expect(computeDiscount(3, definition({ value: 80 })).chargedUnits).toBe(3);
    expect(computeDiscount(3, definition({ value: 50 })).chargedUnits).toBe(2);
    expect(computeDiscount(7, definition({ value: 50 })).chargedUnits).toBe(4);
    expect(computeDiscount(100, definition({ value: 1 })).chargedUnits).toBe(1);
  });

  test("1 份 8 折仍要付 1 份（老林云不接受 0 份订单）", () => {
    const result = computeDiscount(1, definition({ value: 80 }));
    expect(result.chargedUnits).toBe(1);
    expect(result.creditCount).toBe(10);
    expect(result.discountFen).toBe(0);
    expect(result.summary).toContain("本单未产生优惠");
  });
});

describe("computeDiscount：amount", () => {
  test("立减 3 元买 10 份：付 7 份得 100 次", () => {
    const result = computeDiscount(10, definition({ type: "amount", value: 3 }));
    expect(result.chargedUnits).toBe(7);
    expect(result.creditCount).toBe(100);
    expect(result.chargedPriceFen).toBe(700);
    expect(result.discountFen).toBe(300);
    expect(result.summary).toContain("立减 3 元");
  });

  test("units 不大于 value 时兜底钳到 1 份，不会出现 0 份订单", () => {
    expect(computeDiscount(3, definition({ type: "amount", value: 3 })).chargedUnits).toBe(1);
    expect(computeDiscount(1, definition({ type: "amount", value: 9 })).chargedUnits).toBe(1);
  });
});

describe("computeDiscount：bonus", () => {
  test("赠送 20 次：份数不变，次数多发", () => {
    const result = computeDiscount(10, definition({ type: "bonus", value: 20 }));
    expect(result.chargedUnits).toBe(10);
    expect(result.creditCount).toBe(120);
    expect(result.chargedPriceFen).toBe(1000);
    expect(result.discountFen).toBe(0);
    expect(result.summary).toContain("赠送 20 次");
    expect(result.summary).toContain("到账 120 次");
  });
});

describe("effectiveMinUnits", () => {
  test("amount 类型把 units > value 折进最低份数", () => {
    expect(effectiveMinUnits({ type: "amount", value: 3, minUnits: 1 })).toBe(4);
    expect(effectiveMinUnits({ type: "amount", value: 3, minUnits: 10 })).toBe(10);
  });

  test("percent / bonus 直接用 minUnits", () => {
    expect(effectiveMinUnits({ type: "percent", value: 80, minUnits: 5 })).toBe(5);
    expect(effectiveMinUnits({ type: "bonus", value: 20, minUnits: 1 })).toBe(1);
  });
});

describe("validateDiscountCodeUsable", () => {
  const usage = { now, usedCount: 0, userUsedCount: 0, units: 10 };

  test("正常可用返回 null", () => {
    expect(validateDiscountCodeUsable(definition(), usage)).toBe(null);
  });

  test("停用", () => {
    expect(validateDiscountCodeUsable(definition({ status: "disabled" }), usage)).toBe("折扣码已停用");
  });

  test("尚未开始 / 已过期", () => {
    expect(validateDiscountCodeUsable(definition({ startsAt: "2026-10-01T00:00:00.000Z" }), usage)).toBe(
      "折扣码尚未开始",
    );
    expect(validateDiscountCodeUsable(definition({ expiresAt: "2026-08-01T00:00:00.000Z" }), usage)).toBe(
      "折扣码已过期",
    );
    expect(
      validateDiscountCodeUsable(
        definition({ startsAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-30T00:00:00.000Z" }),
        usage,
      ),
    ).toBe(null);
  });

  test("总上限与每人上限", () => {
    expect(validateDiscountCodeUsable(definition({ maxUses: 5 }), { ...usage, usedCount: 5 })).toBe(
      "折扣码已达使用上限",
    );
    expect(validateDiscountCodeUsable(definition({ maxUses: 5 }), { ...usage, usedCount: 4 })).toBe(null);
    expect(validateDiscountCodeUsable(definition({ perUserLimit: 1 }), { ...usage, userUsedCount: 1 })).toBe(
      "你已使用过该折扣码",
    );
    expect(validateDiscountCodeUsable(definition({ perUserLimit: 2 }), { ...usage, userUsedCount: 1 })).toBe(null);
  });

  test("最低购买份数", () => {
    expect(validateDiscountCodeUsable(definition({ minUnits: 20 }), usage)).toBe("最低购买 20 份");
    expect(validateDiscountCodeUsable(definition({ type: "amount", value: 3 }), { ...usage, units: 3 })).toBe(
      "最低购买 4 份",
    );
    expect(validateDiscountCodeUsable(definition({ type: "amount", value: 3 }), { ...usage, units: 4 })).toBe(null);
  });

  test("坏掉的时间串当作没设置，不误伤用户", () => {
    expect(validateDiscountCodeUsable(definition({ expiresAt: "不是时间" }), usage)).toBe(null);
  });
});

describe("describeDiscountRule", () => {
  test("整折与半折都能读", () => {
    expect(describeDiscountRule("percent", 80)).toBe("8 折");
    expect(describeDiscountRule("percent", 85)).toBe("8.5 折");
    expect(describeDiscountRule("amount", 3)).toBe("立减 3 元");
    expect(describeDiscountRule("bonus", 20)).toBe("赠送 20 次");
  });
});

describe("折扣码入参校验（lib/validation）", () => {
  test("discountCodeSchema 大写化并卡格式", async () => {
    const { discountCodeSchema } = await import("../lib/validation");
    expect(discountCodeSchema.parse(" save20 ")).toBe("SAVE20");
    expect(discountCodeSchema.safeParse("ab").success).toBe(false);
    expect(discountCodeSchema.safeParse("SAVE-20").success).toBe(false);
  });

  test("previewDiscountSchema 要求份数 ≥ 1", async () => {
    const { previewDiscountSchema } = await import("../lib/validation");
    const parsed = previewDiscountSchema.parse({ discountCode: "save20", unitCount: "10" });
    expect(parsed.discountCode).toBe("SAVE20");
    expect(parsed.unitCount).toBe(10);
    expect(previewDiscountSchema.safeParse({ discountCode: "SAVE20", unitCount: 0 }).success).toBe(false);
  });

  test("upsertDiscountCodeSchema：默认值、类型数值联动、起止时间顺序", async () => {
    const { upsertDiscountCodeSchema, updateDiscountCodeSchema } = await import("../lib/validation");
    const created = upsertDiscountCodeSchema.parse({ type: "percent", value: 80 });
    expect(created.minUnits).toBe(1);
    expect(created.perUserLimit).toBe(1);
    expect(created.maxUses).toBe(null);
    expect(created.status).toBe("active");
    expect(created.name).toBe(null);

    expect(upsertDiscountCodeSchema.safeParse({ type: "percent", value: 100 }).success).toBe(false);
    expect(upsertDiscountCodeSchema.safeParse({ type: "bonus", value: 100 }).success).toBe(true);
    expect(
      upsertDiscountCodeSchema.safeParse({
        type: "bonus",
        value: 5,
        startsAt: "2026-12-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(false);

    // 更新时字段全可选，缺省表示不改。
    const patched = updateDiscountCodeSchema.parse({ status: "disabled" });
    expect(patched.status).toBe("disabled");
    expect(patched.type).toBe(undefined);
    expect(patched.minUnits).toBe(undefined);
  });
});
