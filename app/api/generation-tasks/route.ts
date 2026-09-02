import { NextRequest, NextResponse } from "next/server";
import {
  createGenerationTask,
  getConversation,
  getImageFilePathById,
  getTemplate,
  getTaskImages,
  listGenerationTasks,
  toPublicTask,
} from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handleRouteError, jsonError } from "@/lib/http";
import { assertConversationAccess, assertImageReferenceAccess, assertQuotaAvailable, assertTemplateReadAccess } from "@/lib/permissions";
import { createGenerationTaskSchema, listTasksQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    const query = listTasksQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const rows = listGenerationTasks({
      userId: user.id,
      isAdmin: user.role === "admin",
      statuses: query.status,
      limit: query.limit,
    });
    const tasks = rows.map((task) => toPublicTask(task, getTaskImages(task.id)));
    return NextResponse.json({ tasks });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    const body = await request.json();
    const input = createGenerationTaskSchema.parse(body);

    if (input.conversationId) {
      const conversation = getConversation(input.conversationId);
      if (!conversation) {
        return jsonError("会话不存在", 404);
      }
      assertConversationAccess(user, conversation);
    }

    if (input.templateId) {
      const template = getTemplate(input.templateId);
      if (!template) {
        return jsonError("模板不存在", 404);
      }
      assertTemplateReadAccess(user, template);
    }

    const allSourceImageIds: string[] = [];
    if (input.sourceImageId) {
      allSourceImageIds.push(input.sourceImageId);
    }
    if (input.sourceImageIds) {
      allSourceImageIds.push(...input.sourceImageIds);
    }

    for (const imgId of allSourceImageIds) {
      assertImageReferenceAccess(user, imgId);
    }

    if (input.mode !== "text_to_image" && allSourceImageIds.length > 0) {
      const anyMissing = allSourceImageIds.some((imgId) => !getImageFilePathById(imgId));
      if (anyMissing) {
        return jsonError("参考图不存在或已无法访问", 400);
      }
    }

    assertQuotaAvailable(user, input.quantity);

    // 主图之外的参考图；referenceImageId 是「第一张额外参考图」，与会话续图路由保持一致。
    const referenceImageIds = Array.from(
      new Set((input.sourceImageIds ?? []).filter((imageId) => imageId !== input.sourceImageId)),
    );

    const task = createGenerationTask({
      ...input,
      mode: input.mode === "edit_image" ? "image_to_image" : input.mode,
      userId: user.id,
      referenceImageId: referenceImageIds[0] ?? null,
      referenceImageIds,
    });
    return NextResponse.json(
      {
        taskId: task.id,
        conversationId: task.conversation_id,
        status: task.status,
        task: toPublicTask(task),
      },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
