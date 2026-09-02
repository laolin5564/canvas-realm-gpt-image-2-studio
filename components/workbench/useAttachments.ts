"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { maxReferenceImageCount } from "@/lib/validation";
import {
  appendAttachments,
  applyUploadedAttachments,
  clearAttachments,
  isRevokableUrl,
  removeAttachment,
  setAttachmentRole,
  type AttachmentMutation,
  type AttachmentRole,
  type WorkbenchAttachment,
} from "@/components/workbench/attachments";
import { isSupportedImageFile } from "@/components/workbench/clipboard";

export interface AddFilesResult {
  added: number;
  /** 超过上限被丢弃的数量。 */
  skipped: number;
  /** 类型不支持被过滤掉的数量。 */
  invalid: number;
}

export interface AttachmentsController {
  attachments: WorkbenchAttachment[];
  limit: number;
  addFiles: (files: FileList | File[] | null) => AddFilesResult;
  /** 直接引用一张服务端已有图片（历史图 / 模板配图 / 「设为主图」）。 */
  useServerImage: (input: { imageId: string; url: string; name?: string; replace?: boolean }) => void;
  remove: (id: string) => void;
  clear: () => void;
  setRole: (id: string, role: AttachmentRole) => void;
  /** 把还没上传的本地文件传上去，返回上传后的完整附件数组。 */
  uploadPending: (upload: (file: File) => Promise<{ imageId: string; url: string }>) => Promise<WorkbenchAttachment[]>;
  snapshot: () => WorkbenchAttachment[];
}

function revoke(url: string): void {
  if (isRevokableUrl(url) && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
}

function makeLocalId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * 参考图附件状态：一个数组管住本地文件、blob 预览和上传后的服务端 id。
 * 所有变更都从纯函数拿到 { next, revoked }，只 revoke 真正被移除的那几条 blob URL。
 */
export function useAttachments(prefix: string, limit: number = maxReferenceImageCount): AttachmentsController {
  const [attachments, setAttachments] = useState<WorkbenchAttachment[]>([]);
  const listRef = useRef<WorkbenchAttachment[]>([]);

  const apply = useCallback((mutate: (current: WorkbenchAttachment[]) => AttachmentMutation) => {
    const mutation = mutate(listRef.current);
    listRef.current = mutation.next;
    setAttachments(mutation.next);
    mutation.revoked.forEach(revoke);
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[] | null): AddFilesResult => {
      const all = files ? Array.from(files) : [];
      const valid = all.filter(isSupportedImageFile);
      if (valid.length === 0) {
        return { added: 0, skipped: 0, invalid: all.length };
      }
      const incoming = valid.map((file) => ({
        id: makeLocalId(prefix),
        file,
        previewUrl: URL.createObjectURL(file),
        name: file.name,
        role: "reference" as AttachmentRole,
      }));
      const result = appendAttachments(listRef.current, incoming, limit);
      listRef.current = result.next;
      setAttachments(result.next);
      result.revoked.forEach(revoke);
      return { added: incoming.length - result.skipped, skipped: result.skipped, invalid: all.length - valid.length };
    },
    [limit, prefix],
  );

  const useServerImage = useCallback(
    ({ imageId, url, name, replace = false }: { imageId: string; url: string; name?: string; replace?: boolean }) => {
      apply((current) => {
        const base = replace ? clearAttachments(current) : { next: current, revoked: [] as string[] };
        if (base.next.some((item) => item.uploadedId === imageId)) {
          return base;
        }
        const appended = appendAttachments(
          base.next,
          [
            {
              id: makeLocalId(prefix),
              previewUrl: url,
              uploadedId: imageId,
              name: name ?? "已有图片",
              role: replace ? "primary" : "reference",
            },
          ],
          limit,
        );
        return { next: appended.next, revoked: [...base.revoked, ...appended.revoked] };
      });
    },
    [apply, limit, prefix],
  );

  const remove = useCallback((id: string) => apply((current) => removeAttachment(current, id)), [apply]);
  const clear = useCallback(() => apply((current) => clearAttachments(current)), [apply]);

  const setRole = useCallback(
    (id: string, role: AttachmentRole) => {
      apply((current) => ({ next: setAttachmentRole(current, id, role), revoked: [] }));
    },
    [apply],
  );

  const uploadPending = useCallback(
    async (upload: (file: File) => Promise<{ imageId: string; url: string }>): Promise<WorkbenchAttachment[]> => {
      const pending = listRef.current.filter((item) => item.file && !item.uploadedId);
      if (pending.length === 0) {
        return listRef.current;
      }
      const results = await Promise.all(
        pending.map(async (item) => [item.id, await upload(item.file as File)] as const),
      );
      const uploaded = Object.fromEntries(results);
      apply((current) => applyUploadedAttachments(current, uploaded));
      return listRef.current;
    },
    [apply],
  );

  const snapshot = useCallback(() => listRef.current, []);

  useEffect(() => {
    return () => {
      listRef.current.forEach((item) => revoke(item.previewUrl));
      listRef.current = [];
    };
  }, []);

  return { attachments, limit, addFiles, useServerImage, remove, clear, setRole, uploadPending, snapshot };
}
