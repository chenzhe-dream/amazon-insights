export function NavSubText({ text }: { text: string }) {
  const parts = String(text ?? "")
    .split(/\s*·\s*/)
    .filter(Boolean);
  if (parts.length <= 1) return <small>{text}</small>;
  return (
    <small className="nav-item-tags">
      {parts.map((part, index) => (
        <span key={`${part}-${index}`}>{part}</span>
      ))}
    </small>
  );
}

type NavTheme =
  | "traffic"
  | "convert"
  | "define"
  | "ads"
  | "search"
  | "insight"
  | "profit"
  | "stock"
  | "review"
  | "overview"
  | "params"
  | "gallery"
  | "layout"
  | "shield"
  | "bookmark";

const navThemeByDim: Record<string, NavTheme> = {
  "overview-group": "overview",
  overview: "params",
  "overview-images": "gallery",
  traffic: "traffic",
  "projects-group": "bookmark",
  projects: "stock",
  "keyword-compare": "search",
  "traffic-promo": "ads",
  "checklist-library": "shield",
  definition: "define",
  checklist: "shield",
  keywords: "search",
  "keyword-insight": "insight",
  "keywords-group": "search",
  launch: "profit",
  "voc-positioning": "convert",
  voc: "review",
  "voc-group": "review",
};

export function NavThemeIcon({ dim }: { dim: string }) {
  const theme = navThemeByDim[dim] ?? "traffic";
  const glyph = {
    traffic: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M4.2 16.8h3.1V20H4.2zM10.45 12.2h3.1V20h-3.1zM16.7 7.2h3.1V20h-3.1z" fill="currentColor" opacity=".92"/>
        <path d="M4.4 11.2c2.2-3.4 4.5-4.2 6.8-2.2 2.1 1.8 3.7 1.9 5.7-.2l1.3-1.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M16.2 5.4h3.4v3.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    convert: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M3.5 5h2.2l1.4 9.2a1.6 1.6 0 0 0 1.6 1.35h8.4a1.6 1.6 0 0 0 1.55-1.2L20.5 8H7.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx="10" cy="19.2" r="1.35" fill="currentColor"/>
        <circle cx="17.2" cy="19.2" r="1.35" fill="currentColor"/>
      </svg>
    ),
    define: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M4 9.2 12 4.6l8 4.6v7.6L12 21.4 4 16.8V9.2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="M12 4.6v8.2M12 12.8 20 9.2M12 12.8 4 9.2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="M6.4 10.6h3.4M6.4 12.4h4.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".9"/>
        <path d="M15.6 15.4 18.4 18.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
        <path d="m14.4 16.6 1.3-1.3 1.8 1.8-1.3 1.3-1.5-.2.2-1.6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
      </svg>
    ),
    ads: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M4.5 10.2v3.6c0 .9.7 1.6 1.6 1.6h2.2l5.4 3.4V5.2L8.3 8.6H6.1c-.9 0-1.6.7-1.6 1.6Z" fill="currentColor"/>
        <path d="M16.8 8.6c1.1.9 1.8 2.2 1.8 3.4s-.7 2.5-1.8 3.4M18.9 6.4c1.8 1.5 2.9 3.4 2.9 5.6s-1.1 4.1-2.9 5.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
      </svg>
    ),
    search: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="5.6" stroke="currentColor" strokeWidth="1.9"/>
        <path d="m14.8 14.8 4.4 4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"/>
        <path d="M8.2 10.5h4.6M10.5 8.2v4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      </svg>
    ),
    insight: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M12 3.6a5.4 5.4 0 0 0-3.2 9.7c.5.4.8 1 .8 1.6v.6h4.8v-.6c0-.6.3-1.2.8-1.6A5.4 5.4 0 0 0 12 3.6Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
        <path d="M10 16.8h4M10.6 19.2h2.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
        <path d="M12 7.2v2.4M10.2 9.4 12 11.2l1.8-1.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    profit: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <ellipse cx="12" cy="6.2" rx="6.2" ry="2.4" fill="currentColor"/>
        <path d="M5.8 6.2v3.6c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4V6.2" stroke="currentColor" strokeWidth="1.7"/>
        <path d="M5.8 9.8v3.6c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4V9.8" stroke="currentColor" strokeWidth="1.7"/>
        <path d="M5.8 13.4v3.6c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4v-3.6" stroke="currentColor" strokeWidth="1.7"/>
      </svg>
    ),
    stock: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M3.8 10.2 12 4.8l8.2 5.4V19a1.2 1.2 0 0 1-1.2 1.2H5a1.2 1.2 0 0 1-1.2-1.2v-8.8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="M9 20.2V13h6v7.2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="M3.8 10.2h16.4" stroke="currentColor" strokeWidth="1.7"/>
      </svg>
    ),
    review: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M5 16.8 3.6 20.2 7.4 18.5A8.2 8.2 0 1 0 5 16.8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="m12 8.2 1.05 2.15 2.35.3-1.75 1.6.5 2.3L12 13.4l-2.15 1.15.5-2.3-1.75-1.6 2.35-.3L12 8.2Z" fill="currentColor"/>
      </svg>
    ),
    overview: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <rect x="3.5" y="5.5" width="13" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.7"/>
        <rect x="7.5" y="9" width="13" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.7" fill="currentColor" fillOpacity=".08"/>
        <path d="M10.5 13.5h7M10.5 15.8h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      </svg>
    ),
    params: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <rect x="4" y="4.5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.7"/>
        <path d="M4 9.5h16M4 14h16M9.5 9.5v10" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    ),
    gallery: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <rect x="3.5" y="5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.7"/>
        <path d="M3.5 13.5 7.2 10l2.4 2.1 2.6-3.2 4.3 4.6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <circle cx="8.2" cy="9" r="1.1" fill="currentColor"/>
        <rect x="11" y="8" width="9.5" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" opacity=".9"/>
      </svg>
    ),
    layout: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <rect x="4" y="3.5" width="16" height="17" rx="2" stroke="currentColor" strokeWidth="1.7"/>
        <rect x="6.5" y="6" width="11" height="4.5" rx="1" fill="currentColor" opacity=".32"/>
        <rect x="6.5" y="12" width="5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.4"/>
        <rect x="12.5" y="12" width="5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.4"/>
        <path d="M8 8.2h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    ),
    shield: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M12 3.4 5.2 6.1v5.8c0 4.1 2.9 7.9 6.8 9.1 3.9-1.2 6.8-5 6.8-9.1V6.1L12 3.4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="m9.2 12.1 1.8 1.8 3.8-3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    bookmark: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M7.2 4.4h9.6c.7 0 1.2.5 1.2 1.2v14.1l-6-3.3-6 3.3V5.6c0-.7.5-1.2 1.2-1.2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="M9.4 9.2h5.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  }[theme];

  return (
    <span className="nav-icon-tile" data-theme={theme} aria-hidden="true">
      {glyph}
    </span>
  );
}
