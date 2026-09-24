import { LaunchSection } from "../../launch-section";
import { marketStructureVerdictLabel } from "./market-structure-synthesis-analysis";
import type { ReferenceConclusions } from "./index";
import type { ResearchGrade } from "./brand-price-opportunity-analysis";

type Ready = { [K in keyof ReferenceConclusions]: Extract<ReferenceConclusions[K], { status: "ready" }>["result"] };
const tone: Record<string, string> = { green: "listing-age-entry-green", light_green: "listing-age-entry-light-green", yellow: "listing-age-entry-yellow", red: "listing-age-entry-red", gray: "listing-age-entry-gray" };
const confidence = { high: "高", medium: "中", low: "低", insufficient: "不足" };
const researchGradeLabels: Record<ResearchGrade, string> = { GREEN: "优先研究", YELLOW: "差异化研究", RED: "暂缓", GRAY: "待验证" };
const sentences = (value: string) => value.split("。").map(part => part.trim()).filter(Boolean);

export function ReferenceListingYearConclusion({ result, embedded = false }: { result: Ready["listingYear"]; embedded?: boolean }) {
  const body = <div className={`listing-age-conclusion ${tone[result.classification.entryColor]}`}>
      <h4 className="listing-age-conclusion-title">{result.classification.marketType}</h4>
      <p>{result.classification.entryRecommendation}</p><p>{result.summary}</p>
      <div className="market-structure-synthesis-extra"><p className="listing-age-conclusion-block-title">依据与风险</p><ul>{[...result.evidence, ...result.risks].map((item, i) => <li key={i}>{item}</li>)}</ul></div>
    </div>;
  return embedded ? body : <LaunchSection title="上架年份 · 新品准入结论" description="按链接上架时间及近6个月销量识别新品机会" badge={<span className="source-badge">{result.analysisScope.validProductCount} 条有效链接 · 置信度 {confidence[result.analysisScope.confidence]}</span>}>{body}</LaunchSection>;
}

export function ReferenceShapeSalesConclusion({ result, embedded = false }: { result: Ready["shapeSales"]; embedded?: boolean }) {
  const body = <div className="listing-age-conclusion market-shape-saved-conclusion"><p>{result.summary}</p>
      <div className="market-structure-dimension-grid">{result.insights.map(item => <article className="market-structure-dimension-card" key={item.productShape}>
        <h5>{item.productShape} · {item.entryPriority}</h5><p>{item.trendLabel}</p><p>{item.recommendation}</p>
      </article>)}</div>
    </div>;
  return embedded ? body : <LaunchSection title="商品形态 · 销量份额结论" description="比较形态份额趋势与切入优先级" badge={<span className="source-badge">{result.insights.length} 种已标注形态</span>}>{body}</LaunchSection>;
}

export function ReferenceShapePriceConclusion({ result, embedded = false }: { result: Ready["shapePrice"]; embedded?: boolean }) {
  const body = <div className="listing-age-conclusion market-shape-saved-conclusion"><p>{result.summary}</p><p>{result.crossStructureSummary}</p>
      <div className="market-structure-dimension-grid">{result.coreSteps.map(step => <article className="market-structure-dimension-card" key={step.id}><h5>{step.title}</h5><p>{step.finding}</p></article>)}</div>
      {result.shapes.map(shape => <div className="market-structure-synthesis-extra" key={shape.productShape}><h5>{shape.productShape} · {shape.structuralShiftSummary}</h5><ul>{shape.developmentDirections.map((item, i) => <li key={i}>{item}</li>)}</ul></div>)}
    </div>;
  return embedded ? body : <LaunchSection title="商品形态 × 价格带 · 结构结论" description="识别主流带、结构迁移和开发方向" badge={<span className="source-badge">{result.analysisScope.shapeCount} 种形态 · {result.analysisScope.segmentCount} 个交叉价格带</span>}>{body}</LaunchSection>;
}

