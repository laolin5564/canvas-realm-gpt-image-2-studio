import { describe, expect, test } from "bun:test";
import type { AiImageDiscountPreview } from "@/components/workbench/types";
import {
  discountPeriodLabel,
  discountPreviewLine,
  discountRuleSummary,
  discountTypeLabels,
  discountUsageLabel,
  discountValueFieldMeta,
  formatFenAsYuan,
  fromDateTimeLocalValue,
  normalizeDiscountCode,
  orderPaymentLine,
  percentToZheLabel,
  toDateTimeLocalValue,
  validateDiscountCodeInput,
  validateDiscountForm,
} from "@/components/workbench/discount-ui";

function preview(overrides: Partial<AiImageDiscountPreview> = {}): AiImageDiscountPreview {
  return {
    code: "SUMMER80",
    type: "percent",
    value: 80,
    unitCount: 10,
    chargedUnits: 8,
    creditCount: 100,
    originalPriceFen: 1000,
    chargedPriceFen: 800,
    discountFen: 200,
    summary: "8 折",
    ...overrides,
  };
}

describe("折扣码输入规范化", () => {
  test("统一大写并去掉所有空白", () => {
    expect(normalizeDiscountCode("  summer 80 ")).toBe("SUMMER80");
    expect(normalizeDiscountCode("a\tb\nc1")).toBe("ABC1");
    expect(normalizeDiscountCode("")).toBe("");
  });

  test("空输入提示补全", () => {
    expect(validateDiscountCodeInput("   ")).toBe("请输入折扣码");
  });

  test("非法字符优先于长度报错", () => {
    expect(validateDiscountCodeInput("ab-cd")).toBe("折扣码只能包含大写字母和数字");
    expect(validateDiscountCodeInput("a_")).toBe("折扣码只能包含大写字母和数字");
  });

  test("长度边界 4-32", () => {
    expect(validateDiscountCodeInput("ABC")).toBe("折扣码至少 4 位");
    expect(validateDiscountCodeInput("ABCD")).toBe(null);
    expect(validateDiscountCodeInput("A".repeat(32))).toBe(null);
    expect(validateDiscountCodeInput("A".repeat(33))).toBe("折扣码最多 32 位");
  });

  test("小写输入也算合法（会先被规范化）", () => {
    expect(validateDiscountCodeInput("summer80")).toBe(null);
  });
});

describe("金额格式化", () => {
  test("分转元固定两位小数", () => {
    expect(formatFenAsYuan(1000)).toBe("￥10.00");
    expect(formatFenAsYuan(833)).toBe("￥8.33");
    expect(formatFenAsYuan(0)).toBe("￥0.00");
  });

  test("非法输入兜底成 0", () => {
    expect(formatFenAsYuan(Number.NaN)).toBe("￥0.00");
  });
});

describe("规则摘要文案", () => {
  test("百分比折扣转几折", () => {
    expect(percentToZheLabel(80)).toBe("8");
    expect(percentToZheLabel(85)).toBe("8.5");
    expect(percentToZheLabel(99)).toBe("9.9");
  });

  test("三种类型各自的中文摘要", () => {
    expect(discountRuleSummary("percent", 80)).toBe("8 折（按原价 80% 计费）");
    expect(discountRuleSummary("amount", 2)).toBe("每单立减 2 元（份数须大于 2）");
    expect(discountRuleSummary("bonus", 20)).toBe("原价购买，额外赠送 20 次");
  });

  test("类型标签齐全", () => {
    expect(discountTypeLabels.percent).toBe("折扣百分比");
    expect(discountTypeLabels.amount).toBe("金额立减");
    expect(discountTypeLabels.bonus).toBe("赠送次数");
  });

  test("value 字段的取值范围随类型变化", () => {
    expect(discountValueFieldMeta("percent").min).toBe(1);
    expect(discountValueFieldMeta("percent").max).toBe(99);
    expect(discountValueFieldMeta("amount").min).toBe(1);
    expect(discountValueFieldMeta("bonus").label).toBe("赠送次数（次）");
  });

  test("已用 / 上限文案", () => {
    expect(discountUsageLabel(3, null)).toBe("3 / 不限");
    expect(discountUsageLabel(3, 10)).toBe("3 / 10");
  });

  test("有效期文案覆盖四种组合", () => {
    expect(discountPeriodLabel(null, null)).toBe("长期有效");
    expect(discountPeriodLabel("2026-09-01T00:00:00.000Z", null)).toContain("起");
    expect(discountPeriodLabel(null, "2026-09-30T00:00:00.000Z")).toContain("至");
    expect(discountPeriodLabel("2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z")).toContain("~");
  });
});

