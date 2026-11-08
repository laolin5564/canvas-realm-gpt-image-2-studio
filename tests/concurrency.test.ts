import { describe, expect, test } from "bun:test";
import {
  defaultUpstreamImageMaxInflight,
  availableTaskSlots,
  normalizeImageConcurrency,
  taskImageConcurrency,
  withUpstreamImageSlot,
  resolveUpstreamImageMaxInflight,
  Semaphore,
} from "@/lib/concurrency";
import { createGenerationTaskSchema, updateAdminSettingsSchema } from "@/lib/validation";

describe("image concurrency", () => {
  test("normalizes configured concurrency to the supported range", () => {
    expect(normalizeImageConcurrency(0)).toBe(0);
    expect(normalizeImageConcurrency(-5)).toBe(1);
    expect(normalizeImageConcurrency(1)).toBe(1);
    expect(normalizeImageConcurrency(100)).toBe(100);
    expect(normalizeImageConcurrency(101)).toBe(100);
    expect(normalizeImageConcurrency("bad", 2)).toBe(2);
  });

  test("admin settings accept up to 100 concurrent requests", () => {
    expect(updateAdminSettingsSchema.parse({ imageConcurrency: 0 }).imageConcurrency).toBe(0);
    expect(updateAdminSettingsSchema.parse({ imageConcurrency: 100 }).imageConcurrency).toBe(100);
    let rejected = false;
    try {
      updateAdminSettingsSchema.parse({ imageConcurrency: 101 });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test("unlimited scheduling keeps claiming even above the finite concurrency range", () => {
    expect(availableTaskSlots(10, 9)).toBe(1);
    expect(availableTaskSlots(10, 12)).toBe(0);
    expect(availableTaskSlots(0, 12)).toBeGreaterThan(0);
    expect(availableTaskSlots(0, 150)).toBeGreaterThan(0);
  });

  test("unlimited task batches still generate every image and honor a serial retry", () => {
    expect(taskImageConcurrency(null, 0, 4)).toBe(4);
    expect(taskImageConcurrency(1, 0, 4)).toBe(1);
    expect(taskImageConcurrency(null, 2, 4)).toBe(2);
  });

  test("task-level low concurrency retry only accepts the safe override", () => {
    const parsed = createGenerationTaskSchema.parse({
      mode: "text_to_image",
      prompt: "测试低并发重试",
      requestedConcurrency: 1,
    });

    expect(parsed.requestedConcurrency).toBe(1);
    let rejected = false;
    try {
      createGenerationTaskSchema.parse({
        mode: "text_to_image",
        prompt: "测试高并发覆盖",
        requestedConcurrency: 2,
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

describe("上游生图信号量", () => {
  test("unlimited mode starts more than the default 20 requests without a hidden queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    const pending = Array.from({ length: 25 }, () => withUpstreamImageSlot(async () => {
      started += 1;
      await gate;
    }, true));
    try {
      expect(started).toBe(25);
    } finally {
      release();
      await Promise.all(pending);
    }
  });
  test("同时在跑的操作数不会超过上限", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    let finished = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        semaphore.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
          });
          active -= 1;
          finished += 1;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(finished).toBe(6);
    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.pendingCount).toBe(0);
  });

  test("操作抛错也会释放槽位", async () => {
    const semaphore = new Semaphore(1);
    let failed = false;
    try {
      await semaphore.run(async () => {
        throw new Error("boom");
      });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    expect(semaphore.activeCount).toBe(0);

    await semaphore.run(async () => undefined);
    expect(semaphore.activeCount).toBe(0);
  });

  test("上限至少为 1", () => {
    expect(new Semaphore(0).maxConcurrency).toBe(1);
    expect(new Semaphore(-5).maxConcurrency).toBe(1);
  });

  test("IMAGE_UPSTREAM_MAX_INFLIGHT 可覆盖默认 20", () => {
    expect(defaultUpstreamImageMaxInflight).toBe(20);
    expect(resolveUpstreamImageMaxInflight(undefined)).toBe(20);
    expect(resolveUpstreamImageMaxInflight("")).toBe(20);
    expect(resolveUpstreamImageMaxInflight("bad")).toBe(20);
    expect(resolveUpstreamImageMaxInflight("0")).toBe(20);
    expect(resolveUpstreamImageMaxInflight("6")).toBe(6);
    expect(resolveUpstreamImageMaxInflight("48.9")).toBe(48);
  });
});
