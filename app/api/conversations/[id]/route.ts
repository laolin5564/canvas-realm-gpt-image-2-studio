import { NextRequest, NextResponse } from "next/server";
import {
  conversationDetailEtag,
  getConversation,
  getTaskImagesByTaskIds,
  deleteConversationWithGeneratedImages,
  listConversationMessages,
  listConversationTasks,
  toPublicConversation,
  updateConversationFixedPrompt,
} from "@/lib/db";
import type { ConversationRow, PublicConversation } from "@/lib/types";
import { requireUser } from "@/lib/auth";
import { handleRouteError, jsonError } from "@/lib/http";
import { assertConversationAccess } from "@/lib/permissions";
import { deleteStorageFile } from "@/lib/storage";
import { updateConversationFixedPromptSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConversationDetail {
  conversation: PublicConversation;
  etag: string;
}

/**
 * 一次性把消息、任务、以及所有任务的出图取出来（出图走 getTaskImagesByTaskIds 批量查，
 * 不再逐任务 getTaskImages），顺便算出这份详情的弱 ETag。
 */
function buildConversationDetail(row: ConversationRow): ConversationDetail {
  const messages = listConversationMessages(row.id);
  const tasks = listConversationTasks(row.id);
  const taskImages = getTaskImagesByTaskIds(tasks.map((task) => task.id));
  return {
    conversation: toPublicConversation(row, { messages, tasks, taskImages }),
    etag: conversationDetailEtag({ conversation: row, messages, tasks, taskImages }),
  };
}

/** If-None-Match 支持逗号分隔的多个值与 `*`；弱校验，比较时忽略 W/ 前缀。 */
function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
  if (!header) {
    return false;
  }
  const normalize = (value: string): string => value.trim().replace(/^W\//, "");
  const target = normalize(etag);
  return header
    .split(",")
    .some((candidate) => candidate.trim() === "*" || normalize(candidate) === target);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    const { id } = await context.params;
    const conversation = getConversation(id);
    if (!conversation) {
      return jsonError("会话不存在", 404);
    }
    assertConversationAccess(user, conversation);

    const detail = buildConversationDetail(conversation);
    const headers = { ETag: detail.etag, "Cache-Control": "private, no-cache" };
    if (ifNoneMatchSatisfied(request.headers.get("if-none-match"), detail.etag)) {
      return new NextResponse(null, { status: 304, headers });
    }

    return NextResponse.json({ conversation: detail.conversation }, { headers });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    const { id } = await context.params;
    const conversation = getConversation(id);
    if (!conversation) {
      return jsonError("会话不存在", 404);
    }
    assertConversationAccess(user, conversation);

    const input = updateConversationFixedPromptSchema.parse(await request.json());
    if (input.enabled && !input.fixedPrompt) {
      return jsonError("请输入会话固定提示词", 400);
    }

    const updated = updateConversationFixedPrompt(id, {
      enabled: input.enabled,
      fixedPrompt: input.fixedPrompt,
    });

    const detail = buildConversationDetail(updated);
    return NextResponse.json(
      { conversation: detail.conversation },
      { headers: { ETag: detail.etag, "Cache-Control": "private, no-cache" } },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    const { id } = await context.params;
    const conversation = getConversation(id);
    if (!conversation) {
      return jsonError("会话不存在", 404);
    }
    assertConversationAccess(user, conversation);

    const deleted = deleteConversationWithGeneratedImages(id);
    await Promise.all(deleted.images.map((image) => deleteStorageFile(image.file_path)));
    return NextResponse.json({ conversation: toPublicConversation(deleted.conversation), deletedImages: deleted.images.length });
  } catch (error) {
    return handleRouteError(error);
  }
}
