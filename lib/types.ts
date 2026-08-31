export const generationModes = ["text_to_image", "image_to_image", "edit_image"] as const;
export type GenerationMode = (typeof generationModes)[number];

export const taskStatuses = ["queued", "processing", "succeeded", "failed"] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const taskProgressStages = ["queued", "requesting", "generating", "saving", "completed", "failed", "canceled"] as const;
export type TaskProgressStage = (typeof taskProgressStages)[number];

export const templateCategories = ["use_case", "platform", "company"] as const;
export type TemplateCategory = (typeof templateCategories)[number];

export const templateScopes = ["platform", "user"] as const;
export type TemplateScope = (typeof templateScopes)[number];

export const templateVariableTypes = ["text", "textarea", "select"] as const;
export type TemplateVariableType = (typeof templateVariableTypes)[number];

export interface TemplateVariableOption {
  label: string;
  value: string;
}

export interface TemplateVariableDefinition {
  key: string;
  label: string;
  type: TemplateVariableType;
  required: boolean;
  placeholder: string | null;
  defaultValue: string | null;
  helperText: string | null;
  options: TemplateVariableOption[];
}

export const userRoles = ["admin", "member"] as const;
export type UserRole = (typeof userRoles)[number];

export const userStatuses = ["active", "disabled"] as const;
export type UserStatus = (typeof userStatuses)[number];

export const imageProviders = ["sub2api", "openai_oauth"] as const;
export type ImageProvider = (typeof imageProviders)[number];

