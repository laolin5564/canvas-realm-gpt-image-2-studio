import { z } from "zod";
import {
  discountCodeFormatMessage,
  isValidDiscountCode,
  normalizeDiscountCode,
  validateDiscountValue,
} from "./discount";
import { imageQualityOptions, sizeOptions, type ImageQualityOption, type ImageSizeOption } from "./image-options";
import {
  discountCodeStatuses,
  discountCodeTypes,
  generationModes,
  imageConcurrencyLimits,
  imageProviders,
  taskStatuses,
  templateCategories,
  templateScopes,
  templateVariableTypes,
  userRoles,
  userStatuses,
} from "./types";

const nullableString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => (value && value.trim() !== "" ? value.trim() : null));

// 参考图上限：工作台与会话续图两条链路必须一致。
export const maxReferenceImageCount = 4;

const referenceImageIdsSchema = z
  .array(z.string().trim().min(1, "参考图 ID 不能为空"))
  .max(maxReferenceImageCount, `参考图最多 ${maxReferenceImageCount} 张`)
  .optional();

const templateVariableOptionSchema = z.object({
  label: z.string().trim().min(1).max(40),
  value: z.string().trim().min(1).max(120),
});

export const templateVariableSchema = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(40),
  type: z.enum(templateVariableTypes).default("text"),
  required: z.boolean().default(false),
  placeholder: nullableString,
  defaultValue: nullableString,
  helperText: nullableString,
  options: z.array(templateVariableOptionSchema).max(12).default([]),
});

export const createGenerationTaskSchema = z
  .object({
    mode: z.enum(generationModes),
    prompt: z.string().trim().min(1, "prompt 不能为空").max(8000, "prompt 过长"),
    negativePrompt: nullableString,
    size: z.enum(sizeOptions).default("auto"),
    quality: z.enum(imageQualityOptions).default("high"),
    quantity: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
    requestedConcurrency: z.union([z.literal(1), z.null()]).optional(),
    templateId: nullableString,
    sourceImageId: nullableString,
    sourceImageIds: referenceImageIdsSchema,
    conversationId: nullableString,
    applyFixedPrompt: z.boolean().optional().default(true),
    referenceStrength: z.coerce.number().min(0).max(1).default(0.6),
    styleStrength: z.coerce.number().min(0).max(1).default(0.7),
  })
  .superRefine((value, ctx) => {
    if (value.mode !== "text_to_image" && !value.sourceImageId && (!value.sourceImageIds || value.sourceImageIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "图生图需要上传或选择参考图",
        path: ["sourceImageId"],
      });
    }
  });

export const listTasksQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) {
        return [];
      }
      return value
        .split(",")
        .map((item) => item.trim())
        .filter((item): item is (typeof taskStatuses)[number] =>
          taskStatuses.includes(item as (typeof taskStatuses)[number]),
        );
    }),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const listImagesQuerySchema = z.object({
  mode: z
    .string()
    .optional()
    .transform((value) =>
      value === "edit_image"
        ? "image_to_image"
        : generationModes.includes(value as (typeof generationModes)[number])
        ? (value as (typeof generationModes)[number])
        : null,
    ),
  templateId: nullableString,
  keyword: nullableString,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(30),
});

export const createTemplateSchema = z.object({
  scope: z.enum(templateScopes).default("user"),
  name: z.string().trim().min(1, "模板名称不能为空").max(80),
  category: z.enum(templateCategories).default("company"),
  description: nullableString,
  defaultPrompt: z.string().trim().min(1, "默认 prompt 不能为空").max(8000),
  defaultNegativePrompt: nullableString,
  defaultSize: z.enum(sizeOptions).default("auto"),
  defaultReferenceStrength: z.coerce.number().min(0).max(1).default(0.6),
  defaultStyleStrength: z.coerce.number().min(0).max(1).default(0.7),
  sourceImageId: nullableString,
  templateVariables: z.array(templateVariableSchema).max(12).default([]),
});

export const updateTemplateSchema = createTemplateSchema.partial().extend({
  name: z.string().trim().min(1).max(80).optional(),
  defaultPrompt: z.string().trim().min(1).max(8000).optional(),
});

export const listTemplatesQuerySchema = z.object({
  category: z
    .string()
    .optional()
    .transform((value) =>
      templateCategories.includes(value as (typeof templateCategories)[number])
        ? (value as (typeof templateCategories)[number])
        : null,
    ),
  scope: z
    .string()
    .optional()
    .transform((value) =>
      templateScopes.includes(value as (typeof templateScopes)[number])
        ? (value as (typeof templateScopes)[number])
        : "all",
    ),
});

export const deleteImagesSchema = z.object({
  imageIds: z.array(z.string().trim().min(1)).min(1).max(60),
});

export const createTemplateFromImageSchema = z.object({
  imageId: z.string().trim().min(1),
  name: z.string().trim().min(1, "模板名称不能为空").max(80),
  category: z.enum(templateCategories).default("company"),
  description: nullableString,
});

