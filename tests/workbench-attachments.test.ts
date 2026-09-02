import { describe, expect, test } from "bun:test";
import {
  appendAttachments,
  applyUploadedAttachments,
  attachmentImageIds,
  clearAttachments,
  primaryAttachmentId,
  referenceAttachmentIds,
  removeAttachment,
  setAttachmentRole,
  type WorkbenchAttachment,
} from "@/components/workbench/attachments";

function local(id: string, role: WorkbenchAttachment["role"] = "reference"): WorkbenchAttachment {
  return { id, previewUrl: `blob:${id}`, name: `${id}.png`, role };
}

function remote(id: string, imageId: string, role: WorkbenchAttachment["role"] = "reference"): WorkbenchAttachment {
  return { id, previewUrl: `/api/files/${imageId}.png`, uploadedId: imageId, name: `${imageId}.png`, role };
}

function ids(list: WorkbenchAttachment[]): string {
  return list.map((item) => item.id).join(",");
}

function join(values: readonly string[]): string {
  return values.join(",");
}

describe("workbench attachments: append", () => {
  test("first appended attachment becomes the primary image", () => {
    const result = appendAttachments([], [local("a"), local("b")], 4);
    expect(ids(result.next)).toBe("a,b");
    expect(result.next[0].role).toBe("primary");
    expect(result.next[1].role).toBe("reference");
    expect(result.skipped).toBe(0);
    expect(join(result.revoked)).toBe("");
  });

  test("keeps the existing primary when appending more", () => {
    const current = appendAttachments([], [local("a")], 4).next;
    const result = appendAttachments(current, [local("b")], 4);
    expect(result.next[0].role).toBe("primary");
    expect(result.next[1].role).toBe("reference");
  });

  test("drops candidates beyond the limit and revokes their blob urls", () => {
    const current = [local("a", "primary"), local("b"), local("c")];
    const result = appendAttachments(current, [local("d"), local("e"), local("f")], 4);
    expect(ids(result.next)).toBe("a,b,c,d");
    expect(result.skipped).toBe(2);
    expect(join(result.revoked)).toBe("blob:e,blob:f");
  });

  test("never revokes non-blob previews of rejected candidates", () => {
    const current = [local("a", "primary"), local("b"), local("c"), local("d")];
    const result = appendAttachments(current, [remote("e", "img_e")], 4);
    expect(result.skipped).toBe(1);
    expect(join(result.revoked)).toBe("");
  });
});

describe("workbench attachments: remove and clear", () => {
  test("removing an item only revokes that item's blob url", () => {
    const current = [local("a", "primary"), local("b"), local("c")];
    const result = removeAttachment(current, "b");
    expect(ids(result.next)).toBe("a,c");
    expect(join(result.revoked)).toBe("blob:b");
  });

  test("removing the primary promotes the next attachment", () => {
    const current = [local("a", "primary"), local("b"), local("c")];
    const result = removeAttachment(current, "a");
    expect(result.next[0].id).toBe("b");
    expect(result.next[0].role).toBe("primary");
    expect(join(result.revoked)).toBe("blob:a");
  });

  test("removing an unknown id changes nothing and revokes nothing", () => {
    const current = [local("a", "primary")];
    const result = removeAttachment(current, "zzz");
    expect(result.next).toBe(current);
    expect(join(result.revoked)).toBe("");
  });

  test("clearing revokes every blob url but leaves server urls alone", () => {
    const current = [local("a", "primary"), remote("b", "img_b")];
    const result = clearAttachments(current);
    expect(result.next.length).toBe(0);
    expect(join(result.revoked)).toBe("blob:a");
  });
});

describe("workbench attachments: upload and roles", () => {
  test("applying upload results swaps the preview and hands back the stale blob url", () => {
    const current = [local("a", "primary"), local("b")];
    const result = applyUploadedAttachments(current, {
      a: { imageId: "img_a", url: "/api/files/img_a.png" },
    });
    expect(result.next[0].uploadedId).toBe("img_a");
    expect(result.next[0].previewUrl).toBe("/api/files/img_a.png");
    expect(result.next[0].file).toBe(undefined);
    expect(result.next[1].previewUrl).toBe("blob:b");
    expect(join(result.revoked)).toBe("blob:a");
  });

  test("promoting one attachment to primary demotes the others", () => {
    const current = [local("a", "primary"), local("b"), local("c")];
    const next = setAttachmentRole(current, "c", "primary");
    expect(next.map((item) => item.role).join(",")).toBe("reference,reference,primary");
  });

  test("demoting the only primary re-promotes the first attachment", () => {
    const current = [local("a", "primary"), local("b")];
    const next = setAttachmentRole(current, "a", "reference");
    expect(next[0].role).toBe("primary");
  });

  test("submitted image ids put the primary first", () => {
    const current = [remote("a", "img_a"), remote("b", "img_b", "primary"), remote("c", "img_c")];
    expect(primaryAttachmentId(current)).toBe("img_b");
    expect(join(referenceAttachmentIds(current))).toBe("img_a,img_c");
    expect(join(attachmentImageIds(current))).toBe("img_b,img_a,img_c");
  });

  test("attachments without an uploaded id contribute no image ids", () => {
    expect(attachmentImageIds([local("a", "primary")]).length).toBe(0);
  });
});
