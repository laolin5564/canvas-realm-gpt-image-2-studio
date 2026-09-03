"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiJson, copyTextToClipboard, isUnauthorizedError } from "@/components/client-api";
import { imageSizeLabels, normalizeImageQualityOption, normalizeImageSizeOption } from "@/lib/image-options";
import type { ImageQualityOption, ImageSizeOption } from "@/lib/image-options";
import { defaultNegativePromptFor } from "@/lib/prompt-defaults";
import { maxReferenceImageCount } from "@/lib/validation";
import { oversizedFilesMessage } from "@/components/workbench/attachments";
import { defaultValuesForTemplate, renderTemplatePrompt } from "@/lib/template-prompt";
import type { TemplateVariableValues } from "@/lib/template-prompt";
import type {
  CurrentUser,
  PublicConversation,
  PublicImage,
  PublicTask,
  TemplateVariableDefinition,
} from "@/lib/types";
import { attachmentImageIds, primaryAttachmentId, referenceAttachmentIds } from "@/components/workbench/attachments";
import { Composer } from "@/components/workbench/Composer";
import { ConversationSidebar } from "@/components/workbench/ConversationSidebar";
import { ActivationCodeModal, BuyCreditsModal } from "@/components/workbench/QuotaPanels";
import { Thread } from "@/components/workbench/Thread";
import type { ImageActions } from "@/components/workbench/ThreadItems";
import { ToastStack, useToasts } from "@/components/workbench/Toast";
import { hasActiveTasks } from "@/components/workbench/polling";
import { improvePromptText, missingTemplateVariables, readCaseTryPrompt } from "@/components/workbench/prompt-utils";
import { pruneOptimisticEntries } from "@/components/workbench/thread-model";
import { useAttachments } from "@/components/workbench/useAttachments";
import { useConversationPolling } from "@/components/workbench/useConversationPolling";
import { useImageDropTarget } from "@/components/workbench/useImageDropTarget";
import { useQuota } from "@/components/workbench/useQuota";
import { useTemplateActions } from "@/components/workbench/useTemplateActions";
import {
  quotaRefreshEventName,
  workbenchModes,
  type CaseTryPromptPayload,
  type ConversationResponse,
  type CreateTaskResponse,
  type OptimisticEntry,
  type PromptOptimizerResponse,
  type QuantityOption,
  type WorkbenchMode,
} from "@/components/workbench/types";

