import type { ConclusionPresentation } from './lib/product-definition-presentation';
import { hasVisibleQualification } from './lib/product-definition-presentation';
import { InlineReportText } from './product-definition-inline';
import { presentDefinitionCard } from './lib/product-definition-presentation';
import type { FinalDefinitionRow } from './final-product-definition';
import type { AnalysisRuleTrace } from '../shared/product-structure-rules';

/** Formatting only: keep every character, including separators and qualifications. */
export function ReportParagraphs({text}: {text: string}) {
  return <div className="definition-reading-paragraphs">{text.split(/(?<=[；;\n])/u).map((part,index)=><div className="definition-reading-paragraph" key={index}>{part}</div>)}</div>;
}

export function OverviewDefinitionValue({card,rows,trace}: {card: {key:string;value:string};rows:FinalDefinitionRow[];trace?:AnalysisRuleTrace}) {
  const presentation=presentDefinitionCard(card,rows,trace);
  if (!presentation) return hasVisibleQualification(card.value) ? <ReportParagraphs text={card.value} /> : <InlineReportText text={card.value} splitAsins lines={2} />;
  return <div>
    <DefinitionConclusion value={presentation} />
    {presentation.productKeys.length>0 && (trace?.inputScope.asins.length ?? 0)>1 ? <div className="definition-product-keys">{presentation.productKeys.map(key=><div key={key.asin}>{key.label}：{key.asin}</div>)}</div> : null}
    <details className="definition-reading-more"><summary>查看原文</summary><div className="definition-conclusion-original">{card.value}</div></details>
  </div>;
}

export function DefinitionConclusion({ value }: {value: ConclusionPresentation}) {
  if (!value.summarized) return hasVisibleQualification(value.points[0])
    ? <div className="definition-conclusion-original">{value.points[0]}</div>
    : <InlineReportText text={value.points[0]} />;
  return <div className="definition-conclusion">
    {value.points.length ? <ul className="definition-inline-list">{value.points.slice(0,3).map(point=><li key={point}>{point}</li>)}</ul> : <p>适用范围待核对</p>}
    {value.points.length>3 ? <details className="definition-reading-more"><summary>展开其余 {value.points.length-3} 项结论</summary><ul className="definition-inline-list">{value.points.slice(3).map(point=><li key={point}>{point}</li>)}</ul></details> : null}
    {value.warnings.length ? <ul className="definition-inline-list definition-conclusion-warnings">{value.warnings.map(warning=><li key={warning}>{warning}</li>)}</ul> : null}
  </div>;
}