export const updateAdminSettingsSchema = z.object({
  imageProvider: z.enum(imageProviders).optional(),
  sub2apiApiKey: z.string().trim().min(1).max(500).optional(),
  sub2apiBaseUrl: z.string().trim().url().max(300).optional(),
  imageProviderChannels: z
    .array(
      z.object({
        id: z.string().trim().max(80).optional(),
        name: z.string().trim().min(1, "渠道名称不能为空").max(60),
        enabled: z.boolean().default(true),
        priority: z.coerce.number().int().min(1).max(1000),
        baseUrl: z.string().trim().url("渠道 Base URL 格式不正确").max(300),
        model: z.string().trim().min(1, "渠道模型不能为空").max(100),
        apiKey: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .max(20)
    .optional(),
  openaiOAuthProxyUrl: z.union([z.string().trim().max(500), z.null()]).optional(),
  imageModel: z.string().trim().min(1).max(100).optional(),
  promptOptimizerModel: z.string().trim().min(1).max(100).optional(),
  imageConcurrency: z.coerce.number().int().min(imageConcurrencyLimits.min).max(imageConcurrencyLimits.max).optional(),
  imageRetentionDays: z.coerce.number().int().min(0).max(3650).optional(),
  siteTitle: z.string().trim().min(1).max(80).optional(),
  siteSubtitle: z.string().trim().min(1).max(120).optional(),
  registrationEnabled: z.boolean().optional(),
  registrationDefaultGroupId: z.string().trim().min(1).optional(),
  apiEnabled: z.boolean().optional(),
});

export const openAIOAuthExchangeSchema = z.object({
  sessionId: z.string().trim().min(1),
  code: z.string().trim().min(1),
  state: z.string().trim().min(1),
});

export const openAIOAuthStatusSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

export const continueConversationSchema = z.object({
  prompt: z.string().trim().max(8000).default(""),
  negativePrompt: nullableString,
  sourceImageId: nullableString,
  referenceImageId: nullableString,
  referenceImageIds: referenceImageIdsSchema,
  size: z.enum(sizeOptions).default("auto"),
  quality: z.enum(imageQualityOptions).default("high"),
  quantity: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
  referenceStrength: z.coerce.number().min(0).max(1).default(0.65),
  styleStrength: z.coerce.number().min(0).max(1).default(0.7),
});

export const saveCanvasProjectSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  snapshot: z.unknown().nullable(),
});

export const updateConversationFixedPromptSchema = z.object({
  enabled: z.boolean().default(true),
  fixedPrompt: nullableString,
});

export const createTemplateFromConversationPromptSchema = z.object({
  conversationId: z.string().trim().min(1),
  name: z.string().trim().min(1, "模板名称不能为空").max(80),
  category: z.enum(templateCategories).default("company"),
  description: nullableString,
});

export const optimizePromptSchema = z.object({
  prompt: z.string().trim().min(1, "prompt 不能为空").max(8000),
  mode: z.enum(generationModes).optional().default("text_to_image"),
  sizeLabel: z.string().trim().max(80).optional().default("不限制"),
  negativePrompt: nullableString,
  templateName: nullableString,
  templateDescription: nullableString,
  variables: z.record(z.string().trim().max(80), z.string().trim().max(1000)).optional().default({}),
});

export const qrLoginStatusSchema = z.object({
  webCode: z.string().trim().min(1, "二维码标识不能为空").max(120),
});

export const loginSchema = z.object({
  name: z.string().trim().min(1, "请输入账号或手机号").max(160),
  password: z.string().min(1, "请输入密码").max(200),
});

export const upsertUserGroupSchema = z.object({
  name: z.string().trim().min(1, "分组名称不能为空").max(60),
  monthlyQuota: z.coerce.number().int().min(0).max(100000),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  role: z.enum(userRoles).optional(),
  status: z.enum(userStatuses).optional(),
  groupId: nullableString,
  monthlyQuota: z.coerce.number().int().min(0).max(100000).nullable().optional(),
});

export const listAdminUsersQuerySchema = z.object({
  q: z.string().trim().max(160).optional().default(""),
  status: z
    .string()
    .optional()
    .transform((value) =>
      userStatuses.includes(value as (typeof userStatuses)[number])
        ? (value as (typeof userStatuses)[number])
        : null,
    ),
  role: z
    .string()
    .optional()
    .transform((value) =>
      userRoles.includes(value as (typeof userRoles)[number])
        ? (value as (typeof userRoles)[number])
        : null,
    ),
  groupId: nullableString,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  sort: z
    .string()
    .optional()
    .transform((value) =>
      (["createdAt", "updatedAt", "name", "email"].includes(value ?? "") ? value ?? "createdAt" : "createdAt") as
        | "createdAt"
        | "updatedAt"
        | "name"
        | "email",
    ),
  direction: z
    .string()
    .optional()
    .transform((value) => (value === "asc" ? "asc" : "desc") as "asc" | "desc"),
});

export const createAdminUserSchema = z.object({
  email: z.string().trim().email("邮箱格式不正确").max(160).transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1, "名称不能为空").max(60),
  password: z.string().min(8, "密码至少 8 位").max(200),
  role: z.enum(userRoles).default("member"),
  groupId: nullableString,
  monthlyQuota: z.coerce.number().int().min(0).max(100000),
});