export function WorkbenchClient() {
  const [mode, setMode] = useState<WorkbenchMode>("text_to_image");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState(() => defaultNegativePromptFor(null));
  const [size, setSize] = useState<ImageSizeOption>("auto");
  const [quality, setQuality] = useState<ImageQualityOption>("high");
  const [quantity, setQuantity] = useState<QuantityOption>(1);
  const [templateId, setTemplateId] = useState("");
  const [templateVariableValues, setTemplateVariableValues] = useState<TemplateVariableValues>({});
  const [referenceStrength, setReferenceStrength] = useState(0.6);
  const [styleStrength, setStyleStrength] = useState(0.7);

  const [conversations, setConversations] = useState<PublicConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<PublicConversation | null>(null);
  const [optimisticEntries, setOptimisticEntries] = useState<OptimisticEntry[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [scrollToken, setScrollToken] = useState(0);

  const [chatPrompt, setChatPrompt] = useState("");
  const [fixedPromptDraft, setFixedPromptDraft] = useState("");
  const [fixedPromptEditorOpen, setFixedPromptEditorOpen] = useState(false);
  const [fixedPromptSaving, setFixedPromptSaving] = useState(false);

  const [busy, setBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [promptOptimizing, setPromptOptimizing] = useState(false);
  const [cancelingTaskId, setCancelingTaskId] = useState<string | null>(null);
  const [rerunningTaskId, setRerunningTaskId] = useState<string | null>(null);
  const [pendingCaseTry, setPendingCaseTry] = useState<CaseTryPromptPayload | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);

  const { toasts, pushToast, dismissToast } = useToasts();
  const negativePromptTouchedRef = useRef(false);

  const goToLogin = useCallback(() => {
    window.location.href = "/login";
  }, []);

  const notifyError = useCallback(
    (caught: unknown, fallback: string) => {
      if (isUnauthorizedError(caught)) {
        goToLogin();
        return;
      }
      pushToast(caught instanceof Error ? caught.message : fallback, "error");
    },
    [goToLogin, pushToast],
  );

  const quotaController = useQuota({ notify: pushToast, onError: notifyError });
  const { templates, loadTemplates, saveImageAsTemplate, saveConversationPromptAsTemplate } = useTemplateActions({
    notify: pushToast,
    onError: notifyError,
  });
  const sourceAttachments = useAttachments("source", maxReferenceImageCount);
  const chatAttachments = useAttachments("chat", maxReferenceImageCount);

  const addSourceFiles = useCallback(
    (files: FileList | File[] | null) => {
      const result = sourceAttachments.addFiles(files);
      if (result.oversized > 0) {
        pushToast(oversizedFilesMessage(result.oversized), "error");
      }
      if (result.added === 0 && result.invalid > 0 && result.oversized === 0) {
        pushToast("仅支持 PNG、JPG 或 WEBP 图片", "error");
        return;
      }
      if (result.skipped > 0) {
        pushToast(`最多 ${maxReferenceImageCount} 张参考图，已忽略 ${result.skipped} 张。`, "error");
      }
    },
    [pushToast, sourceAttachments],
  );

  const addChatFiles = useCallback(
    (files: FileList | File[] | null) => {
      const result = chatAttachments.addFiles(files);
      if (result.oversized > 0) {
        pushToast(oversizedFilesMessage(result.oversized), "error");
      }
      if (result.added === 0 && result.invalid > 0 && result.oversized === 0) {
        pushToast("仅支持 PNG、JPG 或 WEBP 图片", "error");
        return;
      }
      if (result.skipped > 0) {
        pushToast(`最多 ${maxReferenceImageCount} 张图片，已忽略 ${result.skipped} 张。`, "error");
      }
    },
    [chatAttachments, pushToast],
  );

  const sourceDropTarget = useImageDropTarget<HTMLButtonElement>({
    prefix: "clipboard-image",
    addFiles: addSourceFiles,
    notify: pushToast,
  });
  const chatDropTarget = useImageDropTarget<HTMLDivElement>({
    prefix: "chat-reference",
    addFiles: addChatFiles,
    notify: pushToast,
  });

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === templateId) ?? null,
    [templateId, templates],
  );
  const missingVariables = selectedTemplate
    ? missingTemplateVariables(selectedTemplate, templateVariableValues)
    : [];
  const quota = quotaController.quota;
  const quotaExhausted = quota !== null && quota.remaining !== null && quota.remaining < quantity;
  const activeOptimisticEntries = useMemo(
    () => optimisticEntries.filter((entry) => entry.conversationId === activeConversationId),
    [activeConversationId, optimisticEntries],
  );

  /** 生成完成后刷新额度：本地面板 + 顶栏（顶栏监听事件重新拉 /api/auth/me）。 */
  const refreshQuotaAndUser = useCallback(async () => {
    await quotaController.refresh().catch(() => undefined);
    await apiJson<{ user: CurrentUser | null }>("/api/auth/me")
      .then((payload) => setCurrentUser(payload.user))
      .catch(() => undefined);
    window.dispatchEvent(new Event(quotaRefreshEventName));
  }, [quotaController]);

  const onConversations = useCallback((list: PublicConversation[]) => {
    setConversations(list);
    setActiveConversationId((current) => current ?? list[0]?.id ?? null);
  }, []);

  const onConversation = useCallback((conversation: PublicConversation) => {
    setActiveConversation(conversation);
    setOptimisticEntries((current) => pruneOptimisticEntries(current, conversation));
  }, []);

  const onTasksFinished = useCallback(
    (finished: PublicTask[]) => {
      if (finished.some((task) => task.status === "succeeded")) {
        pushToast("生成完成，额度已刷新。", "success");
      }
      void refreshQuotaAndUser();
    },
    [pushToast, refreshQuotaAndUser],
  );

  const onPollFailure = useCallback(
    (error: Error) => pushToast(`会话刷新失败：${error.message}`, "error"),
    [pushToast],
  );

  const { refresh, markTaskRunning, resetRunning } = useConversationPolling({
    activeConversationId,
    active: hasActiveTasks(activeConversation, activeOptimisticEntries.map((entry) => entry.task)),
    onConversations,
    onConversation,
    onTasksFinished,
    onUnauthorized: goToLogin,
    onFailure: onPollFailure,
  });

  useEffect(() => {
    loadTemplates();
    apiJson<{ user: CurrentUser | null }>("/api/auth/me")
      .then((payload) => setCurrentUser(payload.user))
      .catch(() => undefined);
    quotaController.refresh().catch((caught: unknown) => notifyError(caught, "额度加载失败"));
    // 首屏只拉一次；后续刷新走轮询与各操作的显式刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeConversationId) {
      setActiveConversation(null);
    }
  }, [activeConversationId]);

  useEffect(() => {
    setFixedPromptDraft(activeConversation?.fixedPrompt ?? "");
    setFixedPromptEditorOpen(false);
  }, [activeConversation?.id, activeConversation?.fixedPrompt]);

  // 从案例中心 / 历史页跳进来的初始参数，只在首屏读一次。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const casePromptPayload = readCaseTryPrompt(params.get("casePromptKey"));
    if (casePromptPayload?.prompt) {
      const nextSize = normalizeImageSizeOption(casePromptPayload.size ?? "auto");
      setMode("text_to_image");
      setPrompt(casePromptPayload.prompt);
      setTemplateId("");
      setTemplateVariableValues({});
      sourceAttachments.clear();
      setQuantity(1);
      setSize(nextSize);
      pushToast("已从案例中心填入提示词。");
      if (params.get("autostart") === "1") {
        setPendingCaseTry({ ...casePromptPayload, size: nextSize });
      }
      window.history.replaceState(null, "", window.location.pathname);
      return;
    }

    const nextMode = params.get("mode");
    const nextSourceImageId = params.get("sourceImageId");
    const normalizedMode = nextMode === "edit_image" ? "image_to_image" : nextMode;
    if (normalizedMode && workbenchModes.includes(normalizedMode as WorkbenchMode)) {
      setMode(normalizedMode as WorkbenchMode);
    } else if (nextSourceImageId) {
      setMode("image_to_image");
    }
    if (nextSourceImageId) {
      sourceAttachments.useServerImage({ imageId: nextSourceImageId, url: "", name: "已选图片", replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyTemplate(nextTemplateId: string): void {
    setTemplateId(nextTemplateId);
    const template = templates.find((item) => item.id === nextTemplateId);
    if (!template) {
      setTemplateVariableValues({});
      if (!negativePromptTouchedRef.current) {
        setNegativePrompt(defaultNegativePromptFor(null));
      }
      return;
    }
    const nextValues = defaultValuesForTemplate(template);
    setTemplateVariableValues(nextValues);
    setPrompt(renderTemplatePrompt(template, nextValues));
    // 用户手改过负面提示词就不再覆盖。
    if (!negativePromptTouchedRef.current) {
      setNegativePrompt(template.defaultNegativePrompt || defaultNegativePromptFor(template.category));
    }
    setSize(normalizeImageSizeOption(template.defaultSize));
    setReferenceStrength(template.defaultReferenceStrength);
    setStyleStrength(template.defaultStyleStrength);
    if (template.sourceImageId) {
      sourceAttachments.useServerImage({
        imageId: template.sourceImageId,
        url: "",
        name: "模板参考图",
        replace: true,
      });
    }
  }

  function updateTemplateVariable(variable: TemplateVariableDefinition, value: string): void {
    if (!selectedTemplate) {
      return;
    }
    setTemplateVariableValues((current) => {
      const nextValues = { ...current, [variable.key]: value };
      setPrompt(renderTemplatePrompt(selectedTemplate, nextValues));
      return nextValues;
    });
  }

  async function optimizePrompt(): Promise<void> {
    if (!prompt.trim()) {
      pushToast("先选择模板或填写一句基础描述，再优化提示词。", "error");
      return;
    }
    setPromptOptimizing(true);
    try {
      const payload = await apiJson<PromptOptimizerResponse>("/api/prompt-optimizer", {
        method: "POST",
        body: JSON.stringify({
          prompt,
          mode,
          sizeLabel: imageSizeLabels[size],
          templateName: selectedTemplate?.name ?? null,
          templateDescription: selectedTemplate?.description ?? null,
          variables: templateVariableValues,
        }),
      });
      setPrompt(payload.prompt);
      pushToast("AI 已优化提示词。", "success");
    } catch (caught) {
      setPrompt(improvePromptText(prompt, selectedTemplate, imageSizeLabels[size]));
      pushToast(
        caught instanceof Error ? `${caught.message} 已先使用本地规则优化。` : "AI 优化失败，已先使用本地规则优化。",
        "error",
      );
    } finally {
      setPromptOptimizing(false);
    }
  }

  async function uploadImageFile(file: File): Promise<{ imageId: string; url: string }> {
    const formData = new FormData();
    formData.append("image", file);
    return apiJson<{ imageId: string; url: string }>("/api/source-images", { method: "POST", body: formData });
  }

  /** 建任务的公共出口：提交成功后立刻插入乐观条目并触发一次刷新。 */
  async function createTask(body: Record<string, unknown>, optimisticContent: string): Promise<void> {
    const created = await apiJson<CreateTaskResponse>("/api/generation-tasks", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setActiveConversationId(created.conversationId);
    if (created.task) {
      pushOptimisticEntry(created.task, created.conversationId, optimisticContent);
    }
    refresh();
  }

  /** 提交成功立刻上屏：用户消息 + 占位卡不等下一轮轮询。 */
  function pushOptimisticEntry(task: PublicTask, conversationId: string, content: string): void {
    setOptimisticEntries((current) => [
      ...current,
      {
        id: `optimistic_${task.id}`,
        conversationId,
        content,
        createdAt: task.createdAt,
        task,
        sourceImage: null,
        referenceImages: task.referenceImages ?? [],
      },
    ]);
    markTaskRunning(task.id);
    setScrollToken((current) => current + 1);
  }

  async function submitTask(): Promise<void> {
    if (missingVariables.length > 0) {
      pushToast(`请先填写模板变量：${missingVariables.join("、")}`, "error");
      return;
    }
    if (!prompt.trim()) {
      pushToast("请输入 prompt 后再生成", "error");
      return;
    }

    setBusy(true);
    try {
      let sourceImageIds: string[] = [];
      if (mode !== "text_to_image") {
        const uploaded = await sourceAttachments.uploadPending(uploadImageFile);
        sourceImageIds = attachmentImageIds(uploaded);
        if (sourceImageIds.length === 0) {
          throw new Error("请先上传参考图");
        }
      }

      setSelectedImageId(null);
      await createTask(
        {
          mode,
          prompt,
          negativePrompt,
          size,
          quality,
          quantity,
          templateId: templateId || null,
          sourceImageId: sourceImageIds[0] ?? null,
          sourceImageIds: sourceImageIds.length > 1 ? sourceImageIds : undefined,
          referenceStrength,
          styleStrength,
        },
        prompt,
      );
      pushToast("已提交生成任务，进度会在会话里实时更新。", "success");
    } catch (caught) {
      notifyError(caught, "提交失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!pendingCaseTry || busy) {
      return;
    }
    async function submitCaseTryPrompt(payload: CaseTryPromptPayload): Promise<void> {
      setBusy(true);
      try {
        setSelectedImageId(null);
        await createTask(
          {
            mode: "text_to_image",
            prompt: payload.prompt,
            negativePrompt,
            size: normalizeImageSizeOption(payload.size ?? "auto"),
            quantity: 1,
            templateId: null,
            sourceImageId: null,
            referenceStrength,
            styleStrength,
          },
          payload.prompt,
        );
        pushToast(payload.caseId ? `已开始试用案例 #${payload.caseId}。` : "已开始试用案例提示词。", "success");
      } catch (caught) {
        notifyError(caught, "提交失败");
      } finally {
        setBusy(false);
      }
    }

    const timer = window.setTimeout(() => {
      const payload = pendingCaseTry;
      setPendingCaseTry(null);
      void submitCaseTryPrompt(payload);
    }, 360);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, pendingCaseTry]);

  /** 同参数重跑：用原任务的 prompt / 尺寸 / 质量 / 数量 / 参考图重新提交。 */
  async function rerunTask(task: PublicTask, strategy: "same" | "low_concurrency" = "same"): Promise<void> {
    if (rerunningTaskId) {
      return;
    }
    setRerunningTaskId(task.id);
    try {
      const referenceIds = Array.from(
        new Set(
          [task.referenceImageId, ...task.referenceImages.map((image) => image.id)].filter(
            (imageId): imageId is string => Boolean(imageId) && imageId !== task.sourceImageId,
          ),
        ),
      );
      const allImageIds = task.sourceImageId ? [task.sourceImageId, ...referenceIds] : referenceIds;
      await createTask(
        {
          mode: task.mode === "edit_image" ? "image_to_image" : task.mode,
          prompt: task.prompt,
          negativePrompt: task.negativePrompt,
          size: normalizeImageSizeOption(task.size),
          quality: normalizeImageQualityOption(task.quality),
          quantity: task.quantity,
          requestedConcurrency: strategy === "low_concurrency" ? 1 : task.requestedConcurrency === 1 ? 1 : null,
          templateId: task.templateId,
          sourceImageId: task.sourceImageId,
          sourceImageIds: allImageIds.length > 1 ? allImageIds : undefined,
          conversationId: task.conversationId ?? activeConversationId,
          referenceStrength: task.referenceStrength,
          styleStrength: task.styleStrength,
          applyFixedPrompt: false,
        },
        task.prompt,
      );
      pushToast(strategy === "low_concurrency" ? "已用低并发重新提交。" : "已按原参数重新提交。", "success");
    } catch (caught) {
      notifyError(caught, "重跑失败");
    } finally {
      setRerunningTaskId(null);
    }
  }

  function editWithImage(image: PublicImage): void {
    setMode("image_to_image");
    setSelectedImageId(image.id);
    sourceAttachments.useServerImage({ imageId: image.id, url: image.url, name: "生成结果", replace: true });
    pushToast("已把这张图放进参数面板的参考图。", "success");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveConversationFixedPrompt(enabled: boolean): Promise<void> {
    if (!activeConversationId) {
      pushToast("请先打开一个会话", "error");
      return;
    }
    if (enabled && !fixedPromptDraft.trim()) {
      pushToast("请输入会话固定提示词", "error");
      return;
    }

    setFixedPromptSaving(true);
    try {
      const payload = await apiJson<ConversationResponse>(`/api/conversations/${activeConversationId}`, {
        method: "PATCH",
        body: JSON.stringify({
          enabled,
          fixedPrompt: enabled ? fixedPromptDraft : activeConversation?.fixedPrompt ?? fixedPromptDraft,
        }),
      });
      setActiveConversation(payload.conversation);
      setFixedPromptEditorOpen(false);
      pushToast(enabled ? "会话固定提示词已开启。" : "会话固定提示词已关闭。", "success");
      refresh();
    } catch (caught) {
      notifyError(caught, "固定提示词保存失败");
    } finally {
      setFixedPromptSaving(false);
    }
  }

  async function continueConversation(): Promise<void> {
    if (!activeConversationId) {
      pushToast("请先创建或打开一个会话", "error");
      return;
    }
    const fixedPromptEnabled = Boolean(activeConversation?.fixedPromptEnabled && activeConversation.fixedPrompt);
    if (!chatPrompt.trim() && !fixedPromptEnabled) {
      pushToast("请输入本次描述，或先开启会话固定提示词", "error");
      return;
    }

    setChatBusy(true);
    try {
      const uploaded = await chatAttachments.uploadPending(uploadImageFile);
      const referenceIds = referenceAttachmentIds(uploaded);
      const sourceImageId = primaryAttachmentId(uploaded) ?? selectedImageId;
      const created = await apiJson<CreateTaskResponse>(`/api/conversations/${activeConversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          prompt: chatPrompt,
          negativePrompt,
          sourceImageId,
          referenceImageId: referenceIds[0] ?? null,
          referenceImageIds: referenceIds.length > 0 ? referenceIds : undefined,
          size,
          quality,
          quantity: 1,
          referenceStrength,
          styleStrength,
        }),
      });
      const submittedPrompt = chatPrompt;
      setChatPrompt("");
      chatAttachments.clear();
      if (created.task) {
        pushOptimisticEntry(created.task, activeConversationId, submittedPrompt || "按会话固定提示词处理");
      }
      pushToast("已提交，进度会在会话里实时更新。", "success");
      refresh();
    } catch (caught) {
      notifyError(caught, "继续会话失败");
    } finally {
      setChatBusy(false);
    }
  }

  async function cancelTask(task: PublicTask): Promise<void> {
    setCancelingTaskId(task.id);
    try {
      await apiJson(`/api/generation-tasks/${task.id}/cancel`, { method: "POST" });
      pushToast("已停止当前生成任务。", "success");
      refresh();
    } catch (caught) {
      notifyError(caught, "停止任务失败");
    } finally {
      setCancelingTaskId(null);
    }
  }

  function openConversation(conversationId: string): void {
    if (conversationId === activeConversationId) {
      return;
    }
    setActiveConversationId(conversationId);
    setActiveConversation(null);
    setSelectedImageId(null);
    setChatPrompt("");
    chatAttachments.clear();
    resetRunning();
  }

  async function deleteConversation(conversationId: string): Promise<void> {
    const conversation = conversations.find((item) => item.id === conversationId);
    const ok = window.confirm(
      `确定删除会话「${conversation?.title ?? "当前会话"}」吗？会话内的生成结果也会从历史记录中移除。`,
    );
    if (!ok) {
      return;
    }
    try {
      await apiJson(`/api/conversations/${conversationId}`, { method: "DELETE" });
      const remaining = conversations.filter((item) => item.id !== conversationId);
      setConversations(remaining);
      setOptimisticEntries((current) => current.filter((entry) => entry.conversationId !== conversationId));
      if (activeConversationId === conversationId) {
        setActiveConversationId(remaining[0]?.id ?? null);
        setActiveConversation(null);
        setSelectedImageId(null);
        chatAttachments.clear();
        resetRunning();
      }
      pushToast("会话已删除。", "success");
      refresh();
    } catch (caught) {
      notifyError(caught, "删除会话失败");
    }
  }

  const imageActions: ImageActions = {
    onOpen: () => undefined,
    onSetPrimary: (image) => {
      setSelectedImageId(image.id);
      pushToast("已设为本次会话主图。", "success");
    },
    onEdit: editWithImage,
    onCopy: (value) => {
      copyTextToClipboard(value)
        .then(() => pushToast("prompt 已复制。", "success"))
        .catch((caught: unknown) => notifyError(caught, "复制失败，请手动复制。"));
    },
    onRerunTask: (task) => void rerunTask(task),
    onSaveTemplate: saveImageAsTemplate,
  };

  return (
    <>
      <section className="page-heading">
        <div>
          <h1>生成工作台</h1>
          <p>文生图、图生图和任务队列在一个工作流里完成，生成结果会自动进入历史记录。</p>
        </div>
      </section>

      <section className="workbench-layout">
        <Composer
          mode={mode}
          prompt={prompt}
          negativePrompt={negativePrompt}
          size={size}
          quality={quality}
          quantity={quantity}
          templateId={templateId}
          templates={templates}
          selectedTemplate={selectedTemplate}
          templateVariableValues={templateVariableValues}
          missingTemplateVariables={missingVariables}
          referenceStrength={referenceStrength}
          styleStrength={styleStrength}
          attachments={sourceAttachments}
          dnd={sourceDropTarget}
          submitting={busy}
          promptOptimizing={promptOptimizing}
          quota={quota}
          quotaLoading={quotaController.loading}
          quotaExhausted={quotaExhausted}
          estimatedQuotaCost={quantity}
          onModeChange={setMode}
          onPromptChange={setPrompt}
          onNegativePromptChange={(value) => {
            negativePromptTouchedRef.current = true;
            setNegativePrompt(value);
          }}
          onSizeChange={setSize}
          onQualityChange={setQuality}
          onQuantityChange={setQuantity}
          onTemplateChange={applyTemplate}
          onTemplateVariableChange={updateTemplateVariable}
          onReferenceStrengthChange={setReferenceStrength}
          onStyleStrengthChange={setStyleStrength}
          onOptimizePrompt={() => void optimizePrompt()}
          onSubmit={() => void submitTask()}
          onRefreshQuota={() =>
            void quotaController.refresh().catch((caught: unknown) => notifyError(caught, "额度刷新失败"))
          }
          onOpenBuyPanel={quotaController.openBuyPanel}
          onOpenActivationPanel={quotaController.openActivationPanel}
        />

        <section className="panel results-panel conversation-panel">
          <div className="panel-header">
            <div>
              <h2>{activeConversation?.title ?? "会话窗口"}</h2>
              <p>生成结果和后续图生图都在当前上下文里连续进行</p>
            </div>
            <button className="icon-button ghost" type="button" onClick={refresh} aria-label="刷新会话">
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="panel-body conversation-body">
            {activeConversation ? (
              <Thread
                conversation={activeConversation}
                templates={templates}
                optimisticEntries={activeOptimisticEntries}
                isAdmin={currentUser?.role === "admin"}
                submitting={busy || chatBusy}
                chatPrompt={chatPrompt}
                chatBusy={chatBusy}
                canContinue={Boolean(activeConversation.latestImage)}
                selectedImageId={selectedImageId}
                cancelingTaskId={cancelingTaskId}
                rerunningTaskId={rerunningTaskId}
                attachments={chatAttachments}
                dnd={chatDropTarget}
                fixedPromptDraft={fixedPromptDraft}
                fixedPromptEditorOpen={fixedPromptEditorOpen}
                fixedPromptSaving={fixedPromptSaving}
                scrollToken={scrollToken}
                onChatPromptChange={setChatPrompt}
                onFixedPromptDraftChange={setFixedPromptDraft}
                onFixedPromptEditorOpenChange={setFixedPromptEditorOpen}
                onSaveFixedPrompt={(enabled) => void saveConversationFixedPrompt(enabled)}
                onSaveFixedPromptAsTemplate={() =>
                  saveConversationPromptAsTemplate(activeConversationId, activeConversation.title)
                }
                onContinue={() => void continueConversation()}
                onCancelTask={(task) => void cancelTask(task)}
                onRerunTask={(task, strategy) => void rerunTask(task, strategy)}
                imageActions={imageActions}
              />
            ) : (
              <div className="empty-state">
                <div>
                  <strong>还没有打开会话</strong>
                  <span>点击生成后会自动创建会话，也可以从右侧会话列表打开。</span>
                </div>
              </div>
            )}
          </div>
        </section>

        <ConversationSidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          onOpen={openConversation}
          onDelete={(conversationId) => void deleteConversation(conversationId)}
          onRefresh={refresh}
        />
      </section>

      {quotaController.buyPanelOpen ? (
        <BuyCreditsModal
          unitCount={quotaController.buyUnitCount}
          order={quotaController.buyOrder}
          paid={quotaController.buyOrderPaid}
          busy={quotaController.buyBusy}
          quotaLoading={quotaController.loading}
          discountCode={quotaController.discountCode}
          discountPreview={quotaController.discountPreview}
          discountError={quotaController.discountError}
          discountBusy={quotaController.discountBusy}
          onUnitCountChange={quotaController.setBuyUnitCount}
          onDiscountCodeChange={quotaController.setDiscountCode}
          onPreviewDiscount={quotaController.previewDiscount}
          onClearDiscount={quotaController.clearDiscount}
          onCreateOrder={quotaController.createOrder}
          onRefreshQuota={() =>
            void quotaController.refresh().catch((caught: unknown) => notifyError(caught, "额度刷新失败"))
          }
          onClose={quotaController.closeBuyPanel}
        />
      ) : null}

      {quotaController.activationPanelOpen ? (
        <ActivationCodeModal
          code={quotaController.activationCode}
          busy={quotaController.activationBusy}
          onCodeChange={quotaController.setActivationCode}
          onExchange={quotaController.exchangeCode}
          onClose={quotaController.closeActivationPanel}
        />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
