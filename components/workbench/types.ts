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

export interface AiImagePaymentResponse {
  order: {
    qrCodeUrl: string;
    orderId: string;
    totalPriceFen: number;
    unitCount: number;
    generationCount: number;
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
