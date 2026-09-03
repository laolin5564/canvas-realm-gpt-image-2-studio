import { describe, expect, test } from "bun:test";
import {
  describeNetworkError,
  describeTaskFailure,
  isFetchNetworkError,
  modelErrorDetail,
  UpstreamImageDetailError,
} from "@/lib/model-error-detail";

function connectionRefused(): TypeError {
  const cause = Object.assign(new Error("connect ECONNREFUSED 69.63.221.194:80"), {
    code: "ECONNREFUSED",
    syscall: "connect",
    address: "69.63.221.194",
    port: 80,
  });
  return new TypeError("fetch failed", { cause });
}

describe("describeNetworkError", () => {
  test("fetch failed：用户文案是中文短句、不含源站 IP，原文只进管理员详情", () => {
    const described = describeNetworkError(connectionRefused());

    expect(described === null).toBe(false);
    expect(described?.message).toBe("生成服务连接失败，请稍后重试；如果反复失败请联系管理员。");
    expect(described?.message.includes("69.63.221.194")).toBe(false);
    expect(described?.message.includes("ECONNREFUSED")).toBe(false);
    expect(described?.detail).toContain("ECONNREFUSED");
    expect(described?.detail).toContain("69.63.221.194:80");
    expect(described?.detail).toContain("Base URL");
  });

  test("cause 缺失或不是 Error 也能给出文案", () => {
    expect(describeNetworkError(new TypeError("fetch failed"))?.detail).toBe(
      "连接模型网关失败：请检查渠道 Base URL、源站网络与 DNS 解析。",
    );
    expect(describeNetworkError(new TypeError("fetch failed", { cause: "socket hang up" }))?.detail).toContain(
      "socket hang up",
    );
  });

  test("非网络错误返回 null", () => {
    expect(describeNetworkError(new Error("fetch failed"))).toBe(null);
    expect(describeNetworkError(new TypeError("其他类型错误"))).toBe(null);
    expect(describeNetworkError(new UpstreamImageDetailError("x", 500, "detail"))).toBe(null);
    expect(describeNetworkError(null)).toBe(null);
    expect(isFetchNetworkError(connectionRefused())).toBe(true);
    expect(isFetchNetworkError(new Error("fetch failed"))).toBe(false);
  });
});

describe("describeTaskFailure", () => {
  test("网络错误：error_message 是中文短文案，error_detail 带原文", () => {
    const failure = describeTaskFailure(connectionRefused());

    expect(failure.message).toBe("生成服务连接失败，请稍后重试；如果反复失败请联系管理员。");
    expect(failure.message.includes("69.63.221.194")).toBe(false);
    expect(failure.detail).toContain("connect ECONNREFUSED 69.63.221.194:80");
  });

  test("上游 HTTP 错误：message 原样、detail 取错误上的管理员详情", () => {
    const error = new UpstreamImageDetailError(
      "参考图太大，请压缩后重试或减少参考图数量。",
      413,
      "参考图请求体过大（413）：…（HTTP 413）",
    );
    const failure = describeTaskFailure(error);

    expect(failure.message).toBe("参考图太大，请压缩后重试或减少参考图数量。");
    expect(failure.detail).toBe("参考图请求体过大（413）：…（HTTP 413）");
    expect(modelErrorDetail(error)).toBe(failure.detail);
  });

  test("普通错误与非 Error 值", () => {
    const plain = describeTaskFailure(new Error("缺少参考图，无法调用图片编辑接口"));
    expect(plain.message).toBe("缺少参考图，无法调用图片编辑接口");
    expect(plain.detail).toBe(null);
    const unknown = describeTaskFailure("boom");
    expect(unknown.message).toBe("生成任务处理失败");
    expect(unknown.detail).toBe(null);
  });
});
