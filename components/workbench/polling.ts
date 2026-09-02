import type { PublicConversation, PublicTask } from "@/lib/types";
import { isActiveTask } from "@/components/workbench/task-progress";

/**
 * 会话轮询的纯策略层：间隔选择、乱序响应守卫、失败提示门槛。
 * 真正的定时器 / AbortController 在 usePolling 里，这里只留可单测的判断。
 */

/** 有任务在跑时的轮询间隔。 */
export const activePollIntervalMs = 2800;
/** 全部任务都结束后的降频间隔。 */
export const idlePollIntervalMs = 15000;
/** 连续失败几次才打扰用户。 */
export const pollFailureToastThreshold = 3;

export function nextPollDelayMs(hasActiveTasks: boolean): number {
  return hasActiveTasks ? activePollIntervalMs : idlePollIntervalMs;
}

/**
 * 轮询序号守卫：只接受序号严格大于「已应用序号」的响应。
 * 慢请求先发后到时会被丢弃，不会把旧快照盖回新状态。
 */
export function shouldAcceptResponse(responseSeq: number, appliedSeq: number): boolean {
  return Number.isFinite(responseSeq) && responseSeq > appliedSeq;
}

export function shouldReportPollFailure(consecutiveFailures: number): boolean {
  return consecutiveFailures >= pollFailureToastThreshold;
}

/** 页面切到后台就别再打服务端了。 */
export function shouldPollNow(visibilityState: string): boolean {
  return visibilityState !== "hidden";
}

export function activeTasks(conversation: PublicConversation | null): PublicTask[] {
  return (conversation?.tasks ?? []).filter(isActiveTask);
}

export function hasActiveTasks(conversation: PublicConversation | null, extraTasks: PublicTask[] = []): boolean {
  return activeTasks(conversation).length > 0 || extraTasks.some(isActiveTask);
}
