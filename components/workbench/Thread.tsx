"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardPaste, FileText, Pin, PinOff, Send, Upload, X } from "lucide-react";
import clsx from "clsx";
import { ImageLightbox } from "@/components/ImageLightbox";
import { isSubmitShortcut } from "@/components/workbench/keyboard";
import type { PublicConversation, PublicImage, PublicTask, PublicTemplate } from "@/lib/types";
import type { WorkbenchAttachment } from "@/components/workbench/attachments";
import type { AttachmentsController } from "@/components/workbench/useAttachments";
import type { ImageDropTarget } from "@/components/workbench/useImageDropTarget";
import { averageSecondsPerImage } from "@/components/workbench/task-progress";
import { buildThreadItems } from "@/components/workbench/thread-model";
import { useNowTicker } from "@/components/workbench/useNowTicker";
import { hasActiveTasks } from "@/components/workbench/polling";
import type { OptimisticEntry } from "@/components/workbench/types";
import {
  ConversationMessageItem,
  OptimisticUserMessage,
  TaskProgressCard,
  type ImageActions,
} from "@/components/workbench/ThreadItems";

/** 用户往上翻超过这个距离时，新消息不再强行把视图拽回底部。 */
const stickToBottomThresholdPx = 200;

export interface ThreadProps {
  conversation: PublicConversation;
  templates: PublicTemplate[];
  optimisticEntries: OptimisticEntry[];
  isAdmin: boolean;
  submitting: boolean;
  chatPrompt: string;
  chatBusy: boolean;
  canContinue: boolean;
  selectedImageId: string | null;
  cancelingTaskId: string | null;
  rerunningTaskId: string | null;
  attachments: AttachmentsController;
  dnd: ImageDropTarget<HTMLDivElement>;
  fixedPromptDraft: string;
  fixedPromptEditorOpen: boolean;
  fixedPromptSaving: boolean;
  /** 每次提交自增，用来强制把线程滚到底。 */
  scrollToken: number;
  onChatPromptChange: (value: string) => void;
  onFixedPromptDraftChange: (value: string) => void;
  onFixedPromptEditorOpenChange: (value: boolean) => void;
  onSaveFixedPrompt: (enabled: boolean) => void;
  onSaveFixedPromptAsTemplate: () => void;
  onContinue: () => void;
  onCancelTask: (task: PublicTask) => void;
  onRerunTask: (task: PublicTask, strategy?: "same" | "low_concurrency") => void;
  imageActions: ImageActions;
}

