import { isIP } from "node:net";

const httpHostPattern = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

export function normalizeHttpHostHeader(value: string | undefined): string | undefined {
  const host = value?.trim();
  if (!host) {
    return undefined;
  }
  if (!httpHostPattern.test(host)) {
    throw new Error("SUB2API_HOST_HEADER 必须是合法的域名或 host:port，不能包含协议、路径或换行");
  }
  return host;
}

/** Bare-IP origins need the configured vhost; domain channels use their own Host and TLS SNI. */
export function channelOriginHost(baseUrl: string, configuredHost: string | undefined): string | undefined {
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  return isIP(hostname) ? normalizeHttpHostHeader(configuredHost) : undefined;
}
