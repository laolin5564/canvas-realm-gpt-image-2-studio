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

export function withOptionalHostHeader(
  headers: Record<string, string>,
  hostHeader: string | undefined,
): Record<string, string> {
  const host = normalizeHttpHostHeader(hostHeader);
  return host ? { ...headers, Host: host } : headers;
}