const nullableDateTimeString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => (value && value.trim() !== "" ? value.trim() : null))
  .refine((value) => value === null || !Number.isNaN(Date.parse(value)), "时间格式不正确");

/** 折扣码先归一化（NFKC + 去空白 + ASCII 大写），再按 lib/discount 的同一份规则校验。 */
export const discountCodeSchema = z
  .string({ required_error: "请输入折扣码" })
  .transform((value) => normalizeDiscountCode(value))
  .refine((value) => isValidDiscountCode(value), discountCodeFormatMessage);

export const previewDiscountSchema = z.object({
  discountCode: discountCodeSchema,
  unitCount: z.coerce.number().int().min(1, "购买份数至少 1 份").max(10000, "购买份数过多"),
});

const discountCodeBaseSchema = z.object({
  code: z.union([discountCodeSchema, z.null()]).optional(),
  name: nullableString,
  type: z.enum(discountCodeTypes),
  value: z.coerce.number().int().min(1, "折扣数值至少为 1"),
  minUnits: z.coerce.number().int().min(1).max(10000).default(1),
  maxUses: z.union([z.coerce.number().int().min(1).max(1000000), z.null()]).default(null),
  perUserLimit: z.coerce.number().int().min(1).max(10000).default(1),
  startsAt: nullableDateTimeString,
  expiresAt: nullableDateTimeString,
  status: z.enum(discountCodeStatuses).default("active"),
});

function refineDiscountCodeInput(
  value: {
    type?: (typeof discountCodeTypes)[number];
    value?: number;
    startsAt?: string | null;
    expiresAt?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.type !== undefined && value.value !== undefined) {
    const error = validateDiscountValue(value.type, value.value);
    if (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error, path: ["value"] });
    }
  }
  if (value.startsAt && value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.startsAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "结束时间必须晚于开始时间", path: ["expiresAt"] });
  }
}

/** 新建折扣码：type / value 必填。 */
export const upsertDiscountCodeSchema = discountCodeBaseSchema.superRefine(refineDiscountCodeInput);

/** 更新折扣码：所有字段可选，缺省表示不改；type 与 value 只有同时出现才在这里校验，
 * 单独改一个时由 lib/db 的 updateDiscountCode 合并旧值后兜底。 */
export const updateDiscountCodeSchema = discountCodeBaseSchema.partial().superRefine(refineDiscountCodeInput);

/* ---------------------------------------------------------------------------
 * 开放 API（/api/v1）与自助密钥
 * 字段名走契约里的 snake_case；multipart 上来全是字符串，所以这里都做宽松归一化。
 * ------------------------------------------------------------------------- */

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, "密钥名称不能为空").max(40, "密钥名称最多 40 个字符"),
});

/** 空串 / 缺省一律落到 fallback，再按枚举校验，错的时候给中文提示。 */
function enumWithFallback<T extends string>(values: readonly T[], fallback: T, message: string) {
  return z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((value) => (value === null || value === undefined || String(value).trim() === "" ? fallback : String(value).trim()))
    .refine((value) => (values as readonly string[]).includes(value), message)
    .transform((value) => value as T);
}

const apiSizeOption = enumWithFallback<ImageSizeOption>(sizeOptions, "auto", "size 取值不在支持范围内");
const apiQualityOption = enumWithFallback<ImageQualityOption>(imageQualityOptions, "high", "quality 只能是 auto/low/medium/high");
const apiResponseFormat = enumWithFallback<"url" | "b64_json">(["url", "b64_json"], "url", "response_format 只能是 url 或 b64_json");

const apiWaitFlag = z
  .union([z.boolean(), z.string(), z.number(), z.null(), z.undefined()])
  .transform((value) => {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value === 1;
    }
    if (typeof value === "string") {
      return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
    }
    return false;
  });

const apiImageCount = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((value) => (value === null || value === undefined || String(value).trim() === "" ? 1 : Number(value)))
  .refine((value) => value === 1 || value === 2 || value === 4, "n 只能是 1、2 或 4")
  .transform((value) => value as 1 | 2 | 4);

export const apiV1GenerationSchema = z.object({
  prompt: z.string().trim().min(1, "prompt 不能为空").max(8000, "prompt 过长"),
  negative_prompt: nullableString,
  size: apiSizeOption,
  quality: apiQualityOption,
  n: apiImageCount,
  template_id: nullableString,
  wait: apiWaitFlag,
  response_format: apiResponseFormat,
});

export const apiV1EditSchema = apiV1GenerationSchema.extend({
  // JSON 调用时用 image_base64 代替 multipart 的 image 文件，data URL 与纯 base64 都收。
  image_base64: z.array(z.string().trim().min(1, "image_base64 不能为空")).min(1).max(maxReferenceImageCount).optional(),
});

export const apiV1ListTasksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
