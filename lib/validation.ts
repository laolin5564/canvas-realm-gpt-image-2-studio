import { z } from "zod";
import { sizeOptions } from "./image-options";
import {
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
    quantity: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
    requestedConcurrency: z.union([z.literal(1), z.null()]).optional(),
    templateId: nullableString,
    sourceImageId: nullableString,
    sourceImageIds: z.array(z.string()).max(4).optional(),
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
  referenceImageIds: z.array(z.string()).max(4).optional(),
  size: z.enum(sizeOptions).default("auto"),
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
  mode: z.enum(generationModes).default("text_to_image"),
  sizeLabel: z.string().trim().max(80).default("不限制"),
  templateName: nullableString,
  templateDescription: nullableString,
  variables: z.record(z.string().trim().max(80), z.string().trim().max(1000)).default({}),
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
