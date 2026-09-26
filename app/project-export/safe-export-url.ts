function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  // IPv6 literals are deliberately omitted: image sources use public DNS names.
  if (host.includes(":") || !host.includes(".") || /(?:^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)));
  }
  return true;
}

export function safeOnlineUrl(value: string | undefined, unwrapImage = false): string | null {
  if (!value) return null;
  let candidate = value.trim();
  try {
    if (unwrapImage && candidate.startsWith("/api/amazon-image?")) {
      const proxy = new URL(candidate, "https://export.invalid");
      const entries = [...proxy.searchParams.entries()];
      if (proxy.pathname !== "/api/amazon-image" || proxy.hash || entries.length !== 1 || entries[0][0] !== "u") return null;
      candidate = entries[0][1];
    }
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || !isPublicHost(url.hostname) || /^\/api(?:\/|$)/i.test(url.pathname)) return null;
    // Shareable URLs must not carry session or signed-access credentials.
    const credentialKey = /(?:token|auth|credential|signature|session|cookie|api[-_]?key|secret|password)/i;
    if ([...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some(key => credentialKey.test(key))) return null;
    return url.href;
  } catch {
    return null;
  }
}