export function ReferenceBrandPriceConclusion({ result, embedded = false }: { result: Ready["brandPrice"]; embedded?: boolean }) {
  const body = <div className="listing-age-conclusion market-shape-saved-conclusion brand-price-opportunity"><h4 className="listing-age-conclusion-title">{result.classification.headline}</h4><p className="listing-age-conclusion-summary">{result.summary}</p>
      <p className="brand-price-scope-note">价格带销量份额以当前商品池的销量为分母；CR1 / CR3 以当前价格带样本的销量为分母，分别表示第一品牌、前三品牌合计份额。以上均为样本内统计，不代表整个类目。</p>
      <div className="market-structure-dimension-grid brand-price-opportunity-grid">{result.priceBands.map(band => <article className="market-structure-dimension-card brand-price-opportunity-card" key={band.priceBand}>
        <header className="market-structure-dimension-head"><h5>{band.priceBand}</h5><span className={`brand-price-grade brand-price-grade-${band.grade.toLowerCase()}`}>{researchGradeLabels[band.grade]}</span></header>
        <p className="brand-price-sample">样本：{band.linkCount} 个商品 · {band.brandCount} 个品牌</p>
        <p className="brand-price-finding">{band.demandLabel} · {band.competitionLabel}</p><p className="brand-price-trend">{band.trendLabel}</p>
        {band.limitations.length > 0 && <div className="brand-price-limitations"><strong>{band.grade === "GRAY" ? "待验证原因" : "判断限制"}</strong><ul>{band.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
        <ul className="market-structure-dimension-list">{band.evidence.map((item, i) => <li key={i}>{item}</li>)}</ul>
      </article>)}</div>
      <div className="market-structure-synthesis-extra"><p className="listing-age-conclusion-block-title">机会与风险</p><ul>{[...result.recommendedActions, ...result.risks].map((item, i) => <li key={i}>{item}</li>)}</ul></div>
    </div>;
  return embedded ? body : <LaunchSection title="品牌 × 价格带 · 机会结论" description="按需求、竞争和品牌布局筛选价格带" badge={<span className="source-badge">{result.analysisScope.validLinkCount} 条有效链接 · 置信度 {confidence[result.analysisScope.confidence]}</span>}>{body}</LaunchSection>;
}

export function ReferenceSynthesisConclusion({ result, embedded = false }: { result: Ready["synthesis"]; embedded?: boolean }) {
  const body = <div className={`listing-age-conclusion market-structure-synthesis ${tone[result.verdictColor]}`} id="market-structure-synthesis-conclusion">
      <div className="market-structure-synthesis-top"><div className="market-structure-synthesis-verdict-card"><p className="listing-age-conclusion-eyebrow">五维结构综合</p><h4 className="listing-age-conclusion-title">{marketStructureVerdictLabel(result.verdict)}<span className="listing-age-conclusion-badge">{result.score}/100</span></h4><p className="market-structure-synthesis-def">{result.verdictDefinition}</p></div>
        <div className="market-structure-synthesis-meta-grid"><div><span>样本链接</span><b>{result.topLinkCount}</b></div><div><span>主销价格带</span><b>{result.highlights.primaryPriceBand ?? "待验证"}</b></div><div><span>可进入毛利链接</span><b>{result.highlights.marginGreenSharePct.toFixed(1)}%</b></div><div><span>Top3 Listing</span><b>{result.highlights.top3ListingSharePct == null ? "—" : `${result.highlights.top3ListingSharePct.toFixed(1)}%`}</b></div></div>
      </div>
      <p>{result.summary}</p><p>{result.finalVerdict}</p>
      <div className="market-structure-dimension-grid">{result.moduleSections.map(section => <article className="market-structure-dimension-card" key={section.key}><header className="market-structure-dimension-head"><h5>{section.title}</h5><span className="market-structure-dimension-score">{section.score}/{section.maxScore}</span></header><div className="market-structure-dimension-bar" aria-hidden="true"><i style={{ width: `${Math.round(section.score / section.maxScore * 100)}%` }} /></div>{section.marginAccessDetail ? <p>{section.marginAccessDetail.headline}</p> : <ul>{sentences(section.text).map((item, i) => <li key={i}>{item}。</li>)}</ul>}</article>)}</div>
      <div className="market-structure-synthesis-extra"><p className="market-structure-synthesis-extra-title">机会与风险</p><div className="market-structure-synthesis-extra-body market-structure-synthesis-extra-split"><div className="market-structure-synthesis-extra-column"><p className="listing-age-conclusion-block-title">机会方向</p><ul>{result.opportunities.map((item, i) => <li key={i}>{item}</li>)}</ul></div><div className="market-structure-synthesis-extra-column"><p className="listing-age-conclusion-block-title">主要风险</p><ul>{result.risks.map((item, i) => <li key={i}>{item}</li>)}</ul></div></div></div>
    </div>;
  return embedded ? body : <LaunchSection title="类目商品链接调研 · 最终结论" description="综合 TOP 销售、上架年份、形态价格带与品牌价格带的五维结论" badge={<span className="source-badge">{result.sampleScope} · {result.score}/100 · 置信度 {confidence[result.confidence]}</span>}>{body}</LaunchSection>;
}

export function ReferenceConclusionsView({ result }: { result: ReferenceConclusions }) {
  const missing = (title: string, reason: string) => <LaunchSection title={title} description="来源销量未满足原结论规则的计算条件"><div className="listing-age-conclusion market-shape-saved-conclusion">{reason}</div></LaunchSection>;
  return <div className="market-shape-structure">
    {result.listingYear.status === "ready" ? <ReferenceListingYearConclusion result={result.listingYear.result} /> : missing("上架年份 · 新品准入结论", result.listingYear.reason)}
    {result.shapeSales.status === "ready" ? <ReferenceShapeSalesConclusion result={result.shapeSales.result} /> : missing("商品形态 · 销量份额结论", result.shapeSales.reason)}
    {result.shapePrice.status === "ready" ? <ReferenceShapePriceConclusion result={result.shapePrice.result} /> : missing("商品形态 × 价格带 · 结构结论", result.shapePrice.reason)}
    {result.brandPrice.status === "ready" ? <ReferenceBrandPriceConclusion result={result.brandPrice.result} /> : missing("品牌 × 价格带 · 机会结论", result.brandPrice.reason)}
    {result.synthesis.status === "ready" ? <ReferenceSynthesisConclusion result={result.synthesis.result} /> : missing("类目商品链接调研 · 最终结论", result.synthesis.reason)}
  </div>;
}
