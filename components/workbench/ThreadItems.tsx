"use client";

/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { Copy, Download, Gauge, Pencil, RefreshCw, Save, Sparkles, Square, Target } from "lucide-react";
import clsx from "clsx";
import { handleImgError, useImageDirectBase, withDirectBase } from "@/components/image-src";
import type { PublicConversationMessage, PublicImage, PublicSourceImage, PublicTask } from "@/lib/types";
import {
  elapsedSecondsFor,
  formatDurationLabel,
  isCanceledTask,
  remainingEtaText,
  savedImageCount,
  taskQualityLabel,
  taskSizeLabel,
  taskStageLabel,
} from "@/components/workbench/task-progress";
import { compactErrorMessage, displayMessageContent } from "@/components/workbench/thread-model";
import type { OptimisticEntry } from "@/components/workbench/types";

export interface ImageActions {
  onOpen: (image: PublicImage, siblings: PublicImage[]) => void;
  onSetPrimary: (image: PublicImage) => void;
  onEdit: (image: PublicImage) => void;
  onCopy: (prompt: string) => void;
  onRerunTask: (task: PublicTask) => void;
  onSaveTemplate: (image: PublicImage) => void;
}

/** 图片卡：看大图不再顺手改主图，「设为主图 / 以此图继续编辑」是卡上的显式按钮。 */
export function ImageResultCard({
  image,
  siblings,
  task,
  selected,
  submitting,
  actions,
}: {
  image: PublicImage;
  siblings: PublicImage[];
  task: PublicTask | null;
  selected: boolean;
  submitting: boolean;
  actions: ImageActions;
}) {
  const imageDirectBase = useImageDirectBase();
  const ratioClass = image.height > image.width ? "tall" : image.width > image.height ? "wide" : "";

  return (
    <article className={clsx("image-card", selected && "selected")}>
      <button
        className={clsx("image-frame-button", selected && "selected")}
        type="button"
        onClick={() => actions.onOpen(image, siblings)}
        title="查看大图"
      >
        <div className={clsx("image-frame", ratioClass)}>
          <img
            src={withDirectBase(imageDirectBase, image.thumbnailUrl ?? image.url)}
            alt={image.prompt}
            loading="lazy"
            decoding="async"
            onError={handleImgError}
          />
        </div>
        {selected ? <span className="selected-image-badge">当前主图</span> : null}
      </button>
      <div className="image-card-body">
        {task ? (
          <div className="image-meta-badges">
            <span className="image-meta-badge">{taskSizeLabel(task)}</span>
            <span className="image-meta-badge">{taskQualityLabel(task)}</span>
            {task.quantity > 1 ? <span className="image-meta-badge">{task.quantity} 张</span> : null}
          </div>
        ) : null}
        <div className="image-prompt">{image.prompt}</div>
        <div className="card-actions">
          <a className="icon-button" href={image.url} download title="下载">
            <Download size={15} aria-hidden="true" />
          </a>
          <button className="icon-button" type="button" onClick={() => actions.onCopy(image.prompt)} title="复制 prompt">
            <Copy size={15} aria-hidden="true" />
          </button>
          {task ? (
            <button
              className="icon-button"
              type="button"
              onClick={() => actions.onRerunTask(task)}
              disabled={submitting}
              title="同参数重跑"
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          ) : null}
          <button
            className={clsx("icon-button", selected && "active")}
            type="button"
            onClick={() => actions.onSetPrimary(image)}
            title="设为主图"
          >
            <Target size={15} aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" onClick={() => actions.onEdit(image)} title="以此图继续编辑">
            <Pencil size={15} aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" onClick={() => actions.onSaveTemplate(image)} title="保存为模板">
            <Save size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  );
}

/**
 * 生成进度卡：阶段文案 + 已用时 + 已出 n/N + 预计剩余，出一张显示一张。
 * 后端只在任务结束时写 assistant 消息，这张卡是「生成过程看得见」的唯一载体。
 */
