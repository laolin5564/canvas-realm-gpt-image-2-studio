import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../lib/image-provider";
import type { GenerationTaskRow } from "../lib/types";

// lib/image-provider 顺着 lib/db 依赖 node:sqlite，当前 bun 版本没这个内建模块，
// 所以 buildPrompt 的用例写成 node:test（由 tests/db-data-billing.test.ts 挂进 bun test）。
function taskRow(overrides: Partial<GenerationTaskRow> = {}): GenerationTaskRow {
  return {
    id: "task_demo",
    user_id: "user_demo",
    conversation_id: null,
    mode: "text_to_image",
    status: "queued",
    progress_stage: "queued",
    prompt: "四格漫画：蒸发、凝结、降水、径流",
    fixed_prompt: null,
    prompt_suffix: null,
    negative_prompt: null,
    size: "auto",
    quality: "high",
    quantity: 1,
    image_count: 0,
    requested_concurrency: null,
    template_id: null,
    source_image_id: null,
    reference_image_id: null,
    reference_image_ids: null,
    reference_strength: 0.6,
    style_strength: 0.7,
    cost_estimate: 0.04,
    error_message: null,
    error_detail: null,
    source: "web",
    created_at: "2026-09-04T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

test("非 auto 档把画幅比例写进提示词", () => {
  const prompt = buildPrompt(taskRow({ size: "douyin_cover_9_16" }), 0);
  assert.ok(prompt.includes("画幅比例：9:16 竖版，请按此比例完整构图，主体与文字不要贴边。"));
});

test("auto 档不追加画幅行", () => {
  const prompt = buildPrompt(taskRow({ size: "auto" }), 0);
  assert.equal(prompt, "四格漫画：蒸发、凝结、降水、径流");
});

test("提示词里已经写过同一个比例时不重复追加", () => {
  const written = buildPrompt(
    taskRow({ size: "douyin_cover_9_16", prompt: "9:16 竖版四格漫画，主体居中" }),
    0,
  );
  assert.ok(!written.includes("画幅比例"));

  // 2.35:1 档在比例表里是 235:100，提示词里写的是「2.35:1」，也要认得出来。
  const cinema = buildPrompt(
    taskRow({ size: "wechat_cover_235_1", prompt: "公众号封面，2.35:1 电影感横构图" }),
    0,
  );
  assert.ok(!cinema.includes("画幅比例"));
});

test("负面提示词里写过比例也算写过", () => {
  const prompt = buildPrompt(
    taskRow({ size: "banner_16_9", negative_prompt: "不要出现 16:9 之外的黑边" }),
    0,
  );
  assert.ok(!prompt.includes("画幅比例"));
});

test("画幅行排在避免出现之后、多图参考关系之前", () => {
  const lines = buildPrompt(
    taskRow({ size: "wechat_cover_235_1", mode: "image_to_image", negative_prompt: "水印" }),
    2,
  ).split("\n");

  assert.equal(lines[0], "四格漫画：蒸发、凝结、降水、径流");
  assert.equal(lines[1], "避免出现：水印");
  assert.equal(lines[2], "画幅比例：2.35:1 横版，请按此比例完整构图，主体与文字不要贴边。");
  assert.ok(lines[3].includes("图片参考关系"));
});
