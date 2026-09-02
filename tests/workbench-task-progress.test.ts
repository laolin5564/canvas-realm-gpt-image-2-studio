import { describe, expect, test } from "bun:test";
import type { PublicImage, PublicTask } from "@/lib/types";
import {
  averageSecondsPerImage,
  elapsedSecondsFor,
  estimateRemainingSeconds,
  fallbackEtaText,
  formatDurationLabel,
  isActiveTask,
  isCanceledTask,
  remainingEtaText,
  savedImageCount,
  taskQualityLabel,
  taskSizeLabel,
} from "@/components/workbench/task-progress";

function image(id: string): PublicImage {
  return {
    id,
    taskId: "task",
    userId: null,
    userName: null,
    userEmail: null,
    url: `/api/files/${id}.png`,
    thumbnailUrl: `/api/files/${id}.png?thumb=1`,
    width: 1024,
    height: 1024,
    prompt: "prompt",
    mode: "text_to_image",
    templateId: null,
    templateName: null,
    createdAt: "2026-09-02T00:00:00.000Z",
  };
}

function task(overrides: Partial<PublicTask> = {}): PublicTask {
  return {
    id: "task_1",
    userId: null,
    conversationId: "conv_1",
    mode: "text_to_image",
    status: "processing",
    progressStage: "generating",
    prompt: "prompt",
    fixedPrompt: null,
    promptSuffix: null,
    negativePrompt: null,
    size: "ecommerce_main_1_1",
    quality: "high",
    quantity: 2,
    requestedConcurrency: null,
    templateId: null,
    sourceImageId: null,
    referenceImageId: null,
    referenceImage: null,
    referenceImages: [],
    referenceStrength: 0.6,
    styleStrength: 0.7,
    costEstimate: 0,
    errorMessage: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    startedAt: "2026-09-02T00:00:10.000Z",
    completedAt: null,
    images: [],
    ...overrides,
  };
}

const startedMs = Date.parse("2026-09-02T00:00:10.000Z");

describe("task state helpers", () => {
  test("queued and processing count as active", () => {
    expect(isActiveTask(task({ status: "queued" }))).toBe(true);
    expect(isActiveTask(task({ status: "processing" }))).toBe(true);
    expect(isActiveTask(task({ status: "succeeded" }))).toBe(false);
    expect(isActiveTask(task({ status: "failed" }))).toBe(false);
  });

  test("cancelled tasks are failed tasks carrying the stop marker", () => {
    expect(isCanceledTask(task({ status: "failed", progressStage: "canceled" }))).toBe(true);
    expect(isCanceledTask(task({ status: "failed", progressStage: "failed", errorMessage: "用户已停止生成" }))).toBe(true);
    expect(isCanceledTask(task({ status: "failed", progressStage: "failed", errorMessage: "上游超时" }))).toBe(false);
  });

  test("size and quality badges use the Chinese labels", () => {
    expect(taskSizeLabel(task())).toBe("电商主图 1:1");
    expect(taskQualityLabel(task({ quality: "high" }))).toBe("高清");
    expect(taskQualityLabel(task({ quality: null }))).toBe("质量自动");
  });

  test("elapsed time starts at startedAt and falls back to createdAt", () => {
    expect(elapsedSecondsFor(task(), startedMs + 42_000)).toBe(42);
    expect(elapsedSecondsFor(task({ startedAt: null }), startedMs + 42_000)).toBe(52);
    expect(elapsedSecondsFor(task(), startedMs - 5_000)).toBe(0);
  });

  test("saved image count follows the images returned by polling", () => {
    expect(savedImageCount(task())).toBe(0);
    expect(savedImageCount(task({ images: [image("a"), image("b")] }))).toBe(2);
  });
});

