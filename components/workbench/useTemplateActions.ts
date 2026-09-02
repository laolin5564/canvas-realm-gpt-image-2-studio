"use client";

import { useCallback, useState } from "react";
import { apiJson } from "@/components/client-api";
import type { PublicImage, PublicTemplate } from "@/lib/types";
import type { ToastTone } from "@/components/workbench/Toast";
import type { TemplateListResponse } from "@/components/workbench/types";

export interface TemplateActions {
  templates: PublicTemplate[];
  setTemplates: (templates: PublicTemplate[]) => void;
  loadTemplates: () => void;
  saveImageAsTemplate: (image: PublicImage) => void;
  saveConversationPromptAsTemplate: (conversationId: string | null, conversationTitle: string | null) => void;
}

/** 模板列表 + 「保存为模板」两条入口（历史图片 / 会话固定提示词）。 */
export function useTemplateActions({
  notify,
  onError,
}: {
  notify: (text: string, tone?: ToastTone) => void;
  onError: (caught: unknown, fallback: string) => void;
}): TemplateActions {
  const [templates, setTemplates] = useState<PublicTemplate[]>([]);

  const reload = useCallback(async () => {
    const payload = await apiJson<TemplateListResponse>("/api/templates");
    setTemplates(payload.templates);
  }, []);

  const loadTemplates = useCallback(() => {
    reload().catch((caught: unknown) => onError(caught, "模板加载失败"));
  }, [onError, reload]);

  const saveImageAsTemplate = useCallback(
    (image: PublicImage) => {
      const name = window.prompt("模板名称", image.templateName ? `${image.templateName} 副本` : "历史图片模板");
      if (!name) {
        return;
      }
      apiJson("/api/templates/from-image", {
        method: "POST",
        body: JSON.stringify({ imageId: image.id, name, category: "company", description: "从历史图片保存的用户模板" }),
      })
        .then(reload)
        .then(() => notify("已保存为用户模板。", "success"))
        .catch((caught: unknown) => onError(caught, "保存模板失败"));
    },
    [notify, onError, reload],
  );

  const saveConversationPromptAsTemplate = useCallback(
    (conversationId: string | null, conversationTitle: string | null) => {
      if (!conversationId) {
        notify("请先打开一个会话", "error");
        return;
      }
      const name = window.prompt("模板名称", conversationTitle ? `${conversationTitle} 固定提示词` : "会话固定提示词");
      if (!name) {
        return;
      }
      apiJson("/api/templates/from-conversation-prompt", {
        method: "POST",
        body: JSON.stringify({ conversationId, name, category: "company", description: "从会话固定提示词保存" }),
      })
        .then(reload)
        .then(() => notify("会话固定提示词已保存为模板。", "success"))
        .catch((caught: unknown) => onError(caught, "保存模板失败"));
    },
    [notify, onError, reload],
  );

  return { templates, setTemplates, loadTemplates, saveImageAsTemplate, saveConversationPromptAsTemplate };
}
