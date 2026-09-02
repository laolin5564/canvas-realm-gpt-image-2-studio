"use client";

import { useCallback, useRef } from "react";
import { apiJson } from "@/components/client-api";
import type { PublicConversation, PublicTask } from "@/lib/types";
import { nextPollDelayMs } from "@/components/workbench/polling";
import { isActiveTask } from "@/components/workbench/task-progress";
import { usePolling } from "@/components/workbench/usePolling";
import type { ConversationListResponse, ConversationResponse } from "@/components/workbench/types";

interface PollPayload {
  conversations: PublicConversation[];
  conversation: PublicConversation | null;
}

export interface ConversationPollingController {
  refresh: () => void;
  /** 乐观插入的新任务先登记进来，结束时才能被识别成「刚跑完」。 */
  markTaskRunning: (taskId: string) => void;
  resetRunning: () => void;
}

/**
 * 会话列表 + 当前会话详情的轮询。有任务在跑时 2.8s，全部结束后降到 15s；
 * 页面隐藏时不发请求；旧响应按序号丢弃；切换会话中止在途请求。
 */
export function useConversationPolling({
  activeConversationId,
  active,
  onConversations,
  onConversation,
  onTasksFinished,
  onUnauthorized,
  onFailure,
}: {
  activeConversationId: string | null;
  active: boolean;
  onConversations: (conversations: PublicConversation[]) => void;
  onConversation: (conversation: PublicConversation) => void;
  onTasksFinished: (tasks: PublicTask[]) => void;
  onUnauthorized: () => void;
  onFailure: (error: Error) => void;
}): ConversationPollingController {
  const runningTaskIdsRef = useRef<Set<string>>(new Set());

  const apply = useCallback(
    (payload: PollPayload) => {
      onConversations(payload.conversations);
      if (!payload.conversation) {
        return;
      }
      onConversation(payload.conversation);

      const tasks = payload.conversation.tasks ?? [];
      const stillRunning = new Set(tasks.filter(isActiveTask).map((task) => task.id));
      const finishedIds = [...runningTaskIdsRef.current].filter((taskId) => !stillRunning.has(taskId));
      runningTaskIdsRef.current = stillRunning;
      if (finishedIds.length > 0) {
        onTasksFinished(tasks.filter((task) => finishedIds.includes(task.id)));
      }
    },
    [onConversation, onConversations, onTasksFinished],
  );

  const { refresh } = usePolling<PollPayload>({
    key: activeConversationId ?? "conversations",
    intervalMs: nextPollDelayMs(active),
    run: async (signal) => {
      const [list, detail] = await Promise.all([
        apiJson<ConversationListResponse>("/api/conversations?limit=24", { signal }),
        activeConversationId
          ? apiJson<ConversationResponse>(`/api/conversations/${activeConversationId}`, { signal })
          : Promise.resolve(null),
      ]);
      return { conversations: list.conversations, conversation: detail?.conversation ?? null };
    },
    apply,
    onUnauthorized,
    onPersistentFailure: onFailure,
  });

  return {
    refresh,
    markTaskRunning: useCallback((taskId: string) => {
      runningTaskIdsRef.current.add(taskId);
    }, []),
    resetRunning: useCallback(() => {
      runningTaskIdsRef.current = new Set();
    }, []),
  };
}