describe("购买弹窗文案", () => {
  test("验证通过后的一行摘要", () => {
    expect(discountPreviewLine(preview())).toBe("折扣码 SUMMER80：8 折，￥10.00 → ￥8.00，到账 100 次");
  });

  test("赠送次数类折扣原价不变", () => {
    const line = discountPreviewLine(
      preview({ code: "BONUS20", type: "bonus", value: 20, chargedUnits: 10, creditCount: 120, chargedPriceFen: 1000, discountFen: 0, summary: "额外赠送 20 次" }),
    );
    expect(line).toBe("折扣码 BONUS20：额外赠送 20 次，￥10.00 → ￥10.00，到账 120 次");
  });

  test("二维码区域无折扣时保持原文案", () => {
    expect(orderPaymentLine(1000, 100, null)).toBe("支付 ￥10.00，到账 100 次");
    expect(orderPaymentLine(1000, 100, undefined)).toBe("支付 ￥10.00，到账 100 次");
  });

  test("二维码区域有折扣时写明实付与摘要", () => {
    const line = orderPaymentLine(800, 100, { code: "SUMMER80", summary: "8 折", chargedUnits: 8, discountFen: 200 });
    expect(line).toBe("实付 ￥8.00（已享 8 折），到账 100 次");
  });
});

describe("管理后台表单校验", () => {
  const base = {
    code: "SUMMER80",
    type: "percent" as const,
    value: 80,
    minUnits: 1,
    maxUses: null,
    perUserLimit: 1,
    startsAt: null,
    expiresAt: null,
  };

  test("合法输入通过", () => {
    expect(validateDiscountForm(base)).toBe(null);
  });

  test("折扣码留空交给服务端生成", () => {
    expect(validateDiscountForm({ ...base, code: "" })).toBe(null);
  });

  test("折扣码非法时透传码校验错误", () => {
    expect(validateDiscountForm({ ...base, code: "AB" })).toBe("折扣码至少 4 位");
  });

  test("percent 限制 1-99", () => {
    expect(validateDiscountForm({ ...base, value: 0 })).toBe("折后计费比例必须在 1-99 之间");
    expect(validateDiscountForm({ ...base, value: 100 })).toBe("折后计费比例必须在 1-99 之间");
    expect(validateDiscountForm({ ...base, value: 1 })).toBe(null);
    expect(validateDiscountForm({ ...base, value: 99 })).toBe(null);
  });

  test("amount / bonus 至少为 1", () => {
    expect(validateDiscountForm({ ...base, type: "amount", value: 0 })).toBe("立减金额至少 1 元");
    expect(validateDiscountForm({ ...base, type: "bonus", value: 0 })).toBe("赠送次数至少 1 次");
    expect(validateDiscountForm({ ...base, type: "amount", value: 2 })).toBe(null);
  });

  test("小数一律拒绝", () => {
    expect(validateDiscountForm({ ...base, value: 80.5 })).toBe("折扣数值必须是整数");
  });

  test("份数与次数上限校验", () => {
    expect(validateDiscountForm({ ...base, minUnits: 0 })).toBe("最低购买份数至少为 1");
    expect(validateDiscountForm({ ...base, maxUses: 0 })).toBe("总可用次数留空表示不限，填写时至少为 1");
    expect(validateDiscountForm({ ...base, maxUses: Number.NaN })).toBe("总可用次数留空表示不限，填写时至少为 1");
    expect(validateDiscountForm({ ...base, maxUses: 5 })).toBe(null);
    expect(validateDiscountForm({ ...base, perUserLimit: 0 })).toBe("每人可用次数至少为 1");
  });

  test("失效时间必须晚于生效时间", () => {
    expect(
      validateDiscountForm({ ...base, startsAt: "2026-09-10T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z" }),
    ).toBe("失效时间必须晚于生效时间");
    expect(
      validateDiscountForm({ ...base, startsAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-10T00:00:00.000Z" }),
    ).toBe(null);
  });
});

describe("datetime-local 与 ISO 互转", () => {
  test("空值双向为空", () => {
    expect(toDateTimeLocalValue(null)).toBe("");
    expect(toDateTimeLocalValue("")).toBe("");
    expect(toDateTimeLocalValue("不是时间")).toBe("");
    expect(fromDateTimeLocalValue("  ")).toBe(null);
    expect(fromDateTimeLocalValue("不是时间")).toBe(null);
  });

  test("本地时间往返不漂移", () => {
    const local = "2026-09-03T10:30";
    const iso = fromDateTimeLocalValue(local);
    expect(typeof iso).toBe("string");
    expect(toDateTimeLocalValue(iso)).toBe(local);
  });
});
