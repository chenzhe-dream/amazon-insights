import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../app/globals.css";
import "../../../app/warm-theme.css";
import "../../../app/comparison-layout.css";
import { useSidebarCollapse } from "../../../app/lib/sidebar-preference";
import { SidebarCollapseToggle } from "../../../app/sidebar-collapse-toggle";
import { CompetitorOverviewMatrix, type CompetitorOverviewSnapshotProps, type Product } from "../../../app/project-report-views/competitor-overview";

const asins = ["B07PX9Y715", "B0BT9F1F72", "B0CJV11YQF", "B0BDL8DZXD", "B00AAXD6X0", "B013YPIVB2", "B096WJQ7RR", "B0G5GS3XGV", "B0H8XB1X9S"];
const products = asins.map((asin, index): Product => ({
  asin, brand: `本地样例 ${index + 1}`, title: "平衡板 · 交互验收 fixture", image: "", price: 49.99 + index,
  sales: null, rating: null, reviews: null, rank: null, subRank: null, rankCategory: "—", subRankCategory: "—",
  buyBoxSeller: "公开商品卖家", fulfillment: "FBM", packageSize: "76.2 × 30.48 × 14.61 cm", packageWeight: "—",
  specifications: ["等待同步"], launch: "2026-07-13", format: "—", variants: "3", history: [], prices: [], ranks: [],
  variantShare: [], variantDetails: [], sellingPoints: [], strengths: [], weaknesses: [], unmet: [], scenarios: [], audiences: [],
  keywords: [], traffic: { natural: 0, sponsored: 0, recommendation: 0 }, catalogSource: "sorftime-fallback", synced: false,
  catalogFieldSources: index === 1 ? undefined : { buyBoxSeller: "sorftime", fulfillment: "sorftime", packageSize: "sorftime", launch: "sorftime", variants: "sorftime" },
}));
const props = {
  products, market: "US", slugParam: null, salesTrendByAsin: {}, ratingByAsin: {}, fbaFeeByAsin: {},
  childSalesByAsin: { B0BT9F1F72: [{ asin: "B0CJV11YQF", variant: "Color:Claw", sales: 30, observedAt: "2026-10-13" }] },
  priceStrategyByAsin: Object.fromEntries(products.map(product => [product.asin, { status: "ready", currentPrice: product.price, anchor: "当前价格及历史区间的定价锚点说明。完整文本在展开后显示。", promotion: "样例促销说明：未返回有效 Coupon。", psychology: "样例折扣心理：保留来源的定价比较，不推断实际转化。", evidence: "本地 fixture · 非正式报告 · product_detail + product_trend" }])),
  listingContentByAsin: { B0BT9F1F72: { asin: "B0BT9F1F72", marketplace: "US", status: "ready", source: "Sorftime", specifications: ["Material: Birch wood", "Item Dimensions: 29.9 × 11.8 × 0.6 inches", "Maximum Weight: 485 lb"] } },
  sellingTranslationsByAsin: {}, categoryTrendByNode: {},
} as unknown as CompetitorOverviewSnapshotProps;

function Harness() {
  const { collapsed, toggle } = useSidebarCollapse();
  const [flyout, setFlyout] = useState(false);
  const [active, setActive] = useState("overview");
  const [top, setTop] = useState(150);
  const [snapshot, setSnapshot] = useState(false);
  const open = (trigger: HTMLElement) => { setTop(trigger.getBoundingClientRect().top - trigger.closest(".nav-rail")!.getBoundingClientRect().top); setFlyout(true); };
  return <main className={`app-shell${collapsed ? " sidebar-collapsed" : ""}${flyout ? " flyout-open" : ""}`} onKeyDown={event => { if (event.key === "Escape") setFlyout(false); }}>
    <div className="nav-rail"><aside className="sidebar" aria-label="主导航侧栏"><SidebarCollapseToggle collapsed={collapsed} onToggle={toggle}/>
      <div className="brand-mark"><span className="brand-icon" aria-hidden="true">A</span><div className="brand-copy"><strong>产品机会洞察</strong></div></div>
      <nav id="primary-navigation" aria-label="功能模块"><button type="button" className={`nav-item${active === "projects" ? " active" : ""}`} aria-label="项目" title="项目" aria-current={active === "projects" ? "page" : undefined} onClick={() => {setActive("projects"); setFlyout(false);}}><span className="nav-icon-tile" aria-hidden="true">P</span><span className="nav-item-copy"><b>项目</b><small>已保存的项目</small></span></button>
        <button type="button" className={`nav-item nav-group-trigger${active === "overview" ? " active" : ""}`} data-dim="overview" aria-label="竞品分析" title="竞品分析" aria-expanded={flyout} aria-controls="sidebar-flyout" onFocus={event => open(event.currentTarget)} onMouseEnter={event => open(event.currentTarget)} onClick={event => open(event.currentTarget)}><span className="nav-icon-tile" aria-hidden="true">C</span><span className="nav-item-copy"><b>竞品分析</b><small>竞品参数与价格策略</small></span><span className="nav-chevron" aria-hidden="true" /></button>
      </nav><div className="sidebar-bottom"><button className="help-feedback-entry" aria-label="帮助与反馈"><span aria-hidden="true">?</span><b>帮助与反馈</b></button><p>本地验收样例 · 无供应商请求</p></div>
    </aside><aside id="sidebar-flyout" className="sidebar-flyout" style={{top}} aria-hidden={!flyout} aria-label="竞品子菜单"><div className="sidebar-flyout-list"><a className="sidebar-flyout-item active" aria-current="page" href="#overview" onClick={() => {setActive("overview"); setFlyout(false);}}><span className="nav-icon-tile" aria-hidden="true">O</span><span className="nav-item-copy"><b>竞品参数总览</b><small>九个 ASIN</small></span></a></div></aside></div>
    <section className="workspace"><header className="topbar"><div><h1>平衡板 · 本地交互验收</h1><p className="eyebrow">UI fixture，无正式服务或供应商调用</p></div></header><div className="page-content"><button type="button" className="ghost-btn" aria-pressed={snapshot} onClick={() => setSnapshot(value => !value)}>{snapshot ? "查看交互页面" : "查看导出快照"}</button>{snapshot ? <CompetitorOverviewMatrix {...props} presentation="snapshot"/> : <CompetitorOverviewMatrix {...props} presentation="page" translationProjectId={null} translationKey="local"/>}</div></section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
