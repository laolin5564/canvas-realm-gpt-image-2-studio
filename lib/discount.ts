// 折扣码规则的纯逻辑层：只做「码怎么算、能不能用」，不碰 node:sqlite，方便 bun test 直接跑。
// 关键约定：老林云只负责收款（按 num 份 × 每份 1 元），发多少次数完全由本地决定。
// 所以折扣一律翻译成「按 chargedUnits 份去老林云下单，本地按 creditCount 发次数」。

import { discountCodeTypes, type DiscountCodeStatus, type DiscountCodeType } from "./types";

/** 每份对应多少次生成额度。 */
export const creditsPerUnit = 10;

/** 每份的默认单价（分）。 */
export const defaultUnitPriceFen = 100;

/** 折扣码字符集：全大写字母数字，去掉容易看错的 0/O/1/I。 */
export const discountCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const discountCodeMinLength = 4;
export const discountCodeMaxLength = 32;
export const generatedDiscountCodeLength = 8;

const discountCodePattern = new RegExp(`^[A-Z0-9]{${discountCodeMinLength},${discountCodeMaxLength}}$`);

export interface DiscountCodeDefinition {
  code: string;
  type: DiscountCodeType;
  value: number;
  minUnits: number;
  maxUses: number | null;
  perUserLimit: number;
  startsAt: string | null;
  expiresAt: string | null;
  status: DiscountCodeStatus;
}

export interface DiscountPreview {
  code: string;
  type: DiscountCodeType;
  value: number;
  unitCount: number;
  chargedUnits: number;
  creditCount: number;
  originalPriceFen: number;
  chargedPriceFen: number;
  discountFen: number;
  summary: string;
}

export interface DiscountUsageContext {
  now: Date;
  usedCount: number;
  userUsedCount: number;
  units: number;
}

/** 折扣码统一大写、去空白；非字符串一律返回空串。 */
export function normalizeDiscountCode(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toUpperCase();
}

/** 只判断格式：4-32 位 A-Z0-9。 */
export function isValidDiscountCode(value: string): boolean {
  return discountCodePattern.test(value);
}

export function isDiscountCodeType(value: unknown): value is DiscountCodeType {
  return typeof value === "string" && discountCodeTypes.includes(value as DiscountCodeType);
}

/**
 * 折扣类型与数值的合法性：percent 是「折后付百分之几」，只能 1-99；
 * amount 是减免元数、bonus 是赠送次数，都要求 ≥ 1 的整数。
 * 返回中文错误或 null，供 zod 与数据层共用，避免两处规则漂移。
 */
export function validateDiscountValue(type: DiscountCodeType, value: number): string | null {
  if (!Number.isInteger(value)) {
    return "折扣数值必须是整数";
  }
  if (type === "percent") {
    return value >= 1 && value <= 99 ? null : "折扣百分比只能是 1-99";
  }
  if (type === "amount") {
    return value >= 1 ? null : "减免金额至少 1 元";
  }
  return value >= 1 ? null : "赠送次数至少 1 次";
}

/**
 * 实际生效的最低份数。
 * amount 类型必须满足 units > value（否则实付会归零），把这条约束折进「最低购买 N 份」，
 * 用户看到的错误就只有一种口径。
 */
export function effectiveMinUnits(definition: Pick<DiscountCodeDefinition, "type" | "value" | "minUnits">): number {
  const base = Math.max(Math.trunc(definition.minUnits) || 1, 1);
  if (definition.type === "amount") {
    return Math.max(base, Math.trunc(definition.value) + 1);
  }
  return base;
}

/**
 * 折扣核算。调用前应先跑 validateDiscountCodeUsable；这里仍然做兜底钳制，
 * 保证 chargedUnits ≥ 1（老林云不接受 0 份订单）。
 */
