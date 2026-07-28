import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeHttpHostHeader, withOptionalHostHeader } from "../lib/http-host";

describe("HTTP origin host routing", () => {
  test("adds the configured Host header without changing the request URL", () => {
    assert.deepEqual(
      withOptionalHostHeader(
        {
          Authorization: "Bearer test-token",
          "User-Agent": "test-agent",
        },
        " s2a.laolin.ai ",
      ),
      {
      Authorization: "Bearer test-token",
      "User-Agent": "test-agent",
      Host: "s2a.laolin.ai",
      },
    );
  });

  test("omits an empty Host override", () => {
    assert.deepEqual(withOptionalHostHeader({ Accept: "application/json" }, "  "), {
      Accept: "application/json",
    });
  });

  test("rejects unsafe or malformed Host values", () => {
    assert.throws(() => normalizeHttpHostHeader("s2a.laolin.ai\r\nX-Test: injected"));
    assert.throws(() => normalizeHttpHostHeader("https://s2a.laolin.ai"));
    assert.throws(() => normalizeHttpHostHeader("s2a.laolin.ai/path"));
  });
});
