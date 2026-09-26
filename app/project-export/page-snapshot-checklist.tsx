import { LaunchChecklistSection } from "../launch-checklist-section";
import type { DefinitionSnapshotSources } from "./read-page-snapshot-definition";

/** The original checklist view over the frozen, explicitly scoped page inputs. */
export function PageSnapshotChecklist({ analysisInputs, gapNotes }: DefinitionSnapshotSources) {
  return <div className="page-content compare-page snapshot-checklist">
    {gapNotes.map(note => <section className="card launch-block" key={note}><p>{note}</p></section>)}
    {analysisInputs
      ? <LaunchChecklistSection products={analysisInputs.products} sources={analysisInputs.sources} />
      : <section className="card launch-block"><h2>产品立项前确认清单</h2><p className="launch-checklist-library-notice">未包含其他页面未保存的人工填写与勾选</p><div className="pending-box">暂无已有分析输入，当前没有可展示的确认清单。</div></section>}
  </div>;
}
