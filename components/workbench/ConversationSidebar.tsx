"use client";

import { Layers, RefreshCw, Trash2 } from "lucide-react";
import clsx from "clsx";
import { formatDateTime, modeLabels } from "@/components/client-api";
import type { PublicConversation } from "@/lib/types";
import { isCanceledTask, taskStageLabel } from "@/components/workbench/task-progress";
import { compactErrorMessage } from "@/components/workbench/thread-model";

export function ConversationSidebar({
  conversations,
  activeConversationId,
  onOpen,
  onDelete,
  onRefresh,
}: {
  conversations: PublicConversation[];
  activeConversationId: string | null;
  onOpen: (conversationId: string) => void;
  onDelete: (conversationId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <aside className="panel queue-panel">
      <div className="panel-header">
        <div>
          <h2>会话列表</h2>
          <p>点击进入上下文对话</p>
        </div>
        <button className="icon-button ghost" type="button" onClick={onRefresh} aria-label="刷新会话列表">
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="panel-body queue-list">
        {conversations.length > 0 ? (
          conversations.map((conversation) => {
            const task = conversation.latestTask;
            const stopped = task ? isCanceledTask(task) : false;
            return (
              <article
                className={clsx(
                  "queue-item conversation-list-item",
                  activeConversationId === conversation.id && "active",
                )}
                key={conversation.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(conversation.id)}
                onKeyDown={(event) => {
                  // 删除按钮上的 Enter 会冒泡到这里，只认落在卡片本身的键盘事件。
                  if (event.target !== event.currentTarget) {
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen(conversation.id);
                  }
                }}
              >
                <div className="queue-item-top">
                  <span className="badge">
                    <Layers size={13} aria-hidden="true" />
                    {task ? modeLabels[task.mode] : "会话"}
                  </span>
                  <div className="conversation-item-actions">
                    {task ? (
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
                    ) : null}
                    <button
                      className="icon-button danger"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDelete(conversation.id);
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                      title="删除会话"
                      aria-label={`删除会话 ${conversation.title}`}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <strong>{conversation.title}</strong>
                <div className="conversation-owner-line">归属用户：{conversation.userName ?? "未绑定用户"}</div>
                <div className="queue-prompt">{task?.prompt ?? "新的图片会话"}</div>
                <small>{formatDateTime(conversation.updatedAt)}</small>
                {task?.errorMessage && !stopped ? (
                  <small className="toast-line error">{compactErrorMessage(task.errorMessage)}</small>
                ) : null}
              </article>
            );
          })
        ) : (
          <div className="empty-state">
            <span>暂无会话</span>
          </div>
        )}
      </div>
    </aside>
  );
}