describe("average seconds per image", () => {
  test("returns null without a usable succeeded sample", () => {
    expect(averageSecondsPerImage([])).toBe(null);
    expect(averageSecondsPerImage([task({ status: "processing" })])).toBe(null);
    expect(
      averageSecondsPerImage([task({ status: "succeeded", completedAt: null, images: [image("a")] })]),
    ).toBe(null);
    expect(averageSecondsPerImage([task({ status: "succeeded", completedAt: "2026-09-02T00:01:10.000Z" })])).toBe(null);
  });

  test("divides total duration by total images across recent successes", () => {
    const samples = [
      task({
        id: "t1",
        status: "succeeded",
        startedAt: "2026-09-02T00:00:00.000Z",
        completedAt: "2026-09-02T00:01:00.000Z",
        images: [image("a"), image("b")],
      }),
      task({
        id: "t2",
        status: "succeeded",
        startedAt: "2026-09-02T00:02:00.000Z",
        completedAt: "2026-09-02T00:02:40.000Z",
        images: [image("c")],
      }),
    ];
    // (60s + 40s) / 3 张
    const average = averageSecondsPerImage(samples) ?? 0;
    expect(Number(average.toFixed(4))).toBe(33.3333);
  });

  test("ignores samples whose completion is not after the start", () => {
    const samples = [
      task({
        status: "succeeded",
        startedAt: "2026-09-02T00:01:00.000Z",
        completedAt: "2026-09-02T00:00:00.000Z",
        images: [image("a")],
      }),
    ];
    expect(averageSecondsPerImage(samples)).toBe(null);
  });
});

describe("remaining time estimate", () => {
  test("returns null when there is no sample to estimate from", () => {
    expect(estimateRemainingSeconds({ quantity: 2, savedCount: 0, elapsedSeconds: 10, secondsPerImage: null })).toBe(null);
    expect(estimateRemainingSeconds({ quantity: 2, savedCount: 0, elapsedSeconds: 10, secondsPerImage: 0 })).toBe(null);
  });

  test("returns 0 once every image is saved", () => {
    expect(estimateRemainingSeconds({ quantity: 2, savedCount: 2, elapsedSeconds: 90, secondsPerImage: 30 })).toBe(0);
    expect(estimateRemainingSeconds({ quantity: 2, savedCount: 5, elapsedSeconds: 90, secondsPerImage: 30 })).toBe(0);
  });

  test("counts only the images still missing", () => {
    // 还差 1 张 × 30 秒，当前这张才刚开始（30 秒里前 30 秒都花在第一张上）。
    expect(estimateRemainingSeconds({ quantity: 2, savedCount: 1, elapsedSeconds: 30, secondsPerImage: 30 })).toBe(30);
  });

  test("subtracts the time already spent on the in-flight image", () => {
    expect(estimateRemainingSeconds({ quantity: 1, savedCount: 0, elapsedSeconds: 10, secondsPerImage: 30 })).toBe(20);
  });

  test("never drops to zero while an image is still running", () => {
    // 已经跑了 300 秒远超均值，仍然保留 10% 的余量而不是直接归零。
    expect(estimateRemainingSeconds({ quantity: 1, savedCount: 0, elapsedSeconds: 300, secondsPerImage: 30 })).toBe(3);
  });

  test("treats a zero quantity as one image", () => {
    expect(estimateRemainingSeconds({ quantity: 0, savedCount: 0, elapsedSeconds: 0, secondsPerImage: 20 })).toBe(20);
  });
});

describe("eta text", () => {
  test("falls back to the fixed hint without a sample", () => {
    expect(remainingEtaText({ quantity: 2, savedCount: 0, elapsedSeconds: 5, secondsPerImage: null })).toBe(
      fallbackEtaText,
    );
  });

  test("says 即将完成 once nothing is left", () => {
    expect(remainingEtaText({ quantity: 1, savedCount: 1, elapsedSeconds: 30, secondsPerImage: 30 })).toBe("即将完成");
  });

  test("renders a Chinese duration otherwise", () => {
    expect(remainingEtaText({ quantity: 3, savedCount: 0, elapsedSeconds: 0, secondsPerImage: 30 })).toBe(
      "预计还需 1 分 30 秒",
    );
  });

  test("formats durations under a minute in seconds", () => {
    expect(formatDurationLabel(0)).toBe("0 秒");
    expect(formatDurationLabel(45)).toBe("45 秒");
    expect(formatDurationLabel(60)).toBe("1 分");
    expect(formatDurationLabel(125)).toBe("2 分 5 秒");
  });
});