export function computeDiscount(
  units: number,
  definition: DiscountCodeDefinition,
  unitPriceFen: number = defaultUnitPriceFen,
): DiscountPreview {
  const unitCount = Math.max(Math.trunc(units) || 0, 1);
  const price = Math.max(Math.trunc(unitPriceFen) || 0, 0);
  const value = Math.trunc(definition.value);

  let chargedUnits = unitCount;
  let creditCount = unitCount * creditsPerUnit;
  if (definition.type === "percent") {
    chargedUnits = Math.max(Math.ceil((unitCount * value) / 100), 1);
  } else if (definition.type === "amount") {
    chargedUnits = Math.max(unitCount - value, 1);
  } else {
    creditCount = unitCount * creditsPerUnit + value;
  }
  chargedUnits = Math.min(chargedUnits, unitCount);

  const originalPriceFen = unitCount * price;
  const chargedPriceFen = chargedUnits * price;
  const discountFen = Math.max(originalPriceFen - chargedPriceFen, 0);

  return {
    code: normalizeDiscountCode(definition.code),
    type: definition.type,
    value,
    unitCount,
    chargedUnits,
    creditCount,
    originalPriceFen,
    chargedPriceFen,
    discountFen,
    summary: buildDiscountSummary({
      type: definition.type,
      value,
      creditCount,
      originalPriceFen,
      chargedPriceFen,
      discountFen,
    }),
  };
}

/**
 * 可用性校验：返回中文错误或 null。
 * 顺序按「码本身是否还有效 → 名额 → 本单是否够门槛」，先报更根本的原因。
 */
export function validateDiscountCodeUsable(
  definition: DiscountCodeDefinition,
  context: DiscountUsageContext,
): string | null {
  if (definition.status !== "active") {
    return "折扣码已停用";
  }
  const currentTime = context.now.getTime();
  const startsAt = parseTime(definition.startsAt);
  if (startsAt !== null && currentTime < startsAt) {
    return "折扣码尚未开始";
  }
  const expiresAt = parseTime(definition.expiresAt);
  if (expiresAt !== null && currentTime > expiresAt) {
    return "折扣码已过期";
  }
  if (definition.maxUses !== null && context.usedCount >= definition.maxUses) {
    return "折扣码已达使用上限";
  }
  if (definition.perUserLimit > 0 && context.userUsedCount >= definition.perUserLimit) {
    return "你已使用过该折扣码";
  }
  const minUnits = effectiveMinUnits(definition);
  if (context.units < minUnits) {
    return `最低购买 ${minUnits} 份`;
  }
  return null;
}

/** 折扣码在后台列表里的中文说明，管理端与用户端共用同一套措辞。 */
export function describeDiscountRule(type: DiscountCodeType, value: number): string {
  if (type === "percent") {
    return `${formatTenth(value)} 折`;
  }
  if (type === "amount") {
    return `立减 ${Math.trunc(value)} 元`;
  }
  return `赠送 ${Math.trunc(value)} 次`;
}

function buildDiscountSummary(input: {
  type: DiscountCodeType;
  value: number;
  creditCount: number;
  originalPriceFen: number;
  chargedPriceFen: number;
  discountFen: number;
}): string {
  const rule = describeDiscountRule(input.type, input.value);
  const charged = formatYuan(input.chargedPriceFen);
  if (input.type === "bonus") {
    return `${rule}：实付 ${charged} 元，到账 ${input.creditCount} 次（含赠送 ${Math.trunc(input.value)} 次）`;
  }
  if (input.discountFen <= 0) {
    return `${rule}：本单未产生优惠，实付 ${charged} 元，到账 ${input.creditCount} 次`;
  }
  const original = formatYuan(input.originalPriceFen);
  const saved = formatYuan(input.discountFen);
  return `${rule}：原价 ${original} 元，实付 ${charged} 元（省 ${saved} 元），到账 ${input.creditCount} 次`;
}

function parseTime(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatYuan(fen: number): string {
  const yuan = fen / 100;
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
}

function formatTenth(value: number): string {
  const tenth = Math.trunc(value) / 10;
  return Number.isInteger(tenth) ? String(tenth) : tenth.toFixed(1);
}
