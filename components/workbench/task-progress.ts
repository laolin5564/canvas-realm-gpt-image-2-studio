import { imageSizeLabels, normalizeImageQualityOption, normalizeImageSizeOption } from "@/lib/image-options";
import type { ImageQualityOption } from "@/lib/image-options";
import { progressStageLabels, statusLabels } from "@/components/client-api";
import type { PublicTask } from "@/lib/types";

/**
 * 任务进度的纯计算层：阶段文案、已用时、已出张数、预计剩余时间。
 * 不依赖 React / DOM / node:sqlite，便于单测。
 */

/** 与 lib/db.ts 的 taskStoppedMessage 保持一致；前端不能 import lib/db（node:sqlite）。 */
export const taskStoppedMessage = "用户已停止生成";

/** 没有历史样本时给的兜底文案。 */
export const fallbackEtaText = "约 30-40 秒/张";

/** 估算平均单张耗时时最多回看几条成功任务。 */
const averageSampleSize = 5;

export function isActiveTask(task: PublicTask): boolean {
  return task.status === "queued" || task.status === "processing";
}

/** 取消不是独立 status：failed + canceled 阶段（或固定文案）都算「已停止」。 */
export function isCanceledTask(task: PublicTask): boolean {
  return task.status === "failed" && (task.progressStage === "canceled" || task.errorMessage === taskStoppedMessage);
}

export function taskStageLabel(task: PublicTask): string {
  return task.progressStage ? progressStageLabels[task.progressStage] : statusLabels[task.status];
}

export function savedImageCount(task: PublicTask): number {
  return task.images?.length ?? 0;
}

export function taskSizeLabel(task: PublicTask): string {
  return imageSizeLabels[normalizeImageSizeOption(task.size)];
}

/** 小标签用的短质量文案，完整文案在参数面板的下拉里。 */
const shortQualityLabels: Record<ImageQualityOption, string> = {
  auto: "质量自动",
  low: "低质量",
  medium: "中质量",
  high: "高清",
};

export function taskQualityLabel(task: PublicTask): string {
  return shortQualityLabels[normalizeImageQualityOption(task.quality)];
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 已用时：优先从 startedAt 起算，还没被 worker 领走时退回 createdAt。 */
export function elapsedSecondsFor(task: PublicTask, nowMs: number): number {
  const startedAt = parseTime(task.startedAt) ?? parseTime(task.createdAt);
  if (startedAt === null) {
    return 0;
  }
  return Math.max(0, Math.round((nowMs - startedAt) / 1000));
}

/**
 * 用本会话最近的成功任务估算「单张平均耗时」。
 * 没有可用样本（没成功过 / 时间戳缺失 / 一张都没出）时返回 null，由调用方走兜底文案。
 */
export function averageSecondsPerImage(tasks: PublicTask[]): number | null {
  const samples = tasks
    .filter((task) => task.status === "succeeded" && savedImageCount(task) > 0)
    .slice(-averageSampleSize);

  let totalSeconds = 0;
  let totalImages = 0;
  for (const task of samples) {
    const startedAt = parseTime(task.startedAt) ?? parseTime(task.createdAt);
    const completedAt = parseTime(task.completedAt);
    if (startedAt === null || completedAt === null || completedAt <= startedAt) {
      continue;
    }
    totalSeconds += (completedAt - startedAt) / 1000;
    totalImages += savedImageCount(task);
  }

  if (totalImages === 0 || totalSeconds <= 0) {
    return null;
  }
  return totalSeconds / totalImages;
}

export interface RemainingEstimateInput {
  quantity: number;
  savedCount: number;
  elapsedSeconds: number;
  secondsPerImage: number | null;
}

/**
 * 预计剩余秒数：剩余张数 × 单张均耗时，再扣掉当前这张已经跑掉的时间。
 * 扣减最多只扣单张均耗时的 90%，避免长尾任务把预估压到 0 一直不动。
 */
export function estimateRemainingSeconds({
  quantity,
  savedCount,
  elapsedSeconds,
  secondsPerImage,
}: RemainingEstimateInput): number | null {
  const remainingImages = Math.max(0, Math.max(1, quantity) - Math.max(0, savedCount));
  if (remainingImages === 0) {
    return 0;
  }
  if (secondsPerImage === null || secondsPerImage <= 0) {
    return null;
  }

  const expected = remainingImages * secondsPerImage;
  const spentOnCurrent = Math.min(
    Math.max(0, elapsedSeconds - Math.max(0, savedCount) * secondsPerImage),
    secondsPerImage * 0.9,
  );
  return Math.max(1, Math.round(expected - spentOnCurrent));
}

/** 秒数转中文短文案：小于 1 分钟只说秒。 */
export function formatDurationLabel(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  if (safeSeconds < 60) {
    return `${safeSeconds} 秒`;
  }
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/** 占位卡右下角的「预计剩余」文案。 */
export function remainingEtaText(input: RemainingEstimateInput): string {
  const remaining = estimateRemainingSeconds(input);
  if (remaining === null) {
    return fallbackEtaText;
  }
  if (remaining === 0) {
    return "即将完成";
  }
  return `预计还需 ${formatDurationLabel(remaining)}`;
}
