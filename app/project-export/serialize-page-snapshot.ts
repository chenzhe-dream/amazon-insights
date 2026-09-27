import { safeOnlineUrl } from "./safe-export-url";
import { renderSnapshotNavigation } from "./snapshot-navigation-shell";
import type { SnapshotPageId } from "./snapshot-navigation-catalog";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Keep local SVG paint references; exported assets otherwise use public HTTPS addresses. */
function safeCss(css: string): string {
  return css.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/gi, "")
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_, quoted, single, bare) => {
      const value = String(quoted ?? single ?? bare).trim();
      if (/^#[\w-]+$/.test(value)) return `url("${value}")`;
      if (/^data:font\/(?:woff2?|ttf|otf);base64,[a-z0-9+/=]+$/i.test(value)) return `url("${value}")`;
      const url = safeOnlineUrl(value);
      return url ? `url("${url.replace(/"/g, "%22")}")` : "none";
    }).replace(/<\/style/gi, "<\\/style");
}

export function serializePageSnapshot(input: { root: HTMLElement; cssText: string; title: string; capturedAt: string; pageIds?: readonly SnapshotPageId[] }): string {
  // Only explicit direct children are page boundaries. Nested business source markers are never pages.
  const requested = input.pageIds && new Set<string>(input.pageIds);
  const originalsByPage = new Map<string, HTMLElement>();
  if (requested) {
    if (!requested.size || requested.size !== input.pageIds!.length) throw new Error("无效或重复的快照页面边界");
    for (const child of input.root.children) {
      if (!(child instanceof HTMLElement) || !child.hasAttribute("data-snapshot-page")) continue;
      const id = child.getAttribute("data-snapshot-page")!;
      if (!['SECTION', 'DIV'].includes(child.tagName)) throw new Error(`无效的快照页面边界: ${id}`);
      if (!requested.has(id) || originalsByPage.has(id)) throw new Error(`快照页面边界不匹配: ${id}`);
      originalsByPage.set(id, child);
    }
    if (originalsByPage.size !== requested.size) throw new Error("快照页面边界缺失");
  }
  const clone = input.root.cloneNode(true) as HTMLElement;
  const pageCopies = new Map<string, HTMLElement>();
  if (requested) for (const [id, original] of originalsByPage) {
    const index = Array.prototype.indexOf.call(input.root.children, original) as number;
    pageCopies.set(id, clone.children[index] as HTMLElement);
  }
  const originals = [input.root, ...input.root.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];
  for (let index = 0; index < originals.length; index++) {
    const live = originals[index], copy = copies[index];
    if (live instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      if (["password", "hidden", "file"].includes(live.type)) { copy.remove(); continue; }
      copy.setAttribute("value", live.value); copy.toggleAttribute("checked", live.checked);
      copy.setAttribute("readonly", ""); copy.setAttribute("disabled", "");
    } else if (live instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) {
      copy.textContent = live.value; copy.setAttribute("readonly", "");
    } else if (live instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
      Array.from(copy.options).forEach((option, i) => option.toggleAttribute("selected", live.options[i].selected));
      copy.setAttribute("disabled", "");
    } else if (live instanceof HTMLCanvasElement) {
      const image = document.createElement("img");
      try { image.src = live.toDataURL("image/png"); } catch { throw new Error("图表快照读取失败，请重试"); }
      image.width = live.width; image.height = live.height; image.className = live.className; image.alt = live.getAttribute("aria-label") || "图表";
      image.setAttribute("data-snapshot-canvas", "true"); copy.replaceWith(image);
    }
  }
  clone.querySelectorAll('script,style,link,iframe,object,embed,template,base,meta,button,[data-snapshot-omit],foreignObject').forEach(node => node.remove());
  // Forms keep their read-only business values, never submission behavior.
  clone.querySelectorAll("form").forEach(form => form.replaceWith(...form.childNodes));
  for (const node of [clone, ...clone.querySelectorAll("*")]) {
    const canvasImage = node instanceof HTMLImageElement && node.getAttribute("data-snapshot-canvas") === "true";
    for (const attribute of [...node.attributes]) {
      const key = attribute.name.toLowerCase();
      if (key.startsWith("on") || (key.startsWith("data-") && key !== "data-snapshot-module")
        || ["srcdoc", "srcset", "action", "formaction", "form", "name", "autofocus", "nonce", "integrity", "contenteditable", "ping"].includes(key)) node.removeAttribute(attribute.name);
      if (key === "style") node.setAttribute("style", safeCss(attribute.value));
      if (["href", "xlink:href", "src", "poster"].includes(key)) {
        const localReference = key !== "src" && /^#[\w:.-]+$/.test(attribute.value);
        const url = localReference ? attribute.value : canvasImage && key === "src" && attribute.value.startsWith("data:image/png;base64,")
          ? attribute.value : safeOnlineUrl(attribute.value, key === "src");
        if (url) node.setAttribute(attribute.name, url); else node.removeAttribute(attribute.name);
      }
    }
    if (node instanceof HTMLImageElement) { node.loading = "eager"; node.setAttribute("referrerpolicy", "no-referrer"); }
    if (node instanceof HTMLAnchorElement) { node.rel = "noopener noreferrer"; node.target = "_blank"; node.setAttribute("referrerpolicy", "no-referrer"); }
  }
  const css = safeCss(input.cssText);
  if (requested) {
    for (const [id, copy] of pageCopies) {
      if (copy.parentElement !== clone) throw new Error(`快照页面边界在净化后缺失: ${id}`);
    }
    const pageElements = new Set(pageCopies.values());
    const header = [...clone.children].filter(child => !pageElements.has(child as HTMLElement)).map(child => child.outerHTML).join("");
    const shell = renderSnapshotNavigation(input.pageIds!.map(id => ({ id, html: pageCopies.get(id)!.outerHTML })));
    clone.innerHTML = header + shell;
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:; base-uri 'none'; form-action 'none'; object-src 'none'"><meta name="referrer" content="no-referrer"><meta name="snapshot-captured-at" content="${escapeHtml(input.capturedAt)}"><title>${escapeHtml(input.title)} · 项目快照</title><style>${css}</style></head><body>${clone.outerHTML}</body></html>`;
}
