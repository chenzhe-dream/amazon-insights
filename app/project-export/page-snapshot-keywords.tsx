import {KeywordDemandSection} from "../keyword-demand-section";
import type {KeywordsSnapshotSources} from "./read-page-snapshot-keywords";

/** The published page's two keyword areas, with native disclosures for the static snapshot. */
export function PageSnapshotKeywords(props: KeywordsSnapshotSources) {
  return <div className="page-content compare-page snapshot-keywords">
    <details className="snapshot-keywords-tab" open>
      <summary className="card section-head"><h2>竞品关键词分析</h2></summary>
      <div className="snapshot-keywords-tab-content" style={{marginTop:16}}>
        <KeywordDemandSection products={props.products} mode="analysis" sources={props.sources}
          analysisScope={props.analysisScope} snapshotMeta={props.sourceMeta}/>
      </div>
    </details>
    <details className="snapshot-keywords-tab">
      <summary className="card section-head"><h2>关键词洞察</h2></summary>
      <div className="snapshot-keywords-tab-content" style={{marginTop:16}}>
        <KeywordDemandSection products={props.products} mode="insight" sources={props.sources}
          analysisScope={props.analysisScope} snapshotMeta={props.sourceMeta}/>
      </div>
    </details>
    <details className="snapshot-keywords-sources">
      <summary>已发布关键词来源</summary>
      <ul>{props.sourceRows.map(row => <li key={row.asin}>
        <b>{row.asin}</b> · {row.status === "ready" ? "已就绪" : row.status === "empty" ? "无词条" : row.status === "error" ? "读取失败" : "未保存"}
        {" · "}{row.fetchedAt ?? "采集时间未记录"}{" · "}{row.period ?? "来源周期未记录"}
        {row.notice ? <> · {row.notice}</> : null}
      </li>)}</ul>
    </details>
  </div>;
}
