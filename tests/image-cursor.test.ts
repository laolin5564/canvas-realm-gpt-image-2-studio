import { describe, expect, test } from "bun:test";
import {
  buildImagePage,
  decodeImageCursor,
  dropSeenImages,
  encodeImageCursor,
  type ImageCursor,
  type ImageCursorItem,
} from "../lib/image-cursor";

function item(id: string, createdAt: string): ImageCursorItem {
  return { id, createdAt };
}

function ids(rows: ImageCursorItem[]): string {
  return rows.map((row) => row.id).join(",");
}

function cursorText(value: ImageCursor | null): string {
  return value ? `${value.page}|${value.createdAt}|${value.id}` : "none";
}

function encodeRaw(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("image cursor codec", () => {
  test("encodes and decodes a round trip", () => {
    const cursor: ImageCursor = { page: 3, createdAt: "2026-09-02T10:00:00.000Z", id: "img_abc" };
    const encoded = encodeImageCursor(cursor);
    expect(/^[A-Za-z0-9_-]+$/.test(encoded)).toBe(true);
    expect(cursorText(decodeImageCursor(encoded))).toBe("3|2026-09-02T10:00:00.000Z|img_abc");
  });

  test("returns null for empty or malformed cursors", () => {
    expect(decodeImageCursor(null)).toBe(null);
    expect(decodeImageCursor(undefined)).toBe(null);
    expect(decodeImageCursor("")).toBe(null);
    expect(decodeImageCursor("not-a-cursor")).toBe(null);
    expect(decodeImageCursor(encodeRaw([]))).toBe(null);
    expect(decodeImageCursor(encodeRaw(null))).toBe(null);
  });

  test("rejects cursors with an invalid page, createdAt or id", () => {
    expect(decodeImageCursor(encodeRaw({ page: 0, createdAt: "2026-09-02", id: "img_1" }))).toBe(null);
    expect(decodeImageCursor(encodeRaw({ page: 1.5, createdAt: "2026-09-02", id: "img_1" }))).toBe(null);
    expect(decodeImageCursor(encodeRaw({ page: "2", createdAt: "2026-09-02", id: "img_1" }))).toBe(null);
    expect(decodeImageCursor(encodeRaw({ page: 2, createdAt: "", id: "img_1" }))).toBe(null);
    expect(decodeImageCursor(encodeRaw({ page: 2, createdAt: "2026-09-02", id: "" }))).toBe(null);
    expect(decodeImageCursor(encodeRaw({ page: 2, createdAt: "2026-09-02" }))).toBe(null);
  });
});

describe("dropSeenImages", () => {
  const cursor: ImageCursor = { page: 2, createdAt: "2026-09-02T10:00:00.000Z", id: "img_cursor" };

  test("keeps everything when there is no cursor", () => {
    const rows = [item("a", "2026-09-02T11:00:00.000Z"), item("b", "2026-09-02T09:00:00.000Z")];
    expect(ids(dropSeenImages(rows, null))).toBe("a,b");
  });

  test("drops rows newer than the cursor and the cursor row itself", () => {
    const rows = [
      item("img_new", "2026-09-02T12:00:00.000Z"),
      item("img_cursor", "2026-09-02T10:00:00.000Z"),
      item("img_same_ts", "2026-09-02T10:00:00.000Z"),
      item("img_older", "2026-09-02T08:00:00.000Z"),
    ];
    expect(ids(dropSeenImages(rows, cursor))).toBe("img_same_ts,img_older");
  });
});

describe("buildImagePage", () => {
  test("returns no cursor when the last page is reached", () => {
    const rows = [item("a", "2026-09-02T11:00:00.000Z"), item("b", "2026-09-02T10:00:00.000Z")];
    const page = buildImagePage({ rows, cursor: null, page: 1, hasMore: false });
    expect(ids(page.images)).toBe("a,b");
    expect(page.nextCursor).toBe(null);
  });

  test("returns no cursor when the page is empty", () => {
    const page = buildImagePage({ rows: [], cursor: null, page: 1, hasMore: true });
    expect(page.images.length).toBe(0);
    expect(page.nextCursor).toBe(null);
  });

  test("points the next cursor at the last row and the following page", () => {
    const rows = [item("a", "2026-09-02T11:00:00.000Z"), item("b", "2026-09-02T10:00:00.000Z")];
    const page = buildImagePage({ rows, cursor: null, page: 1, hasMore: true });
    expect(cursorText(decodeImageCursor(page.nextCursor))).toBe("2|2026-09-02T10:00:00.000Z|b");
  });

  test("chains pages without repeating a row when nothing changes in between", () => {
    const all = Array.from({ length: 5 }, (_, index) =>
      item(`img_${index}`, `2026-09-02T1${9 - index}:00:00.000Z`),
    );
    const pageSize = 2;

    const first = buildImagePage({ rows: all.slice(0, pageSize), cursor: null, page: 1, hasMore: true });
    const firstCursor = decodeImageCursor(first.nextCursor);
    expect(firstCursor?.page).toBe(2);

    const second = buildImagePage({
      rows: all.slice(pageSize, pageSize * 2),
      cursor: firstCursor,
      page: firstCursor?.page ?? 1,
      hasMore: true,
    });
    const secondCursor = decodeImageCursor(second.nextCursor);
    expect(secondCursor?.page).toBe(3);

    const third = buildImagePage({
      rows: all.slice(pageSize * 2),
      cursor: secondCursor,
      page: secondCursor?.page ?? 1,
      hasMore: false,
    });

    expect(ids([...first.images, ...second.images, ...third.images])).toBe(ids(all));
    expect(third.nextCursor).toBe(null);
  });

  test("drops rows that drifted back into view after new images were inserted", () => {
    // 第 1 页返回 img_9 / img_8；翻页前又生成了一张新图，OFFSET 窗口整体下移一格，
    // 于是第 2 页又把 img_8 带了回来 —— 应当被游标过滤掉，前端不会出现重复卡片。
    const first = buildImagePage({
      rows: [item("img_9", "2026-09-02T19:00:00.000Z"), item("img_8", "2026-09-02T18:00:00.000Z")],
      cursor: null,
      page: 1,
      hasMore: true,
    });
    const cursor = decodeImageCursor(first.nextCursor);

    const second = buildImagePage({
      rows: [item("img_8", "2026-09-02T18:00:00.000Z"), item("img_7", "2026-09-02T17:00:00.000Z")],
      cursor,
      page: cursor?.page ?? 1,
      hasMore: true,
    });

    expect(ids(second.images)).toBe("img_7");
    // 即使本页被过滤掉一条，nextCursor 仍取原始最后一条，保证还能继续往下翻。
    expect(cursorText(decodeImageCursor(second.nextCursor))).toBe("3|2026-09-02T17:00:00.000Z|img_7");
  });

  test("still advances the cursor when the whole page was filtered out", () => {
    const cursor: ImageCursor = { page: 2, createdAt: "2026-09-02T10:00:00.000Z", id: "img_cursor" };
    const page = buildImagePage({
      rows: [item("img_newer", "2026-09-02T12:00:00.000Z"), item("img_cursor", "2026-09-02T10:00:00.000Z")],
      cursor,
      page: 2,
      hasMore: true,
    });

    expect(page.images.length).toBe(0);
    expect(cursorText(decodeImageCursor(page.nextCursor))).toBe("3|2026-09-02T10:00:00.000Z|img_cursor");
  });
});
