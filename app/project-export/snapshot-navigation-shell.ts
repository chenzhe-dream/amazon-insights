import { snapshotNavigationGroups, type SnapshotPageId } from './snapshot-navigation-catalog';
import { snapshotNavigationStyles } from './snapshot-navigation-styles';

export type SnapshotPageMarkup = Readonly<{ id: SnapshotPageId; html: string }>;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const ordered: { id: SnapshotPageId; label: string; sub: string }[] = [];
for (const group of snapshotNavigationGroups) ordered.push(...group.pages);
const known = new Set<string>(ordered.map(page => page.id));
const toneColor = {blue:'#2f80ed',teal:'#1aa8a1',red:'#e55353',orange:'#e8912d',green:'#1a9f63'};
const childColor: Partial<Record<SnapshotPageId, string>> = {
  overview:'#1a9f63', images:'#e8912d', 'voc-insight':'#7a67d8',
  'voc-positioning':'#1a9f63', 'keyword-insight':'#2f80ed',
};

// Paths are fixed, semantic counterparts of the application's sidebar icon themes.
const icons = {
  overview:'<rect x="3.5" y="5.5" width="13" height="9.5" rx="2"/><rect x="7.5" y="9" width="13" height="9.5" rx="2"/><path d="M10.5 13.5h7M10.5 15.8h4.5"/>',
  params:'<rect x="4" y="4.5" width="16" height="15" rx="2"/><path d="M4 9.5h16M4 14h16M9.5 9.5v10"/>',
  gallery:'<rect x="3.5" y="5" width="13" height="11" rx="2"/><path d="M3.5 13.5 7.2 10l2.4 2.1 2.6-3.2 4.3 4.6"/><rect x="11" y="8" width="9.5" height="11" rx="2"/>',
  review:'<path d="M5 16.8 3.6 20.2 7.4 18.5A8.2 8.2 0 1 0 5 16.8Z"/><path d="m12 8.2 1.05 2.15 2.35.3-1.75 1.6.5 2.3L12 13.4l-2.15 1.15.5-2.3-1.75-1.6 2.35-.3Z"/>',
  search:'<circle cx="10.5" cy="10.5" r="5.6"/><path d="m14.8 14.8 4.4 4.4M8.2 10.5h4.6"/>',
  layout:'<rect x="4" y="3.5" width="16" height="17" rx="2"/><rect x="6.5" y="6" width="11" height="4.5" rx="1"/><rect x="6.5" y="12" width="5" height="5.5" rx="1"/><rect x="12.5" y="12" width="5" height="5.5" rx="1"/>',
  shield:'<path d="M12 3.4 5.2 6.1v5.8c0 4.1 2.9 7.9 6.8 9.1 3.9-1.2 6.8-5 6.8-9.1V6.1L12 3.4Z"/><path d="m9.2 12.1 1.8 1.8 3.8-3.8"/>',
  insight:'<path d="M12 3.6a5.4 5.4 0 0 0-3.2 9.7c.5.4.8 1 .8 1.6v.6h4.8v-.6c0-.6.3-1.2.8-1.6A5.4 5.4 0 0 0 12 3.6Z"/><path d="M10 16.8h4M10.6 19.2h2.8"/>',
};
function icon(name: keyof typeof icons) { return `<span class="snapshot-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg></span>`; }
function card(label: string, sub: string, iconName: keyof typeof icons, child = false) {
  return `${icon(iconName)}<span class="snapshot-nav-copy"><b>${escapeHtml(label)}</b><small>${escapeHtml(sub)}</small></span>${child ? '' : '<i class="snapshot-nav-chevron" aria-hidden="true"></i>'}`;
}

