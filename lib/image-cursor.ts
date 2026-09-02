/**
 * 历史图片列表的游标分页工具（F 工作包）。
 *
 * lib/db.ts 的 listImages 只支持 page/pageSize（LIMIT/OFFSET），这里在路由层把它包成游标语义：
 * 游标同时带上「下一页页码」和「上一页最后一条的 created_at + id」。
 * 翻页时用后者把「因为期间又生成了新图、窗口下移而重复出现」的记录丢掉，避免前端出现重复卡片。
 */

export interface ImageCursor {
  page: number;
  createdAt: string;
  id: string;
}

export interface ImageCursorItem {
  id: string;
  createdAt: string;
}

export function encodeImageCursor(cursor: ImageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeImageCursor(raw: string | null | undefined): ImageCursor | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ImageCursor> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const { page, createdAt, id } = parsed;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
      return null;
    }
    if (typeof createdAt !== "string" || createdAt.length === 0) {
      return null;
    }
    if (typeof id !== "string" || id.length === 0) {
      return null;
    }
    return { page, createdAt, id };
  } catch {
    return null;
  }
}

/**
 * 列表按 created_at 倒序，下一页的记录应当「不新于」游标位置。
 * 比游标更新的记录说明窗口发生了漂移（期间插入了新图），前端已经见过，直接丢掉。
 */
export function dropSeenImages<T extends ImageCursorItem>(items: T[], cursor: ImageCursor | null): T[] {
  if (!cursor) {
    return items;
  }

  return items.filter(
    (item) => item.createdAt < cursor.createdAt || (item.createdAt === cursor.createdAt && item.id !== cursor.id),
  );
}

/**
 * 由「本页原始记录 + 是否还有下一页」组装出返回给前端的列表与 nextCursor。
 * nextCursor 取原始记录（而非去重后的）的最后一条，保证即使本页被漂移过滤成空也能继续往下翻。
 */
export function buildImagePage<T extends ImageCursorItem>(input: {
  rows: T[];
  cursor: ImageCursor | null;
  page: number;
  hasMore: boolean;
}): { images: T[]; nextCursor: string | null } {
  const last = input.rows.at(-1);
  const images = dropSeenImages(input.rows, input.cursor);
  const nextCursor =
    input.hasMore && last
      ? encodeImageCursor({ page: input.page + 1, createdAt: last.createdAt, id: last.id })
      : null;
  return { images, nextCursor };
}
