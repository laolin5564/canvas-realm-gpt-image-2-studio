import { describe, expect, test } from "bun:test";
import type { PublicConversation, PublicConversationMessage, PublicTask } from "@/lib/types";
import {
  activePollIntervalMs,
  activeTasks,
  hasActiveTasks,
  idlePollIntervalMs,
  nextPollDelayMs,
  pollFailureToastThreshold,
  shouldAcceptResponse,
  shouldPollNow,
  shouldReportPollFailure,
} from "@/components/workbench/polling";
import { buildThreadItems, compactErrorMessage, pruneOptimisticEntries } from "@/components/workbench/thread-model";
import type { OptimisticEntry } from "@/components/workbench/types";

function task(id: string, overrides: Partial<PublicTask> = {}): PublicTask {
  return {
    id,
    userId: null,
    conversationId: "conv_1",
    mode: "text_to_image",
    status: "processing",
    progressStage: "generating",
    prompt: "prompt",
    fixedPrompt: null,
    promptSuffix: null,
    negativePrompt: null,
    size: "auto",
    quality: "high",
    quantity: 1,
    requestedConcurrency: null,
    templateId: null,
    sourceImageId: null,
    referenceImageId: null,
    referenceImage: null,
    referenceImages: [],
    referenceStrength: 0.6,
    styleStrength: 0.7,
    costEstimate: 0,
    errorMessage: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    images: [],
    ...overrides,
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  taskId: string | null,
): PublicConversationMessage {
  return {
    id,
    role,
    content: role === "user" ? "画一张海报" : "生成完成",
    taskId,
    imageId: null,
    image: null,
    images: [],
    sourceImage: null,
    createdAt: "2026-09-02T00:00:00.000Z",
  };
}

function conversation(overrides: Partial<PublicConversation> = {}): PublicConversation {
  return {
    id: "conv_1",
    userId: null,
    userName: null,
    userEmail: null,
    title: "会话",
    fixedPromptEnabled: false,
    fixedPrompt: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    latestTask: null,
    latestImage: null,
    messages: [],
    tasks: [],
    ...overrides,
  };
}

function join(values: readonly string[]): string {
  return values.join(",");
}

function optimistic(taskId: string, conversationId = "conv_1"): OptimisticEntry {
  return {
    id: `optimistic_${taskId}`,
    conversationId,
    content: "画一张海报",
    createdAt: "2026-09-02T00:00:00.000Z",
    task: task(taskId),
    sourceImage: null,
    referenceImages: [],
  };
}

describe("poll interval", () => {
  test("stays fast while tasks are running and drops to idle otherwise", () => {
    expect(nextPollDelayMs(true)).toBe(activePollIntervalMs);
    expect(nextPollDelayMs(false)).toBe(idlePollIntervalMs);
    expect(activePollIntervalMs).toBe(2800);
    expect(idlePollIntervalMs).toBe(15000);
  });

  test("a hidden document stops the polling entirely", () => {
    expect(shouldPollNow("visible")).toBe(true);
    expect(shouldPollNow("prerender")).toBe(true);
    expect(shouldPollNow("hidden")).toBe(false);
  });

  test("active tasks come from the conversation and from optimistic entries", () => {
    const running = conversation({ tasks: [task("t1"), task("t2", { status: "succeeded" })] });
    expect(join(activeTasks(running).map((item) => item.id))).toBe("t1");
    expect(hasActiveTasks(running)).toBe(true);
    expect(hasActiveTasks(conversation())).toBe(false);
    expect(hasActiveTasks(null)).toBe(false);
    // 刚提交、详情还没带回这条任务时，靠乐观条目撑住 2.8s 的轮询节奏。
    expect(hasActiveTasks(conversation(), [task("t9")])).toBe(true);
    expect(hasActiveTasks(conversation(), [task("t9", { status: "failed" })])).toBe(false);
  });
});

describe("poll sequence guard", () => {
  test("accepts only responses newer than the last applied one", () => {
    expect(shouldAcceptResponse(1, 0)).toBe(true);
    expect(shouldAcceptResponse(2, 1)).toBe(true);
    expect(shouldAcceptResponse(1, 1)).toBe(false);
    expect(shouldAcceptResponse(1, 2)).toBe(false);
  });

  test("a slow request that lands after a newer one is discarded", () => {
    let applied = 0;
    const arrivals = [3, 1, 2, 4];
    const accepted: number[] = [];
    for (const seq of arrivals) {
      if (shouldAcceptResponse(seq, applied)) {
        applied = seq;
        accepted.push(seq);
      }
    }
    expect(accepted.join(",")).toBe("3,4");
  });

  test("switching conversations invalidates every outstanding response", () => {
    // 切会话时把「已应用序号」推到已发出的最大序号，旧响应一律作废。
    const issued = 5;
    const applied = issued;
    expect(shouldAcceptResponse(4, applied)).toBe(false);
    expect(shouldAcceptResponse(5, applied)).toBe(false);
    expect(shouldAcceptResponse(6, applied)).toBe(true);
  });

  test("non-numeric sequences are never accepted", () => {
    expect(shouldAcceptResponse(Number.NaN, 0)).toBe(false);
  });
});

describe("poll failure threshold", () => {
  test("only warns after three consecutive failures", () => {
    expect(pollFailureToastThreshold).toBe(3);
    expect(shouldReportPollFailure(1)).toBe(false);
    expect(shouldReportPollFailure(2)).toBe(false);
    expect(shouldReportPollFailure(3)).toBe(true);
    expect(shouldReportPollFailure(4)).toBe(true);
  });
});

describe("thread items", () => {
  test("each running task gets its own placeholder card after the user message", () => {
    const running = task("t1");
    const items = buildThreadItems(
      conversation({ messages: [message("m1", "user", "t1")], tasks: [running] }),
    );
    expect(join(items.map((item) => item.kind))).toBe("message,task");
  });

  test("finished tasks render only their messages", () => {
    const done = task("t1", { status: "succeeded" });
    const items = buildThreadItems(
      conversation({
        messages: [message("m1", "user", "t1"), message("m2", "assistant", "t1")],
        tasks: [done],
      }),
    );
    expect(join(items.map((item) => item.kind))).toBe("message,message");
  });

  test("a task whose user message has not arrived yet still shows a placeholder", () => {
    const items = buildThreadItems(conversation({ messages: [], tasks: [task("t1")] }));
    expect(items.length).toBe(1);
    expect(items[0].kind).toBe("task");
  });

  test("optimistic entries append a user bubble plus a placeholder", () => {
    const items = buildThreadItems(conversation(), [optimistic("t9")]);
    expect(join(items.map((item) => item.kind))).toBe("optimistic-message,task");
  });

  test("an optimistic entry is skipped once the server already renders that task", () => {
    const items = buildThreadItems(
      conversation({ messages: [message("m1", "user", "t9")], tasks: [task("t9")] }),
      [optimistic("t9")],
    );
    expect(join(items.map((item) => item.kind))).toBe("message,task");
  });
});

describe("optimistic pruning", () => {
  test("drops entries whose task is already in the conversation detail", () => {
    const entries = [optimistic("t1"), optimistic("t2")];
    const remaining = pruneOptimisticEntries(entries, conversation({ tasks: [task("t1")] }));
    expect(join(remaining.map((entry) => entry.task.id))).toBe("t2");
  });

  test("drops entries that belong to another conversation", () => {
    const entries = [optimistic("t1", "conv_other")];
    expect(pruneOptimisticEntries(entries, conversation()).length).toBe(0);
  });

  test("keeps everything while the detail has not loaded", () => {
    const entries = [optimistic("t1")];
    expect(pruneOptimisticEntries(entries, null)).toBe(entries);
  });
});

describe("error text", () => {
  test("maps upstream 524 to a readable hint", () => {
    expect(compactErrorMessage("HTTP 524 timeout occurred")).toContain("模型接口超时");
  });

  test("strips markup and collapses whitespace", () => {
    expect(compactErrorMessage("<b>失败</b>\n\n  原因")).toBe("失败 原因");
    expect(compactErrorMessage(null)).toBe("");
  });
});
