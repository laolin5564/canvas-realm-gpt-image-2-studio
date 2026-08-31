/**
 * 为存量 generated_images 补生成缩略图（<file>.thumb.webp）。
 * 用法：tsx scripts/generate-thumbnails.ts
 * 幂等：已有缩略图的跳过；原图缺失的跳过并计数。
 */
import { existsSync } from "node:fs";
import { getDb } from "../lib/db";
import {
  generateThumbnailFile,
  readStorageFile,
  resolveStoragePath,
  thumbnailPathFor,
} from "../lib/storage";

async function main(): Promise<void> {
  const db = getDb();
  const rows = db.prepare("SELECT id, file_path FROM generated_images ORDER BY created_at ASC").all() as Array<{
    id: string;
    file_path: string;
  }>;

  let created = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      if (existsSync(resolveStoragePath(thumbnailPathFor(row.file_path)))) {
        skipped += 1;
        continue;
      }
      if (!existsSync(resolveStoragePath(row.file_path))) {
        missing += 1;
        continue;
      }
      const file = await readStorageFile(row.file_path);
      await generateThumbnailFile(row.file_path, file.bytes);
      created += 1;
      if (created % 50 === 0) {
        console.log(`progress: ${created} created...`);
      }
    } catch (error) {
      failed += 1;
      console.error(`thumbnail failed for ${row.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log(`done. total=${rows.length} created=${created} skipped=${skipped} missing=${missing} failed=${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
