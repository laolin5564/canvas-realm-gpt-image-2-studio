import {
  claimQueuedTasks,
  createGeneratedImage,
  createId,
  getGenerationTask,
  getImageFilePathById,
  isTaskStopped,
  markTaskFailed,
  markTaskSucceeded,
  recordImageGenerationSuccess,
  recordImageTimeoutFailure,
  resetImageTimeoutStreak,
  updateTaskProgressStage,
} from "./db";
import { normalizeImageConcurrency } from "./concurrency";
import { callImageModel } from "./image-provider";
import { isModelTimeoutMessage } from "./model-error";
import { parseSize, saveGeneratedImageFile } from "./storage";
import type { GenerationTaskRow } from "./types";

export async function processNextQueuedTask(): Promise<boolean> {
  const task = claimQueuedTasks(1)[0];
  if (!task) {
    return false;
  }

  await processClaimedTask(task);
  return true;
}

async function processClaimedTask(task: GenerationTaskRow): Promise<void> {
  const { width, height } = parseSize(task.size);
  let savedCount = 0;

  try {
    let extraRefIds: string[] = [];
    try {
      extraRefIds = task.reference_image_ids ? JSON.parse(task.reference_image_ids) : [];
    } catch {
      // malformed JSON, treat as empty
    }
    const allRefIds = Array.from(
      new Set(
        [task.source_image_id, task.reference_image_id, ...extraRefIds].filter((id): id is string => Boolean(id)),
      ),
    );
    const sourceImagePaths = allRefIds
      .map((id) => getImageFilePathById(id))
      .filter((filePath): filePath is string => Boolean(filePath));
    updateTaskProgressStage(task.id, "generating");

    // 每张图片生成完立即落盘入库，让用户在多图任务中尽早看到已完成的部分。
    const saveImage = async (item: { bytes: Uint8Array; mimeType: string | null }): Promise<void> => {
      const latest = getGenerationTask(task.id);
      if (!latest || latest.status !== "processing") {
        // AbortError 语义：让 image-provider 直接终止，而不是当渠道故障去 failover 重试。
        throw new DOMException("任务已停止", "AbortError");
      }

      const imageId = createId("img");
      const filePath = await saveGeneratedImageFile({
        taskId: task.id,
        imageId,
        bytes: item.bytes,
        mimeType: item.mimeType,
      });

      createGeneratedImage({
        id: imageId,
        taskId: task.id,
        filePath,
        width,
        height,
        prompt: task.prompt,
        mode: task.mode,
        templateId: task.template_id,
      });
      savedCount += 1;
    };

    await runWithTaskCancellation(task.id, (signal) =>
      callImageModel(task, sourceImagePaths, signal, saveImage),
    );
    const current = getGenerationTask(task.id);
    if (!current || current.status !== "processing") {
      return;
    }

    markTaskSucceeded(task.id, savedCount);
    recordImageGenerationSuccess();
  } catch (error) {
    if (isTaskStopped(task.id)) {
      return;
    }
    if (savedCount > 0) {
      // 部分图片已生成成功：保留成果按成功收尾，而不是让整单作废。
      const current = getGenerationTask(task.id);
      if (current && current.status === "processing") {
        markTaskSucceeded(task.id, savedCount);
        recordImageGenerationSuccess();
        return;
      }
      return;
    }
    let message = error instanceof Error ? error.message : "生成任务处理失败";
    if (isModelTimeoutMessage(message)) {
      const timeout = recordImageTimeoutFailure();
      if (timeout.degraded) {
        message = `${message} 已连续 ${timeout.timeoutStreak} 次超时，系统已自动把并发请求数从 ${timeout.previousConcurrency} 降到 1。`;
      }
    } else {
      resetImageTimeoutStreak();
    }
    markTaskFailed(task.id, message);
  }
}

export async function processQueuedTasks(maxTasks = 1): Promise<number> {
  const concurrency = normalizeImageConcurrency(maxTasks);
  const tasks = claimQueuedTasks(concurrency);
  await Promise.all(tasks.map((task) => processClaimedTask(task)));
  return tasks.length;
}

// 滑动窗口调度：有空槽就立刻领取新任务开工，不等同批慢任务收尾。
// 相比按波次 Promise.all，混合快慢任务时吞吐显著更高。
const inFlightTasks = new Set<Promise<void>>();

export function inFlightTaskCount(): number {
  return inFlightTasks.size;
}

export function fillProcessingSlots(maxConcurrency: number): number {
  const capacity = normalizeImageConcurrency(maxConcurrency) - inFlightTasks.size;
  if (capacity <= 0) {
    return 0;
  }

  const tasks = claimQueuedTasks(capacity);
  for (const task of tasks) {
    const running: Promise<void> = processClaimedTask(task)
      .catch((error) => {
        console.error(
          `task ${task.id} processing crashed: ${error instanceof Error ? error.message : error}`,
        );
      })
      .finally(() => {
        inFlightTasks.delete(running);
      });
    inFlightTasks.add(running);
  }
  return tasks.length;
}

async function runWithTaskCancellation<T>(
  taskId: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setInterval(() => {
    const current = getGenerationTask(taskId);
    if (!current || current.status !== "processing") {
      controller.abort();
    }
  }, 500);

  try {
    return await operation(controller.signal);
  } finally {
    clearInterval(timer);
  }
}
