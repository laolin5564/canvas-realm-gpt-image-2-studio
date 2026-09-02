"use client";

import { useCallback, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import { getValidImageFiles, imageFilesFromClipboardData, readClipboardImageFiles } from "@/components/workbench/clipboard";
import type { ToastTone } from "@/components/workbench/Toast";

export interface ImageDropTarget<T extends HTMLElement> {
  dragging: boolean;
  onFiles: (files: FileList | File[] | null) => void;
  onDrop: (event: DragEvent<T>) => void;
  onDragOver: (event: DragEvent<T>) => void;
  onDragLeave: () => void;
  onPaste: (event: ClipboardEvent<T>) => void;
  onPasteButton: () => void;
}

/** 参数面板和会话输入框各挂一份：拖拽 / 粘贴 / 选文件三条入口共用同一个附件写入函数。 */
export function useImageDropTarget<T extends HTMLElement>({
  prefix,
  addFiles,
  notify,
}: {
  prefix: string;
  addFiles: (files: FileList | File[] | null) => void;
  notify: (text: string, tone?: ToastTone) => void;
}): ImageDropTarget<T> {
  const [dragging, setDragging] = useState(false);

  const onDrop = useCallback(
    (event: DragEvent<T>) => {
      event.preventDefault();
      setDragging(false);
      const files = getValidImageFiles(event.dataTransfer.files);
      if (files.length === 0) {
        notify("请拖入 PNG、JPG 或 WEBP 图片", "error");
        return;
      }
      addFiles(files);
    },
    [addFiles, notify],
  );

  const onDragOver = useCallback((event: DragEvent<T>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }, []);

  const onPaste = useCallback(
    (event: ClipboardEvent<T>) => {
      void imageFilesFromClipboardData(event.clipboardData, prefix).then((files) => {
        if (files.length > 0) {
          addFiles(files);
          notify("已从剪贴板读取图片。", "success");
        }
      });
    },
    [addFiles, notify, prefix],
  );

  const onPasteButton = useCallback(() => {
    if (!navigator.clipboard?.read) {
      notify("当前浏览器不支持读取剪贴板图片，请用拖拽或选择文件上传。", "error");
      return;
    }
    void readClipboardImageFiles(prefix)
      .then((files) => {
        if (files.length === 0) {
          notify("未识别到可用图片，可直接按 ⌘V 粘贴到上传区域。", "error");
          return;
        }
        addFiles(files);
        notify("已从剪贴板读取图片。", "success");
      })
      .catch(() => notify("读取剪贴板失败，请确认浏览器权限，或改用拖拽 / 选择文件上传。", "error"));
  }, [addFiles, notify, prefix]);

  return {
    dragging,
    onFiles: addFiles,
    onDrop,
    onDragOver,
    onDragLeave: () => setDragging(false),
    onPaste,
    onPasteButton,
  };
}