export function TaskProgressCard({
  task,
  nowMs,
  secondsPerImage,
  canceling,
  submitting,
  selectedImageId,
  onCancel,
  actions,
}: {
  task: PublicTask;
  nowMs: number;
  secondsPerImage: number | null;
  canceling: boolean;
  submitting: boolean;
  selectedImageId: string | null;
  onCancel: (task: PublicTask) => void;
  actions: ImageActions;
}) {
  const total = Math.max(1, task.quantity);
  const images = task.images ?? [];
  const saved = savedImageCount(task);
  const elapsedSeconds = elapsedSecondsFor(task, nowMs);
  const placeholders = Math.max(total - saved, task.status === "queued" || task.status === "processing" ? 1 : 0);
  const eta = remainingEtaText({ quantity: total, savedCount: saved, elapsedSeconds, secondsPerImage });

  return (
    <article className="message-row assistant">
      <div className="message-bubble task-progress-bubble">
        <div className="message-meta">
          <span>image-2</span>
          <div className="message-meta-actions">
            <span className="badge warning">
              <span className={clsx("status-dot", task.status)} />
              {taskStageLabel(task)}
            </span>
            <button
              className="button subtle stop-task-button"
              type="button"
              onClick={() => onCancel(task)}
              disabled={canceling}
            >
              <Square size={13} aria-hidden="true" />
              {canceling ? "停止中" : "停止"}
            </button>
          </div>
        </div>
        <div className="task-progress-line">
          <span>已用时 {formatDurationLabel(elapsedSeconds)}</span>
          <span>
            已出 {saved}/{total} 张
          </span>
          <span>{eta}</span>
        </div>
        <div className="image-meta-badges">
          <span className="image-meta-badge">{taskSizeLabel(task)}</span>
          <span className="image-meta-badge">{taskQualityLabel(task)}</span>
        </div>
        {images.length > 0 ? (
          <div className={clsx(images.length > 1 && "message-image-grid")}>
            {images.map((image) => (
              <ImageResultCard
                key={image.id}
                image={image}
                siblings={images}
                task={task}
                selected={selectedImageId === image.id}
                submitting={submitting}
                actions={actions}
              />
            ))}
          </div>
        ) : null}
        {placeholders > 0 ? (
          <div
            className={clsx("generation-placeholder-grid", placeholders > 1 && "multi")}
            aria-label={`正在生成 ${placeholders} 张图片`}
          >
            {Array.from({ length: placeholders }, (_, index) => (
              <div className="generation-placeholder-card" key={`${task.id}-placeholder-${index}`}>
                <div className="generation-placeholder-shimmer" />
                <div className="generation-placeholder-meta">
                  <Sparkles size={15} aria-hidden="true" />
                  <span>{taskStageLabel(task)}</span>
                  <small>
                    {saved + index + 1}/{total}
                  </small>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** 乐观插入的用户消息：POST 成功后立刻上屏，等轮询把真消息带回来再换掉。 */
export function OptimisticUserMessage({ entry }: { entry: OptimisticEntry }) {
  return (
    <article className="message-row user">
      <div className="message-bubble">
        <div className="message-meta">
          <span>你</span>
          <span className="badge">已提交</span>
        </div>
        <p>{entry.content}</p>
        {entry.sourceImage ? <SourceReferencePreview image={entry.sourceImage} label="主图" /> : null}
        <SourceReferencePreviewList images={entry.referenceImages} />
      </div>
    </article>
  );
}

export function ConversationMessageItem({
  message,
  task,
  isAdmin,
  submitting,
  selectedImageId,
  rerunningTaskId,
  onRerunTask,
  actions,
}: {
  message: PublicConversationMessage;
  task: PublicTask | null;
  isAdmin: boolean;
  submitting: boolean;
  selectedImageId: string | null;
  rerunningTaskId: string | null;
  onRerunTask: (task: PublicTask, strategy?: "same" | "low_concurrency") => void;
  actions: ImageActions;
}) {
  const isUser = message.role === "user";
  const images = message.images?.length ? message.images : message.image ? [message.image] : [];
  const stopped = task ? isCanceledTask(task) : false;
  const canRerun = !isUser && task?.status === "failed";
  const shouldShowTaskError =
    Boolean(task?.errorMessage) && !isUser && !message.content.startsWith("生成失败：") && !stopped;

  return (
    <article className={clsx("message-row", isUser ? "user" : "assistant")}>
      <div className={clsx("message-bubble", images.length > 1 && "multi-image-message")}>
        <div className="message-meta">
          <span>{isUser ? "你" : "image-2"}</span>
          {task ? (
            <div className="message-meta-actions">
              <span
                className={clsx(
                  "badge",
                  task.status === "succeeded" && "success",
                  task.status === "failed" && (stopped ? "neutral" : "danger"),
                  task.status === "processing" && "warning",
                )}
              >
                <span className={clsx("status-dot", stopped ? "canceled" : task.status)} />
                {taskStageLabel(task)}
              </span>
              {canRerun ? (
                <>
                  <button
                    className="button subtle retry-task-button"
                    type="button"
                    onClick={() => onRerunTask(task)}
                    disabled={rerunningTaskId === task.id || submitting}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    {rerunningTaskId === task.id ? "提交中" : "同参数重跑"}
                  </button>
                  {!stopped ? (
                    <button
                      className="button subtle retry-task-button"
                      type="button"
                      onClick={() => onRerunTask(task, "low_concurrency")}
                      disabled={rerunningTaskId === task.id || submitting}
                    >
                      <Gauge size={13} aria-hidden="true" />
                      低并发重跑
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <p>{displayMessageContent(message.content)}</p>
        {isUser && task?.fixedPrompt ? (
          <div className="message-fixed-prompt">
            <span>已应用会话固定提示词</span>
            <small>{task.fixedPrompt}</small>
            {task.promptSuffix ? <em>本次补充：{task.promptSuffix}</em> : null}
          </div>
        ) : null}
        {isUser && message.sourceImage ? <SourceReferencePreview image={message.sourceImage} label="主图" /> : null}
        {isUser && task ? (
          <SourceReferencePreviewList
            images={task.referenceImages.length > 0 ? task.referenceImages : task.referenceImage ? [task.referenceImage] : []}
          />
        ) : null}
        {shouldShowTaskError && task ? <TaskErrorPanel task={task} isAdmin={isAdmin} /> : null}
        {images.length > 1 ? (
          <div className="message-image-grid">
            {images.map((image) => (
              <ImageResultCard
                key={image.id}
                image={image}
                siblings={images}
                task={task}
                selected={selectedImageId === image.id}
                submitting={submitting}
                actions={actions}
              />
            ))}
          </div>
        ) : images[0] ? (
          <ImageResultCard
            image={images[0]}
            siblings={images}
            task={task}
            selected={selectedImageId === images[0].id}
            submitting={submitting}
            actions={actions}
          />
        ) : null}
      </div>
    </article>
  );
}

/**
 * 失败展示：普通用户只看 task.errorMessage（已是用户级短文案）。
 * 管理员可以展开详情——目前后端还没有单独的详情字段，这里先原样展示并留出位置。
 */
function TaskErrorPanel({ task, isAdmin }: { task: PublicTask; isAdmin: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const message = compactErrorMessage(task.errorMessage);

  return (
    <div className="task-error-panel">
      <small className="toast-line error">{message}</small>
      {isAdmin ? (
        <>
          <button className="button subtle mini-button" type="button" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "收起详情" : "展开详情（管理员）"}
          </button>
          {expanded ? (
            <div className="task-error-detail">
              <pre>{task.errorMessage}</pre>
              <small>上游状态码与原始返回暂未单独落库，接入后会显示在这里。</small>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function SourceReferencePreviewList({ images }: { images: PublicSourceImage[] }) {
  if (images.length === 0) return null;
  if (images.length === 1) return <SourceReferencePreview image={images[0]} />;
  return (
    <div className="message-reference-grid" aria-label={`参考图 ${images.length} 张`}>
      {images.map((image, index) => (
        <SourceReferencePreview key={`${image.id}-${index}`} image={image} label={`参考图 ${index + 1}`} />
      ))}
    </div>
  );
}

export function SourceReferencePreview({ image, label = "参考图" }: { image: PublicSourceImage; label?: string }) {
  const directBase = useImageDirectBase();
  return (
    <div className="message-reference-card">
      <img
        src={withDirectBase(directBase, image.url)}
        alt={image.originalName ?? label}
        loading="lazy"
        decoding="async"
        onError={handleImgError}
      />
      <div>
        <span>{label}</span>
        <small>{image.originalName ?? image.mimeType ?? "上传图片"}</small>
      </div>
    </div>
  );
}
