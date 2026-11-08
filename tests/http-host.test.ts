import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { channelOriginHost, normalizeHttpHostHeader } from "../lib/http-host";

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

  test("keeps the vhost override for bare-IP origins", () => {
    assert.equal(channelOriginHost("http://64.186.230.8/v1", "s2a.laolin.ai"), "s2a.laolin.ai");
    assert.equal(channelOriginHost("https://[2001:db8::1]/v1", "s2a.laolin.ai"), "s2a.laolin.ai");
  });

  test("external domain channels never inherit another provider's Host or SNI", () => {
    assert.equal(channelOriginHost("https://shumai.online/v1", "s2a.laolin.ai"), undefined);
    assert.equal(channelOriginHost("https://s2a.laolin.ai/v1", "s2a.laolin.ai"), undefined);
  });
});
