import {LocalProductDefinitionSection} from "../local-product-definition-section";
import type {DefinitionSnapshotSources} from "./read-page-snapshot-definition";
import {ProductDefinitionSection} from '../product-definition-section';
import {AnalysisRuleExplanation} from '../analysis-rule-explanation';

/** The page's pure current definition view; saved report history is never mounted. */
export function PageSnapshotDefinition({analysisInputs, gapNotes, inputStatus}: DefinitionSnapshotSources) {
  return <div className="page-content compare-page snapshot-definition">
    {gapNotes.map(note => <section className="card launch-block" key={note}><p>{note}</p></section>)}
    {analysisInputs && inputStatus ? <>
      <section className="card launch-block" role="status"><h2>{inputStatus.kind === 'failure' ? '输入状态读取异常' : '正在核实输入'}</h2><p>{inputStatus.message}</p></section>
      <AnalysisRuleExplanation />
      <ProductDefinitionSection products={analysisInputs.products} sources={analysisInputs.sources} current={false} executionState="waiting-input" sourceLabel={inputStatus.message} />
    </> : analysisInputs
      ? <LocalProductDefinitionSection products={analysisInputs.products} sources={analysisInputs.sources} />
      : <section className="card launch-block"><h2>新品定义</h2><div className="pending-box">暂无已有分析输入，当前没有可展示的新品定义。</div></section>}
  </div>;
}
