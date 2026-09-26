/** Capture the application's already loaded styles. Missing required CSS is a hard failure. */
export async function collectPageSnapshotStyles(source: Document, signal: AbortSignal): Promise<string> {
  const parts: string[] = [];
  const fonts = new Map<string, Promise<string>>();
  async function assets(css: string, base: string) {
    const urls = [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)];
    for (const match of urls) {
      const raw = (match[1] ?? match[2] ?? match[3]).trim();
      if (raw.startsWith("#") || raw.startsWith("data:")) continue;
      const url = new URL(raw, base);
      if (url.origin === window.location.origin && /\.(woff2?|ttf|otf)$/i.test(url.pathname) && !url.pathname.startsWith("/api/")) {
        let pending = fonts.get(url.href);
        if (!pending) {
          pending = (async () => {
            const response = await fetch(url.href, {credentials:"same-origin",signal});
            if (!response.ok) throw new Error("页面字体读取失败，请刷新后重试");
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length > 2_000_000) throw new Error("页面字体文件过大");
            let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
            const type = url.pathname.match(/\.(woff2?|ttf|otf)$/i)![1].toLowerCase();
            return `data:font/${type};base64,${btoa(binary)}`;
          })(); fonts.set(url.href,pending);
        }
        css = css.replace(match[0], `url("${await pending}")`);
      } else css = css.replace(match[0], `url("${url.href.replace(/"/g,"%22")}")`);
    }
    return css;
  }
  for (const node of source.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style,link[rel="stylesheet"]')) {
    signal.throwIfAborted();
    if (node instanceof HTMLStyleElement) { parts.push(await assets(node.textContent ?? "", source.baseURI || window.location.href)); continue; }
    if (node.disabled) continue;
    const url = new URL(node.href, source.baseURI);
    if (url.origin !== window.location.origin) throw new Error("页面样式无法完整读取，请刷新后重试");
    try {
      const rules = node.sheet?.cssRules;
      if (rules?.length) { parts.push(await assets(Array.from(rules, rule => rule.cssText).join("\n"), url.href)); continue; }
      const response = await fetch(url.href, { credentials: "same-origin", signal });
      if (!response.ok) throw new Error("CSS unavailable");
      parts.push(await assets(await response.text(), url.href));
    } catch (error) {
      signal.throwIfAborted();
      throw new Error("页面样式读取失败，请刷新后重试", { cause: error });
    }
  }
  signal.throwIfAborted();
  if (!parts.length) throw new Error("页面样式尚未加载，请稍后重试");
  // Next's font variables live on generated body classes; the standalone file has no app shell.
  if (source.body?.isConnected && source.defaultView) {
    const computed = source.defaultView.getComputedStyle(source.body);
    const sans = computed.getPropertyValue("--font-geist-sans").trim() || '"Microsoft YaHei",sans-serif';
    const mono = computed.getPropertyValue("--font-geist-mono").trim() || 'monospace';
    parts.push(`:root{--font-geist-sans:${sans};--font-geist-mono:${mono}}`);
  }
  return parts.join("\n");
}
