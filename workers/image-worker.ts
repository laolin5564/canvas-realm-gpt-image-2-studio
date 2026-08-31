import { appConfig } from "../lib/config";
import {
  getDb,
  getImageConcurrencySetting,
  reclaimStaleProcessingTasks,
  requeueOrphanProcessingTasks,
} from "../lib/db";
import { cleanupExpiredGeneratedImages } from "../lib/image-cleanup";
import { fillProcessingSlots, inFlightTaskCount } from "../lib/queue";

const cleanupIntervalMs = 60 * 60 * 1000;
const reclaimIntervalMs = 60 * 1000;
const staleProcessingMaxAgeMinutes = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  getDb();
  console.log("image worker started");

  // 单 worker 进程：启动时所有 processing 任务必然是上个进程留下的孤儿，直接重新入队。
  const requeued = requeueOrphanProcessingTasks();
  if (requeued > 0) {
    console.log(`requeued ${requeued} orphan processing task(s) from previous worker run`);
  }

  let lastCleanupAt = 0;
  let lastReclaimAt = 0;

  while (true) {
    try {
      const concurrency = getImageConcurrencySetting();
      const claimed = fillProcessingSlots(concurrency);
      if (claimed > 0) {
        console.log(
          `claimed ${claimed} image task(s), in_flight=${inFlightTaskCount()}, concurrency=${concurrency}`,
        );
      }
      if (Date.now() - lastReclaimAt > reclaimIntervalMs) {
        lastReclaimAt = Date.now();
        const reclaimed = reclaimStaleProcessingTasks(staleProcessingMaxAgeMinutes);
        if (reclaimed > 0) {
          console.log(`reclaimed ${reclaimed} stale processing task(s) older than ${staleProcessingMaxAgeMinutes}m`);
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

    await sleep(appConfig.workerPollIntervalMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
