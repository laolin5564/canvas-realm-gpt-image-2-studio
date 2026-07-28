import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { CurrentUser, UserRow } from "../lib/types";

function toCurrentUser(user: UserRow): CurrentUser {
  return {
    id: user.id,
    email: user.email,
    externalId: user.external_id,
    name: user.name,
    role: user.role,
    groupId: user.group_id,
    groupName: null,
    monthlyQuota: user.monthly_quota,
    monthUsed: 0,
  };
}

test("conversation owner can access generated images from tasks created by an admin in that conversation", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "canvas-realm-permissions-test-"));
  process.env.DATABASE_URL = path.join(workspace, "app.db");
  process.env.IMAGE_STORAGE_DIR = path.join(workspace, "images");

  try {
    const {
      createConversation,
      createGeneratedImage,
      createGenerationTask,
      createUser,
      createUserGroup,
    } = await import("../lib/db");
    const { assertGeneratedImageAccess, assertTaskAccess } = await import("../lib/permissions");

    const group = createUserGroup({ name: "权限测试分组", monthlyQuota: 100 });
    const owner = createUser({
      email: "owner@example.test",
      name: "Owner",
      passwordHash: "hash",
      role: "member",
      groupId: group.id,
      monthlyQuota: null,
    });
    const admin = createUser({
      email: "admin@example.test",
      name: "Admin",
      passwordHash: "hash",
      role: "admin",
      groupId: group.id,
      monthlyQuota: null,
    });
    const outsider = createUser({
      email: "outsider@example.test",
      name: "Outsider",
      passwordHash: "hash",
      role: "member",
      groupId: group.id,
      monthlyQuota: null,
    });

    const conversation = createConversation("会话主人权限测试", owner.id);
    const task = createGenerationTask({
      userId: admin.id,
      conversationId: conversation.id,
      mode: "text_to_image",
      prompt: "会话主人可以查看管理员在该会话中生成的结果",
      negativePrompt: null,
      size: "auto",
      quantity: 1,
      templateId: null,
      sourceImageId: null,
      referenceStrength: 0.6,
      styleStrength: 0.7,
      applyFixedPrompt: false,
    });
    const image = createGeneratedImage({
      id: "img_permission_owner_access",
      taskId: task.id,
      filePath: "2026/05/04/task_permission/img_permission_owner_access.png",
      width: 1024,
      height: 1024,
      prompt: task.prompt,
      mode: task.mode,
      templateId: null,
    });

    assert.doesNotThrow(() => assertTaskAccess(toCurrentUser(owner), task));
    assert.doesNotThrow(() => assertGeneratedImageAccess(toCurrentUser(owner), image));
    assert.throws(() => assertGeneratedImageAccess(toCurrentUser(outsider), image), /无权访问该任务/);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});
