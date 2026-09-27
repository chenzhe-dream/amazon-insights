import {ManualVocMatrixSection, ReviewAnalysisMatrixSection, VocOverviewIntroduction, VocSevenDimensionInsightSection} from "../project-report-views/voc";
import {ProductLaunchRecommendationSection} from "../product-launch-recommendation";
import {VocPositioningSection} from "../voc-positioning-section";
import {sorftimeReviewAnalysisMeta} from "../seller-sprite-review-analysis";
import {sorftimeReviewAnalysisMeta as reviewDataMeta} from "../sorftime-review-analysis-data";
import type {VocSnapshotSources} from "./read-page-snapshot-voc";

/** Original business views with frozen explicit inputs; never mounts the application page. */
export function PageSnapshotVoc({page, ...props}: VocSnapshotSources & {page: "voc-summary" | "voc-insight" | "voc-positioning"}) {
  const records = Object.fromEntries(props.manualRecords.map(record => [record.asin,record]));
  const manualVocByAsin = Object.fromEntries(props.manualRecords.map(record => [record.asin,record.normalizedRecord]));
  return <div className="page-content compare-page">
    {page === "voc-summary" && <>
    <div className="card section-head"><h2>竞品 VOC 汇总</h2></div>
    <div className="compare-page snapshot-voc-tab-content" style={{display:"flex",flexDirection:"column",gap:16,marginTop:16}}>
    <VocOverviewIntroduction products={props.products}/>
    <ManualVocMatrixSection products={props.products} market={props.market} effectiveVocByAsin={records}
      statusByAsin={Object.fromEntries(props.products.map(product => [product.asin,records[product.asin] ? "ready" : "missing"]))}/>
    <ReviewAnalysisMatrixSection title="智能评论分析"
      description="Sorftime MCP · 按实际返回的 Customers Say 主题及评论样本展示 · 六维同屏对齐 · 格式：【分类】+ 提及占比；各 ASIN 的样本数和采集时间见表头。"
      badge="Sorftime MCP" data={props.reviewRecords} missingMessages={props.reviewMissingMessages}
      dataMeta={{...reviewDataMeta, updatedAt:props.reviewUpdatedAt, mcpNote:"暂无已保存的当前项目评论结果。"}}
      configMeta={sorftimeReviewAnalysisMeta} pendingSteps="暂无已保存评论数据。"
      products={props.products} market={props.market}/>
    <VocSevenDimensionInsightSection products={props.products} manualVocByAsin={manualVocByAsin} reviewAnalysisData={props.reviewRecords}/>
    </div>
    </>}
    {page === "voc-insight" && (props.analysisInputs ? <>
      <div className="card section-head"><h2>竞品 VOC 洞察</h2></div>
      <div className="compare-page snapshot-voc-tab-content" style={{display:"flex",flexDirection:"column",gap:16,marginTop:16}}>
      <ProductLaunchRecommendationSection products={props.analysisInputs.products} sources={props.analysisInputs.sources}/>
      </div>
    </> : <section className="card launch-block"><h2>竞品 VOC 洞察</h2><div className="pending-box">暂无已发布基础报告，当前没有可展示的 VOC 洞察。</div></section>)}
    {page === "voc-positioning" && (props.analysisInputs ? <>
      <div className="card section-head"><h2>产品定义结论</h2></div>
      <div className="compare-page snapshot-voc-tab-content" style={{display:"flex",flexDirection:"column",gap:16,marginTop:16}}>
      <VocPositioningSection products={props.analysisInputs.products} sources={props.analysisInputs.sources}/>
      </div>
    </> : <section className="card launch-block"><h2>产品定义结论</h2><div className="pending-box">暂无已发布基础报告，当前没有可展示的产品定义结论。</div></section>)}
  </div>;
}