export interface ImageProviderChannel {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  baseUrl: string;
  model: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicImageProviderChannel {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export const imageConcurrencyLimits = {
  min: 1,
  max: 100,
} as const;

export type DbValue = string | number | null;

export interface GenerationTaskRow {
  id: string;
  user_id: string | null;
  conversation_id: string | null;
  mode: GenerationMode;
  status: TaskStatus;
  progress_stage: TaskProgressStage | null;
  prompt: string;
  fixed_prompt: string | null;
  prompt_suffix: string | null;
  negative_prompt: string | null;
  size: string;
  quality: string | null;
  quantity: number;
  requested_concurrency: number | null;
  template_id: string | null;
  source_image_id: string | null;
  reference_image_id: string | null;
  reference_image_ids: string | null;
  reference_strength: number;
  style_strength: number;
  cost_estimate: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface GeneratedImageRow {
  id: string;
  task_id: string;
  file_path: string;
  width: number;
  height: number;
  prompt: string;
  mode: GenerationMode;
  template_id: string | null;
  created_at: string;
}

export interface SourceImageRow {
  id: string;
  user_id: string | null;
  file_path: string;
  width: number;
  height: number;
  original_name: string | null;
  mime_type: string | null;
  created_at: string;
}

export interface CanvasProjectRow {
  id: string;
  user_id: string | null;
  name: string;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
}

export interface TemplateRow {
  id: string;
  owner_user_id: string | null;
  name: string;
  category: TemplateCategory;
  description: string | null;
  default_prompt: string;
  default_negative_prompt: string | null;
  default_size: string;
  default_reference_strength: number;
  default_style_strength: number;
  source_image_id: string | null;
  template_variables: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  user_id: string | null;
  title: string;
  fixed_prompt_enabled: number;
  fixed_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  task_id: string | null;
  image_id: string | null;
  created_at: string;
}

export interface UserGroupRow {
  id: string;
  name: string;
  monthly_quota: number;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  email: string;
  external_id: string | null;
  name: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  group_id: string | null;
  monthly_quota: number | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

export type OpenAIOAuthAccountStatus = "active" | "error" | "disabled";

export interface OpenAIOAuthAccountRow {
  id: string;
  email: string | null;
  account_id: string | null;
  user_id: string | null;
  organization_id: string | null;
  plan_type: string | null;
  client_id: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  expires_at: string;
  status: OpenAIOAuthAccountStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpenAIOAuthSessionRow {
  id: string;
  state: string;
  code_verifier: string;
  redirect_uri: string;
  client_id: string;
  expires_at: string;
  created_at: string;
}

export interface PublicOpenAIOAuthAccount {
  id: string;
  email: string | null;
  accountId: string | null;
  userId: string | null;
  organizationId: string | null;
  planType: string | null;
  clientId: string;
  expiresAt: string;
  status: OpenAIOAuthAccountStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicImage {
  id: string;
  taskId: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  prompt: string;
  mode: GenerationMode;
  templateId: string | null;
  templateName: string | null;
  createdAt: string;
}

export interface PublicSourceImage {
  id: string;
  url: string;
  width: number;
  height: number;
  originalName: string | null;
  mimeType: string | null;
  createdAt: string;
}

export interface PublicCanvasProject {
  id: string;
  name: string;
  snapshot: unknown | null;
  updatedAt: string;
}

export interface PublicTask {
  id: string;
  userId: string | null;
  conversationId: string | null;
  mode: GenerationMode;
  status: TaskStatus;
  progressStage: TaskProgressStage | null;
  prompt: string;
  fixedPrompt: string | null;
  promptSuffix: string | null;
  negativePrompt: string | null;
  size: string;
  quantity: number;
  requestedConcurrency: number | null;
  templateId: string | null;
  sourceImageId: string | null;
  referenceImageId: string | null;
  referenceImage: PublicSourceImage | null;
  referenceImages: PublicSourceImage[];
  referenceStrength: number;
  styleStrength: number;
  costEstimate: number;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  images?: PublicImage[];
}

export interface PublicConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  taskId: string | null;
  imageId: string | null;
  image: PublicImage | null;
  images: PublicImage[];
  sourceImage: PublicSourceImage | null;
  createdAt: string;
}

export interface PublicConversation {
  id: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  title: string;
  fixedPromptEnabled: boolean;
  fixedPrompt: string | null;
  createdAt: string;
  updatedAt: string;
  latestTask: PublicTask | null;
  latestImage: PublicImage | null;
  messages?: PublicConversationMessage[];
  tasks?: PublicTask[];
}

export interface PublicUserGroup {
  id: string;
  name: string;
  monthlyQuota: number;
  memberCount?: number;
  activeMemberCount?: number;
  monthUsed?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  id: string;
  email: string;
  externalId: string | null;
  name: string;
  role: UserRole;
  status: UserStatus;
  groupId: string | null;
  groupName: string | null;
  quotaOverride: number | null;
  monthlyQuota: number | null;
  monthUsed: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserListSummary {
  total: number;
  active: number;
  disabled: number;
  admin: number;
  member: number;
}

export interface AdminUserPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CurrentUser {
  id: string;
  email: string;
  externalId: string | null;
  name: string;
  role: UserRole;
  groupId: string | null;
  groupName: string | null;
  monthlyQuota: number | null;
  monthUsed: number;
}

export interface PublicTemplate {
  id: string;
  ownerUserId: string | null;
  scope: TemplateScope;
  name: string;
  category: TemplateCategory;
  description: string | null;
  defaultPrompt: string;
  defaultNegativePrompt: string | null;
  defaultSize: string;
  defaultReferenceStrength: number;
  defaultStyleStrength: number;
  sourceImageId: string | null;
  templateVariables: TemplateVariableDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminStats {
  today: {
    totalTasks: number;
    succeededTasks: number;
    failedTasks: number;
    totalImages: number;
    estimatedCost: number;
  };
  week: {
    totalTasks: number;
    succeededTasks: number;
    failedTasks: number;
    totalImages: number;
    estimatedCost: number;
  };
  popularTemplates: Array<{
    templateId: string;
    name: string;
    count: number;
  }>;
  health: {
    provider: ImageProvider;
    baseUrl: string;
    imageModel: string;
    imageConcurrency: number;
    timeoutStreak: number;
    autoDegradedAt: string | null;
    averageDurationSeconds: number | null;
    failureRate: number;
    availabilityRate: number;
    weekTimeoutTasks: number;
  };
  topErrors: Array<{
    message: string;
    count: number;
  }>;
  userSuccessRanking: Array<{
    userId: string | null;
    name: string;
    totalTasks: number;
    succeededTasks: number;
    successRate: number;
  }>;
  groupUsage: Array<{
    groupId: string | null;
    name: string;
    used: number;
    quota: number | null;
  }>;
}

export interface PublicAdminSettings {
  imageProvider: ImageProvider;
  sub2apiApiKeyConfigured: boolean;
  sub2apiBaseUrl: string;
  imageProviderChannels: PublicImageProviderChannel[];
  openaiOAuthProxyConfigured: boolean;
  openaiOAuthProxyDisplay: string | null;
  imageModel: string;
  imageConcurrency: number;
  imageRetentionDays: number;
  promptOptimizerModel: string;
  siteTitle: string;
  siteSubtitle: string;
  registrationEnabled: boolean;
  registrationDefaultGroupId: string;
  registrationDefaultQuota: number;
}

export interface SystemUpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  publishedAt: string | null;
  releaseNotesUrl: string | null;
  releaseName: string | null;
  updateAvailable: boolean;
  updateCheckUrl: string;
  updateRepo: string;
  updateCommand: string;
  checkedAt: string;
}

export type WebUpdateStatus = "idle" | "running" | "succeeded" | "failed";

export interface WebUpdateTask {
  status: WebUpdateStatus;
  enabled: boolean;
  enabledReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  logs: string[];
  error: string | null;
  exitCode: number | null;
  scriptPath: string;
}
