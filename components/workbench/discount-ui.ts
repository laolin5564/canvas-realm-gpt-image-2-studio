import type {
  AiImageDiscountPreview,
  AiImageOrderDiscount,
  DiscountType,
} from "@/components/workbench/types";
import { discountCodeFormatMessage, isValidDiscountCode, normalizeDiscountCode } from "@/lib/discount";

/**
 * 折扣码归一化：直接复用后端那一份（NFKC + 去空白 + ASCII 大写），
 * 输入框每次 onChange 都过这一层，前后端不再各写一套。
 */
export { normalizeDiscountCode };

/**
 * 折扣码输入的前端预校验，返回中文错误文案；null 表示形式上合法。
 * 字符与长度规则同样来自 lib/discount，是否存在 / 是否可用一律以服务端预览结果为准。
 */
export function validateDiscountCodeInput(value: string): string | null {
  const code = normalizeDiscountCode(value);
  if (!code) {
    return "请输入折扣码";
  }
  return isValidDiscountCode(code) ? null : discountCodeFormatMessage;
}

/** 分转元：1000 → "￥10.00"，货币符号跟随购买弹窗现有写法。 */
export function formatFenAsYuan(fen: number): string {
  const safe = Number.isFinite(fen) ? Math.round(fen) : 0;
  return `￥${(safe / 100).toFixed(2)}`;
}

/** 折扣百分比转「几折」：80 → "8"，85 → "8.5"，99 → "9.9"。 */
export function percentToZheLabel(value: number): string {
  const zhe = value / 10;
  return Number.isInteger(zhe) ? String(zhe) : zhe.toFixed(1);
}

export const discountTypeLabels: Record<DiscountType, string> = {
  percent: "折扣百分比",
  amount: "金额立减",
  bonus: "赠送次数",
};

/** 管理后台列表里的「规则」列文案，三种折扣类型各一句。 */
export function discountRuleSummary(type: DiscountType, value: number): string {
  if (type === "percent") {
    return `${percentToZheLabel(value)} 折（按原价 ${value}% 计费）`;
  }
  if (type === "amount") {
    return `每单立减 ${value} 元（份数须大于 ${value}）`;
  }
  return `原价购买，额外赠送 ${value} 次`;
}

export interface DiscountValueFieldMeta {
  /** 表单里 value 输入框的标签，随类型变化。 */
  label: string;
  hint: string;
  min: number;
  max: number;
}

/** value 字段在三种类型下的含义与单位不同，表单靠这份元信息动态渲染。 */
export function discountValueFieldMeta(type: DiscountType): DiscountValueFieldMeta {
  if (type === "percent") {
    return {
      label: "折后计费比例（%）",
      hint: "填 1-99。例如 80 表示 8 折：买 10 份只付 8 份的钱，仍按 10 份发放次数。",
      min: 1,
      max: 99,
    };
  }
  if (type === "amount") {
    return {
      label: "立减金额（元）",
      hint: "填 ≥1 的整数，且购买份数必须大于该值。例如 2 表示买 10 份只付 8 元。",
      min: 1,
      max: 100000,
    };
  }
  return {
    label: "赠送次数（次）",
    hint: "填 ≥1 的整数。原价付款，额外多发放这些次数。",
    min: 1,
    max: 100000,
  };
}

export interface DiscountFormInput {
  code: string;
  type: DiscountType;
  value: number;
  minUnits: number;
  maxUses: number | null;
  perUserLimit: number;
  startsAt: string | null;
  expiresAt: string | null;
}

/** 管理后台创建 / 编辑表单的本地校验，规则与服务端契约保持一致。 */
export function validateDiscountForm(input: DiscountFormInput): string | null {
  const code = normalizeDiscountCode(input.code);
  if (code) {
    const codeError = validateDiscountCodeInput(code);
    if (codeError) {
      return codeError;
    }
  }

  if (!Number.isInteger(input.value)) {
    return "折扣数值必须是整数";
  }
  if (input.type === "percent" && (input.value < 1 || input.value > 99)) {
    return "折后计费比例必须在 1-99 之间";
  }
  if (input.type !== "percent" && input.value < 1) {
    return input.type === "amount" ? "立减金额至少 1 元" : "赠送次数至少 1 次";
  }

  if (!Number.isInteger(input.minUnits) || input.minUnits < 1) {
    return "最低购买份数至少为 1";
  }
  if (input.maxUses !== null && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) {
    return "总可用次数留空表示不限，填写时至少为 1";
  }
  if (!Number.isInteger(input.perUserLimit) || input.perUserLimit < 1) {
    return "每人可用次数至少为 1";
  }

  if (input.startsAt && input.expiresAt && Date.parse(input.expiresAt) <= Date.parse(input.startsAt)) {
    return "失效时间必须晚于生效时间";
  }
  return null;
}

/** 购买弹窗里验证通过后的一行摘要：折扣码 X：8 折，￥10.00 → ￥8.00，到账 100 次。 */
export function discountPreviewLine(preview: AiImageDiscountPreview): string {
  const from = formatFenAsYuan(preview.originalPriceFen);
  const to = formatFenAsYuan(preview.chargedPriceFen);
  return `折扣码 ${preview.code}：${preview.summary}，${from} → ${to}，到账 ${preview.creditCount} 次`;
}

/** 二维码区域的实付说明；无折扣时保持下单前后的老文案。 */
export function orderPaymentLine(
  totalPriceFen: number,
  generationCount: number,
  discount: AiImageOrderDiscount | null | undefined,
): string {
  const amount = formatFenAsYuan(totalPriceFen);
  if (!discount) {
    return `支付 ${amount}，到账 ${generationCount} 次`;
  }
  return `实付 ${amount}（已享 ${discount.summary}），到账 ${generationCount} 次`;
}

/** ISO 时间 → <input type="datetime-local"> 的值（本地时区，分钟精度）。 */
export function toDateTimeLocalValue(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** <input type="datetime-local"> 的值 → ISO 时间；留空或非法一律给 null。 */
export function fromDateTimeLocalValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

/** 有效期列文案：两端都可空。 */
export function discountPeriodLabel(startsAt: string | null, expiresAt: string | null): string {
  if (!startsAt && !expiresAt) {
    return "长期有效";
  }
  const format = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : toDateTimeLocalValue(iso).replace("T", " ");
  };
  if (startsAt && expiresAt) {
    return `${format(startsAt)} ~ ${format(expiresAt)}`;
  }
  if (startsAt) {
    return `${format(startsAt)} 起`;
  }
  return `至 ${format(expiresAt as string)}`;
}

/** 已用 / 上限文案，maxUses 为 null 表示不限。 */
export function discountUsageLabel(usedCount: number, maxUses: number | null): string {
  return maxUses === null ? `${usedCount} / 不限` : `${usedCount} / ${maxUses}`;
}
