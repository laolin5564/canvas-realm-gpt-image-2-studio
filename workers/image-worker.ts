import { appConfig } from "../lib/config";
import * as db from "../lib/db";
import { cleanupExpiredGeneratedImages } from "../lib/image-cleanup";
import { fillProcessingSlots, inFlightTaskCount, onSlotFreed } from "../lib/queue";

const cleanupIntervalMs = 60 * 60 * 1000;
const reclaimIntervalMs = 60 * 1000;
const sessionCleanupIntervalMs = 24 * 60 * 60 * 1000;
const staleProcessingMaxAgeMinutes = 30;
const defaultPollIntervalMs = 1_000;

// 有槽位释放就立刻补位，因此轮询只是兜底，间隔可以压到 1s。
// 显式配置 WORKER_POLL_INTERVAL_MS 时仍然以配置为准。
const pollIntervalMs = process.env.WORKER_POLL_INTERVAL_MS
  ? appConfig.workerPollIntervalMs
  : defaultPollIntervalMs;

let wakeUp: (() => void) | null = null;
let wakeRequested = false;

onSlotFreed(() => {
  wakeRequested = true;
  wakeUp?.();
});

function waitForWork(ms: number): Promise<void> {
  if (wakeRequested) {
    // 槽位在上一轮循环体执行期间就释放了，别再白等一个轮询间隔。
    wakeRequested = false;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      wakeRequested = false;
      clearTimeout(timer);
      wakeUp = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakeUp = finish;
  });
}

async function main(): Promise<void> {
  db.getDb();
  console.log(`image worker started (poll interval ${pollIntervalMs}ms)`);

  // 单 worker 进程：启动时所有 processing 任务必然是上个进程留下的孤儿，直接重新入队。
  const requeued = db.requeueOrphanProcessingTasks();
  if (requeued > 0) {
    console.log(`requeued ${requeued} orphan processing task(s) from previous worker run`);
  }

  let lastCleanupAt = 0;
  let lastReclaimAt = 0;
  let lastSessionCleanupAt = 0;

  while (true) {
    try {
      const concurrency = db.getImageConcurrencySetting();
      const claimed = fillProcessingSlots(concurrency);
      if (claimed > 0) {
        console.log(
          `claimed ${claimed} image task(s), in_flight=${inFlightTaskCount()}, concurrency=${concurrency}`,
        );
      }
      if (Date.now() - lastReclaimAt > reclaimIntervalMs) {
        lastReclaimAt = Date.now();
        const reclaimed = db.reclaimStaleProcessingTasks(staleProcessingMaxAgeMinutes);
        if (reclaimed > 0) {
          console.log(`reclaimed ${reclaimed} stale processing task(s) older than ${staleProcessingMaxAgeMinutes}m`);
        }
      }
      if (Date.now() - lastSessionCleanupAt > sessionCleanupIntervalMs) {
        lastSessionCleanupAt = Date.now();
        // cleanupExpiredSessions 由 lib/db 提供；用可选调用是为了兼容还没合入该函数的分支。
        const removedSessions = (db as { cleanupExpiredSessions?: () => number }).cleanupExpiredSessions?.();
        if (removedSessions) {
          console.log(`cleaned ${removedSessions} expired session(s)`);
        }
      }
      if (Date.now() - lastCleanupAt > cleanupIntervalMs) {
        lastCleanupAt = Date.now();
        const cleanup = await cleanupExpiredGeneratedImages();
        if (cleanup.deleted > 0) {
          console.log(`cleaned ${cleanup.deleted} expired image(s), retention=${cleanup.retentionDays}d`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown worker error";
      console.error(message);
    }

    await waitForWork(pollIntervalMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
