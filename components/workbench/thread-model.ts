import type { PublicConversation, PublicConversationMessage, PublicTask } from "@/lib/types";
import { isActiveTask } from "@/components/workbench/task-progress";
import type { OptimisticEntry } from "@/components/workbench/types";

/**
 * 线程渲染项：消息之外，queued/processing 的任务单独占一张进度卡。
 * 后端只在任务结束时才写 assistant 消息，所以「生成中」这段必须由 tasks 驱动。
 */
export type ThreadItem =
  | { kind: "message"; id: string; message: PublicConversationMessage; task: PublicTask | null }
  | { kind: "task"; id: string; task: PublicTask; optimistic: boolean }
  | { kind: "optimistic-message"; id: string; entry: OptimisticEntry };

export function buildThreadItems(
  conversation: PublicConversation | null,
  optimistic: OptimisticEntry[] = [],
): ThreadItem[] {
  const tasks = conversation?.tasks ?? [];
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const items: ThreadItem[] = [];
  const renderedTaskIds = new Set<string>();

  for (const message of conversation?.messages ?? []) {
    const task = message.taskId ? taskMap.get(message.taskId) ?? null : null;
    items.push({ kind: "message", id: message.id, message, task });
    if (message.role === "user" && task && isActiveTask(task) && !renderedTaskIds.has(task.id)) {
      renderedTaskIds.add(task.id);
      items.push({ kind: "task", id: `task_${task.id}`, task, optimistic: false });
    }
  }

  // 兜底：任务已经建好但用户消息还没随详情返回时，进度卡也要出现。
  for (const task of tasks) {
    if (isActiveTask(task) && !renderedTaskIds.has(task.id)) {
      renderedTaskIds.add(task.id);
      items.push({ kind: "task", id: `task_${task.id}`, task, optimistic: false });
    }
  }

  for (const entry of optimistic) {
    if (renderedTaskIds.has(entry.task.id)) {
      continue;
    }
    renderedTaskIds.add(entry.task.id);
    items.push({ kind: "optimistic-message", id: entry.id, entry });
    items.push({ kind: "task", id: `task_${entry.task.id}`, task: entry.task, optimistic: true });
  }

  return items;
}

/** 服务端详情里已经出现同一个 taskId，就把本地乐观条目丢掉。 */
export function pruneOptimisticEntries(
  entries: OptimisticEntry[],
  conversation: PublicConversation | null,
): OptimisticEntry[] {
  if (!conversation) {
    return entries;
  }
  const knownTaskIds = new Set<string>();
  for (const task of conversation.tasks ?? []) {
    knownTaskIds.add(task.id);
  }
  for (const message of conversation.messages ?? []) {
    if (message.taskId) {
      knownTaskIds.add(message.taskId);
    }
  }
  return entries.filter((entry) => entry.conversationId === conversation.id && !knownTaskIds.has(entry.task.id));
}

/** 任务里能直接展示的出图（部分成功也要能看到）。 */
export function taskImagesOf(task: PublicTask | null): PublicTask["images"] {
  return task?.images ?? [];
}

export function displayMessageContent(content: string): string {
  if (!content.startsWith("生成失败：")) {
    return content;
  }
  return `生成失败：${compactErrorMessage(content.replace(/^生成失败：\s*/, ""))}`;
}

export function compactErrorMessage(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  if (value.includes("524") || /timeout occurred/i.test(value)) {
    return "模型接口超时（524）：上游生成服务响应太慢，请稍后重试，或在管理员后台降低并发请求数。";
  }

  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}