export function Thread(props: ThreadProps) {
  const {
    conversation,
    templates,
    optimisticEntries,
    isAdmin,
    submitting,
    chatPrompt,
    chatBusy,
    canContinue,
    selectedImageId,
    cancelingTaskId,
    rerunningTaskId,
    attachments,
    dnd,
    scrollToken,
    onChatPromptChange,
    onContinue,
    onCancelTask,
    onRerunTask,
    imageActions,
  } = props;

  const chatFileInputRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const scrollTokenRef = useRef(scrollToken);
  const [lightbox, setLightbox] = useState<{ images: PublicImage[]; index: number } | null>(null);

  const items = useMemo(
    () => buildThreadItems(conversation, optimisticEntries),
    [conversation, optimisticEntries],
  );
  const running = hasActiveTasks(conversation, optimisticEntries.map((entry) => entry.task));
  const nowMs = useNowTicker(running);
  const secondsPerImage = useMemo(() => averageSecondsPerImage(conversation.tasks ?? []), [conversation.tasks]);

  const hasFixedPrompt = Boolean(conversation.fixedPromptEnabled && conversation.fixedPrompt);
  const hasPrimaryAttachment = attachments.attachments.some((item) => item.role === "primary");
  const canSubmit = canContinue || hasPrimaryAttachment;
  const canSend = canSubmit && (Boolean(chatPrompt.trim()) || hasFixedPrompt);
  const lastItemId = items[items.length - 1]?.id ?? "";

  useEffect(() => {
    const element = threadRef.current;
    if (!element) {
      return;
    }
    const forced = scrollTokenRef.current !== scrollToken;
    scrollTokenRef.current = scrollToken;
    if (forced || stickToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [items.length, lastItemId, scrollToken]);

  const openLightbox = (image: PublicImage, siblings: PublicImage[]): void => {
    const list = siblings.length > 0 ? siblings : [image];
    setLightbox({ images: list, index: Math.max(0, list.findIndex((item) => item.id === image.id)) });
  };

  const actions: ImageActions = { ...imageActions, onOpen: openLightbox };

  return (
    <div className="conversation-window">
      <FixedPromptPanel
        conversation={conversation}
        templates={templates}
        draft={props.fixedPromptDraft}
        editing={props.fixedPromptEditorOpen}
        saving={props.fixedPromptSaving}
        onDraftChange={props.onFixedPromptDraftChange}
        onEditingChange={props.onFixedPromptEditorOpenChange}
        onSave={props.onSaveFixedPrompt}
        onSaveAsTemplate={props.onSaveFixedPromptAsTemplate}
      />
      <div
        className="conversation-thread"
        ref={threadRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= stickToBottomThresholdPx;
        }}
      >
        {items.length > 0 ? (
          items.map((item) => {
            if (item.kind === "message") {
              return (
                <ConversationMessageItem
                  key={item.id}
                  message={item.message}
                  task={item.task}
                  isAdmin={isAdmin}
                  submitting={submitting}
                  selectedImageId={selectedImageId}
                  rerunningTaskId={rerunningTaskId}
                  onRerunTask={onRerunTask}
                  actions={actions}
                />
              );
            }
            if (item.kind === "optimistic-message") {
              return <OptimisticUserMessage key={item.id} entry={item.entry} />;
            }
            return (
              <TaskProgressCard
                key={item.id}
                task={item.task}
                nowMs={nowMs}
                secondsPerImage={secondsPerImage}
                canceling={cancelingTaskId === item.task.id}
                submitting={submitting}
                selectedImageId={selectedImageId}
                onCancel={onCancelTask}
                actions={actions}
              />
            );
          })
        ) : (
          <div className="empty-state">
            <div>
              <strong>会话准备好了</strong>
              <span>第一条生成任务提交后，消息和结果会出现在这里。</span>
            </div>
          </div>
        )}
      </div>

      <div
        className={clsx("chat-composer", dnd.dragging && "dragging")}
        onDrop={dnd.onDrop}
        onDragOver={dnd.onDragOver}
        onDragEnter={dnd.onDragOver}
        onDragLeave={dnd.onDragLeave}
        onPaste={dnd.onPaste}
      >
        <div className="chat-reference-strip">
          <button
            className="button subtle chat-upload-button"
            type="button"
            onClick={() => chatFileInputRef.current?.click()}
            disabled={chatBusy}
          >
            <Upload size={15} aria-hidden="true" />
            上传图片
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={dnd.onPasteButton}
            disabled={chatBusy}
            title="粘贴图片"
          >
            <ClipboardPaste size={15} aria-hidden="true" />
          </button>
          <small>
            {hasPrimaryAttachment
              ? "主图：本次上传图片"
              : selectedImageId
              ? "主图：当前选中的生成结果"
              : "主图：当前会话最新生成结果"}
          </small>
          {attachments.attachments.length > 0 ? (
            <button className="button subtle" type="button" onClick={attachments.clear} disabled={chatBusy}>
              清空图片
            </button>
          ) : null}
          <input
            ref={chatFileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(event) => {
              dnd.onFiles(event.target.files);
              event.currentTarget.value = "";
            }}
          />
        </div>
        {attachments.attachments.length > 0 ? (
          <div className="chat-attachment-grid">
            {attachments.attachments.map((attachment) => (
              <ChatAttachmentCard
                key={attachment.id}
                attachment={attachment}
                disabled={chatBusy}
                onRemove={attachments.remove}
                onSetRole={attachments.setRole}
              />
            ))}
          </div>
        ) : null}
        <textarea
          className="textarea"
          value={chatPrompt}
          onChange={(event) => onChatPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (isSubmitShortcut(event) && canSend && !chatBusy) {
              event.preventDefault();
              onContinue();
            }
          }}
          placeholder={
            hasFixedPrompt
              ? "可选：补充本次需要特别处理的地方...（⌘/Ctrl + Enter 提交）"
              : canSubmit
              ? "描述你想怎么处理这张图...（⌘/Ctrl + Enter 提交）"
              : "上传主图，或等待当前会话先生成一张图片"
          }
          disabled={!canSubmit || chatBusy}
        />
        <button className="button primary" type="button" onClick={onContinue} disabled={!canSend || chatBusy}>
          <Send size={16} aria-hidden="true" />
          {chatBusy ? "提交中" : hasFixedPrompt ? "按固定提示词处理" : "继续图生图"}
        </button>
      </div>

      {lightbox ? (
        <ImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onNavigate={(delta) =>
            setLightbox((current) => {
              if (!current) {
                return current;
              }
              const total = current.images.length;
              return { ...current, index: (current.index + delta + total) % total };
            })
          }
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}

function ChatAttachmentCard({
  attachment,
  disabled,
  onRemove,
  onSetRole,
}: {
  attachment: WorkbenchAttachment;
  disabled: boolean;
  onRemove: (id: string) => void;
  onSetRole: (id: string, role: "primary" | "reference") => void;
}) {
  return (
    <div className={clsx("chat-attachment-card", attachment.role === "primary" && "primary")}>
      <img src={attachment.previewUrl} alt={attachment.name} loading="lazy" decoding="async" />
      <div>
        <strong>{attachment.role === "primary" ? "主图" : "参考图"}</strong>
        <span>{attachment.name}</span>
      </div>
      <div className="chat-attachment-actions">
        <button
          className={clsx("button subtle", attachment.role === "primary" && "active")}
          type="button"
          onClick={() => onSetRole(attachment.id, "primary")}
          disabled={disabled || attachment.role === "primary"}
        >
          主图
        </button>
        <button
          className={clsx("button subtle", attachment.role === "reference" && "active")}
          type="button"
          onClick={() => onSetRole(attachment.id, "reference")}
          disabled={disabled || attachment.role === "reference"}
        >
          参考
        </button>
        <button className="icon-button ghost" type="button" onClick={() => onRemove(attachment.id)} disabled={disabled}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function FixedPromptPanel({
  conversation,
  templates,
  draft,
  editing,
  saving,
  onDraftChange,
  onEditingChange,
  onSave,
  onSaveAsTemplate,
}: {
  conversation: PublicConversation;
  templates: PublicTemplate[];
  draft: string;
  editing: boolean;
  saving: boolean;
  onDraftChange: (value: string) => void;
  onEditingChange: (value: boolean) => void;
  onSave: (enabled: boolean) => void;
  onSaveAsTemplate: () => void;
}) {
  const enabled = Boolean(conversation.fixedPromptEnabled && conversation.fixedPrompt);

  return (
    <section className={clsx("fixed-prompt-panel", enabled && "enabled")}>
      <div className="fixed-prompt-title">
        <span className="badge">
          {enabled ? <Pin size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
          会话固定提示词
        </span>
        <div className="fixed-prompt-actions">
          {enabled && !editing ? (
            <>
              <button className="button subtle" type="button" onClick={() => onEditingChange(true)}>
                编辑
              </button>
              <button className="button subtle" type="button" onClick={onSaveAsTemplate}>
                保存为模板
              </button>
              <button className="button subtle" type="button" onClick={() => onSave(false)} disabled={saving}>
                <PinOff size={13} aria-hidden="true" />
                关闭
              </button>
            </>
          ) : null}
          {!enabled && !editing ? (
            <button className="button subtle" type="button" onClick={() => onEditingChange(true)}>
              <Pin size={13} aria-hidden="true" />
              设置
            </button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="fixed-prompt-editor">
          <textarea
            className="textarea"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (isSubmitShortcut(event) && !saving) {
                event.preventDefault();
                onSave(true);
              }
            }}
            placeholder="例如：把上传图片统一处理成白底电商主图，保留产品主体，柔和自然光，高级商业质感...（⌘/Ctrl + Enter 保存）"
          />
          <div className="fixed-prompt-editor-actions">
            <select
              className="select"
              value=""
              onChange={(event) => {
                const template = templates.find((item) => item.id === event.target.value);
                if (template) {
                  onDraftChange(template.defaultPrompt);
                }
                event.currentTarget.value = "";
              }}
            >
              <option value="">从模板填入</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
            <button className="button subtle" type="button" onClick={() => onEditingChange(false)} disabled={saving}>
              取消
            </button>
            <button className="button primary" type="button" onClick={() => onSave(true)} disabled={saving}>
              <Check size={14} aria-hidden="true" />
              {saving ? "保存中" : "开启并保存"}
            </button>
          </div>
        </div>
      ) : (
        <p>
          {enabled
            ? conversation.fixedPrompt
            : "开启后，后续发到这个会话的图片都会自动套用同一套提示词；输入框只需要写本次补充。"}
        </p>
      )}
    </section>
  );
}