/** Assemble only already-sanitized business markup; this trusted HTML adds the sole active controls. */
export function renderSnapshotNavigation(pages: readonly SnapshotPageMarkup[]): string {
  if (!pages.length) throw new Error('快照页面不能为空');
  const ids = new Set<string>();
  for (const page of pages) {
    if (!known.has(page.id) || ids.has(page.id)) throw new Error(`无效或重复的快照页面: ${page.id}`);
    ids.add(page.id);
  }
  const sorted = ordered.filter(page => ids.has(page.id));
  const byId = new Map(pages.map(page => [page.id, page.html]));
  const first = sorted[0].id;
  const radios = sorted.map(page => `<input class="snapshot-radio" type="radio" name="snapshot-navigation" id="snapshot-page-${page.id}" aria-label="${escapeHtml(page.label)}"${page.id === first ? ' checked' : ''}>`).join('');
  const nav = snapshotNavigationGroups.flatMap(group => {
    const children = group.pages.filter(page => ids.has(page.id));
    if (!children.length) return [];
    const color = toneColor[group.tone];
    const groupIcon: keyof typeof icons = group.id === 'overview-group' ? 'overview' : group.id === 'voc-group' ? 'review' : group.id === 'keywords-group' ? 'search' : group.id === 'definition' ? 'layout' : group.id === 'checklist' ? 'shield' : 'insight';
    if (group.kind === 'direct') return [`<label class="snapshot-nav-card snapshot-nav-direct" style="--snap-tone:${color}" for="snapshot-page-${children[0].id}">${card(group.label,group.sub,groupIcon,true)}</label>`];
    const leaf = children.map(page => {
      const childIcon: keyof typeof icons = page.id === 'overview' ? 'params' : page.id === 'images' ? 'gallery' : groupIcon;
      return `<label class="snapshot-nav-card snapshot-nav-child" style="--snap-tone:${childColor[page.id] ?? color}" for="snapshot-page-${page.id}">${card(page.label,page.sub,childIcon,true)}</label>`;
    }).join('');
    return [`<details class="snapshot-nav-group" data-snapshot-group="${group.id}"${children.some(page => page.id === first) ? ' open' : ''}><summary class="snapshot-nav-card" style="--snap-tone:${color}">${card(group.label,group.sub,groupIcon)}</summary><div class="snapshot-nav-children">${leaf}</div></details>`];
  }).join('');
  const content = sorted.map(page => `<section class="snapshot-page" data-snapshot-page="${page.id}">${byId.get(page.id)}</section>`).join('');
  const rules = sorted.map(page => {
    const group = snapshotNavigationGroups.find(item => item.pages.some(child => child.id === page.id))!;
    const target = `#snapshot-page-${page.id}:checked~.snapshot-layout`;
    const focus = `#snapshot-page-${page.id}:focus-visible~.snapshot-layout`;
    const selected = `${target} label[for="snapshot-page-${page.id}"]`;
    const parent = group.kind === 'submenu' ? `${target} [data-snapshot-group="${group.id}"]>summary,` : '';
    const focusedParent = group.kind === 'submenu' ? `${focus} [data-snapshot-group="${group.id}"]>summary,` : '';
    return `${target} [data-snapshot-page="${page.id}"]{display:block}${parent}${selected}{box-shadow:inset 3px 0 0 var(--snap-tone);border-color:var(--snap-tone);background:color-mix(in srgb,var(--snap-tone) 7%,white)}${selected} b{color:var(--snap-tone)}${focusedParent}${focus} label[for="snapshot-page-${page.id}"]{outline:2px solid #155eef;outline-offset:2px}`;
  }).join('');
  return `<style>${snapshotNavigationStyles}\n${rules}</style><div class="snapshot-shell">${radios}<div class="snapshot-layout"><nav class="snapshot-nav" aria-label="快照页面导航"><div class="snapshot-nav-heading">报告目录<span>${sorted.length} 个页面</span></div><details class="snapshot-mobile-menu" open><summary>选择快照页面</summary><div class="snapshot-nav-list">${nav}</div></details></nav><main class="snapshot-body">${content}</main></div></div>`;
}
