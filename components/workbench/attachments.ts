/**
 * 工作台附件（参考图）的纯逻辑层。
 *
 * 以前参考图被拆成 sourceFiles / sourceImageIds / sourcePreviews 三份平行数组，
 * 下标一旦错位就会把别人的 blob URL revoke 掉。这里统一成一个附件数组，
 * 增删都返回「新数组 + 需要 revoke 的 URL 列表」，由调用方按项 revoke，
 * 不再整批 revokeObjectURL。所有函数都不碰 DOM，方便单测。
 */

import { maxSourceImageUploadBytes } from "@/lib/validation";

export type AttachmentRole = "primary" | "reference";

export interface WorkbenchAttachment {
  /** 前端本地 id，仅用于列表 key 与增删定位。 */
  id: string;
  /** 还没上传的本地文件；已经是服务端图片时为空。 */
  file?: File;
  /** 预览地址：本地文件是 blob:，服务端图片是 /api/files/... */
  previewUrl: string;
  /** 上传（或直接引用）后的服务端图片 id。 */
  uploadedId?: string;
  name: string;
  role: AttachmentRole;
}

export interface AttachmentMutation {
  next: WorkbenchAttachment[];
  /** 需要调用方 URL.revokeObjectURL 的地址，只包含 blob:。 */
  revoked: string[];
}

export interface AppendAttachmentsResult extends AttachmentMutation {
  /** 因为超过上限被丢弃的数量。 */
  skipped: number;
}

export interface IncomingFilePartition {
  /** 类型支持且体积在上限内，可以进入附件列表的文件。 */
  valid: File[];
  /** 类型不支持被过滤掉的数量。 */
  invalid: number;
  /** 超过原始文件上限被跳过的数量（服务端同样会拒绝，这里提前拦住省一次上传）。 */
  oversized: number;
}

/**
 * 把用户选中 / 拖入 / 粘贴的文件分成三类：可用、类型不支持、体积超限。
 * 先按类型过滤再看体积，一个文件只计入一类。
 */
export function partitionIncomingFiles(
  files: readonly File[],
  options: { isSupported: (file: File) => boolean; maxBytes: number },
): IncomingFilePartition {
  const valid: File[] = [];
  let invalid = 0;
  let oversized = 0;
  for (const file of files) {
    if (!options.isSupported(file)) {
      invalid += 1;
      continue;
    }
    if (file.size > options.maxBytes) {
      oversized += 1;
      continue;
    }
    valid.push(file);
  }
  return { valid, invalid, oversized };
}

/** 超过原始文件上限被跳过时的提示文案，工作台 / 会话 / 画布共用。 */
export function oversizedFilesMessage(count: number, maxBytes: number = maxSourceImageUploadBytes): string {
  return `有 ${count} 张图片超过 ${Math.round(maxBytes / (1024 * 1024))} MB，已跳过`;
}

export function isRevokableUrl(url: string | undefined | null): boolean {
  return typeof url === "string" && url.startsWith("blob:");
}

function withPrimary(list: WorkbenchAttachment[]): WorkbenchAttachment[] {
  if (list.length === 0 || list.some((item) => item.role === "primary")) {
    return list;
  }
  return list.map((item, index) => (index === 0 ? { ...item, role: "primary" as const } : item));
}

/**
 * 追加附件并裁掉超过上限的部分；超出的候选项自带的 blob URL 一并回收，避免泄漏。
 */
export function appendAttachments(
  current: WorkbenchAttachment[],
  incoming: WorkbenchAttachment[],
  limit: number,
): AppendAttachmentsResult {
  const room = Math.max(0, limit - current.length);
  const accepted = incoming.slice(0, room);
  const rejected = incoming.slice(room);
  return {
    next: withPrimary([...current, ...accepted]),
    revoked: rejected.map((item) => item.previewUrl).filter(isRevokableUrl),
    skipped: rejected.length,
  };
}

/** 删除单个附件；主图被删掉时把主图角色顺延给下一张。 */
export function removeAttachment(current: WorkbenchAttachment[], id: string): AttachmentMutation {
  const removed = current.find((item) => item.id === id);
  if (!removed) {
    return { next: current, revoked: [] };
  }
  const next = withPrimary(current.filter((item) => item.id !== id));
  return {
    next,
    revoked: isRevokableUrl(removed.previewUrl) ? [removed.previewUrl] : [],
  };
}

/** 清空附件，返回所有需要回收的 blob URL。 */
export function clearAttachments(current: WorkbenchAttachment[]): AttachmentMutation {
  return {
    next: [],
    revoked: current.map((item) => item.previewUrl).filter(isRevokableUrl),
  };
}

export function setAttachmentRole(
  current: WorkbenchAttachment[],
  id: string,
  role: AttachmentRole,
): WorkbenchAttachment[] {
  if (!current.some((item) => item.id === id)) {
    return current;
  }
  if (role === "primary") {
    return current.map((item) => ({ ...item, role: item.id === id ? "primary" : "reference" }));
  }
  return withPrimary(current.map((item) => (item.id === id ? { ...item, role } : item)));
}

/**
 * 上传完成后回写服务端 id：blob 预览换成服务端地址，旧的 blob URL 交给调用方回收。
 */
export function applyUploadedAttachments(
  current: WorkbenchAttachment[],
  uploaded: Record<string, { imageId: string; url: string }>,
): AttachmentMutation {
  const revoked: string[] = [];
  const next = current.map((item) => {
    const result = uploaded[item.id];
    if (!result) {
      return item;
    }
    if (isRevokableUrl(item.previewUrl)) {
      revoked.push(item.previewUrl);
    }
    return { ...item, uploadedId: result.imageId, previewUrl: result.url, file: undefined };
  });
  return { next, revoked };
}

export function primaryAttachmentId(list: WorkbenchAttachment[]): string | null {
  const primary = list.find((item) => item.role === "primary") ?? list[0];
  return primary?.uploadedId ?? null;
}

export function referenceAttachmentIds(list: WorkbenchAttachment[]): string[] {
  const primaryId = primaryAttachmentId(list);
  return list
    .map((item) => item.uploadedId)
    .filter((id): id is string => Boolean(id) && id !== primaryId);
}

/** 提交时用的全部图片 id，主图排在第一位。 */
export function attachmentImageIds(list: WorkbenchAttachment[]): string[] {
  const primaryId = primaryAttachmentId(list);
  return primaryId ? [primaryId, ...referenceAttachmentIds(list)] : referenceAttachmentIds(list);
}
