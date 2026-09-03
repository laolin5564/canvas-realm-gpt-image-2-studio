import type { GenerationMode, PublicConversation, PublicSourceImage, PublicTask, PublicTemplate } from "@/lib/types";

/** 工作台只暴露文生图 / 图生图两种模式，edit_image 统一折叠成 image_to_image。 */
export type WorkbenchMode = Exclude<GenerationMode, "edit_image">;

export const workbenchModes: WorkbenchMode[] = ["text_to_image", "image_to_image"];
export const quantityOptions = [1, 2, 4] as const;
export type QuantityOption = (typeof quantityOptions)[number];

export const quotaRefreshEventName = "aiimage:quota-updated";

export interface ConversationListResponse {
  conversations: PublicConversation[];
}

export interface ConversationResponse {
  conversation: PublicConversation;
}

export interface TemplateListResponse {
  templates: PublicTemplate[];
}

export interface CreateTaskResponse {
  taskId: string;
  conversationId: string;
  status: string;
  task?: PublicTask;
}

export interface PromptOptimizerResponse {
  prompt: string;
}

export interface AiImageQuota {
  open: boolean;
  remaining: number | null;
  expireTime: string | null;
  monthlyQuota?: number | null;
  monthUsed?: number;
}

export interface AiImageQuotaResponse {
  quota: AiImageQuota;
  unitSize: number;
  message?: string;
}

/** 折扣码三种玩法：按比例折价 / 按金额立减 / 原价加送次数。 */
export type DiscountType = "percent" | "amount" | "bonus";
export type DiscountStatus = "active" | "disabled";

/** POST /api/billing/ai-image/discount/preview 返回的试算结果。 */
export interface AiImageDiscountPreview {
  code: string;
  type: DiscountType;
  value: number;
  unitCount: number;
  chargedUnits: number;
  creditCount: number;
  originalPriceFen: number;
  chargedPriceFen: number;
  discountFen: number;
  summary: string;
}

export interface AiImageDiscountPreviewResponse {
  ok: boolean;
  preview: AiImageDiscountPreview;
}

/** 下单成功后回带的折扣信息，未用折扣码时为 null。 */
export interface AiImageOrderDiscount {
  code: string;
  summary: string;
  chargedUnits: number;
  discountFen: number;
}

export interface AiImagePaymentResponse {
  order: {
    qrCodeUrl: string;
    orderId: string;
    totalPriceFen: number;
    /** 原始份数，折扣只影响实付金额，不影响这里。 */
    unitCount: number;
    /** 实际发放的生成次数。 */
    generationCount: number;
    discount?: AiImageOrderDiscount | null;
  };
  unitSize: number;
}

export interface AiImageOrderStatusResponse {
  status: {
    complete: number;
    paid: boolean;
  };
  quota?: AiImageQuota;
}

export interface CaseTryPromptPayload {
  caseId?: number;
  title?: string;
  prompt: string;
  size?: string;
}

/**
 * 提交成功后先落到本地的乐观条目：不等下一轮轮询就把用户消息 + 占位卡渲染出来，
 * 等会话详情里出现同一个 taskId 再丢弃。
 */
export interface OptimisticEntry {
  id: string;
  conversationId: string;
  content: string;
  createdAt: string;
  task: PublicTask;
  sourceImage: PublicSourceImage | null;
  referenceImages: PublicSourceImage[];
}
