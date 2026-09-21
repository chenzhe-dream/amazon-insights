/** Clipboard API needs HTTPS; the legacy path also supports the local HTTP deployment. */
export async function copyKeywordText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Permission denied: try the user-initiated selection copy below. */ }
  const previous = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(textarea);
  try {
    textarea.focus(); textarea.select();
    return document.execCommand("copy");
  } catch { return false; }
  finally {
    textarea.remove();
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); }
  }
}
