import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeHttpHostHeader } from "../lib/http-host";

describe("HTTP origin host routing", () => {
  test("trims the configured Host value", () => {
    assert.equal(normalizeHttpHostHeader(" s2a.laolin.ai "), "s2a.laolin.ai");
    assert.equal(normalizeHttpHostHeader("s2a.laolin.ai:8443"), "s2a.laolin.ai:8443");
  });

  test("treats an empty Host override as absent", () => {
    assert.equal(normalizeHttpHostHeader("  "), undefined);
    assert.equal(normalizeHttpHostHeader(undefined), undefined);
  });

  test("rejects unsafe or malformed Host values", () => {
    assert.throws(() => normalizeHttpHostHeader("s2a.laolin.ai\r\nX-Test: injected"));
    assert.throws(() => normalizeHttpHostHeader("https://s2a.laolin.ai"));
    assert.throws(() => normalizeHttpHostHeader("s2a.laolin.ai/path"));
  });
});
