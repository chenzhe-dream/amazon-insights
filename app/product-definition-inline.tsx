"use client";

import { Fragment, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { describeRulePredicate, type AnalysisRuleTrace, type DecisionRecord, type EvidenceSource } from "../shared/product-structure-rules";
import { inlineDefinitionStyles } from "./product-definition-inline-styles";

type DecisionProps = { trace?: AnalysisRuleTrace; decisionIds?: string[] };

export function ProductDefinitionInlineStyles() {
  return <style>{inlineDefinitionStyles}</style>;
}

function TextDisclosure({ parts, lines, showAsinLabels = false }: { parts: string[]; lines: number; showAsinLabels?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const node = content.current;
    if (!node || expanded) return;
    const measure = () => setOverflow(Array.from(node.querySelectorAll('.definition-inline-body')).some(child => child.scrollHeight > child.clientHeight + 1));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, parts, lines]);
  function toggle() {
    if (expanded && content.current && content.current.getBoundingClientRect().top < 0) {
      content.current.scrollIntoView({ block: "start" });
    }
    setExpanded(!expanded);
  }
  return (
    <div className="definition-inline-text">
      <div ref={content} id={id} className={expanded ? "definition-inline-copy expanded" : "definition-inline-copy"} style={{ "--definition-inline-lines": lines } as CSSProperties}>
        {parts.map((part, index) => {
          const match = showAsinLabels ? part.match(/^([\s\S]*?)(\[[A-Z0-9]{10}\]|【[A-Z0-9]{10}】)([\s\S]*)$/) : null;
          return <div className="definition-inline-fragment" key={index}>{match ? <div className="definition-inline-asin-heading">{match[1]}<span className="definition-inline-asin-label">{match[2]}</span></div> : null}<div className="definition-inline-body">{match ? match[3] : part}</div></div>;
        })}
      </div>
      {overflow || expanded ? <button type="button" className="definition-inline-link" aria-expanded={expanded} aria-controls={id} onClick={toggle}>{expanded ? "收起 ▴" : "展开全文 ▾"}</button> : null}
    </div>
  );
}

/** Truncation is visual only. The original text remains in the same DOM nodes. */
export function InlineReportText({ text, lines = 3, splitAsins = false, expandTogether = false }: {
  text: string; lines?: number; splitAsins?: boolean; expandTogether?: boolean;
}) {
  const parts = splitAsins ? text.split(/(?=\[[A-Z0-9]{10}\]|【[A-Z0-9]{10}】)/g) : [text];
  if (parts.length > 1 && !/^(?:\[[A-Z0-9]{10}\]|【[A-Z0-9]{10}】)/.test(parts[0])) {
    parts.splice(0, 2, parts[0] + parts[1]);
  }
  if (expandTogether) return <TextDisclosure key={text} parts={parts} lines={lines} showAsinLabels={splitAsins} />;
  return <div className={splitAsins ? "definition-inline-asins" : undefined}>{parts.map((part, index) => <TextDisclosure key={`${index}-${part}`} parts={[part]} lines={lines} showAsinLabels={splitAsins} />)}</div>;
}

function conditionLabel(passed: boolean | null) {
  return passed === true ? "满足" : passed === false ? "不满足" : "未知";
}

function SourceExcerpt({ source }: { source: EvidenceSource }) {
  return <div className="definition-inline-source"><div className="definition-inline-muted">{source.kind === "voc" ? "VOC" : source.kind === "keyword" ? "关键词" : "产品资料"} · {source.asin ?? "项目级"}</div><InlineReportText text={source.text} /></div>;
}

function DecisionSources({ record, trace }: { record: DecisionRecord; trace: AnalysisRuleTrace }) {
  const references = [...new Set(record.evidenceRefs)].map(ref => {
    // A missing or ambiguous reference must never borrow another source.
    const matches = trace.sources.filter(source => source.id === ref);
    return { ref, source: matches.length === 1 ? matches[0] : undefined };
  });
  const available = references.flatMap(({ source }) => source ? [source] : []);
  const unavailable = references.filter(({ source }) => !source);
  return <div>
    <h5>引用依据 <span className="definition-inline-muted">{references.length} 条</span></h5>
    {unavailable.map(({ ref }) => <p className="definition-inline-warning" key={ref}>来源不可用（{ref}）</p>)}
    {available.slice(0, 2).map(source => <SourceExcerpt key={source.id} source={source} />)}
    {available.length > 2 ? <details className="definition-inline-more-sources"><summary><span className="definition-inline-more-label">展开其余 {available.length - 2} 条依据</span><span className="definition-inline-less-label">收起补充依据</span></summary>{available.slice(2).map(source => <SourceExcerpt key={source.id} source={source} />)}</details> : null}
    {!references.length ? <p className="definition-inline-muted">没有保存来源引用。</p> : null}
  </div>;
}

function DecisionDetail({ record, trace }: { record: DecisionRecord; trace: AnalysisRuleTrace }) {
  const issues = record.matchedConditions.filter(condition => condition.passed !== true);
  const passed = record.matchedConditions.filter(condition => condition.passed === true);
  const primaryConditions = [...issues, ...passed.slice(0, 2)];
  const status = record.outcome === "supported" ? "已采用" : record.outcome === "rejected" ? "未采用" : "待核对";
  return (
    <div className={`definition-inline-decision ${record.outcome}`}>
      <div className="definition-inline-decision-heading"><span className="definition-inline-status">{status}</span><b>{record.asin}</b><span className="definition-inline-muted">{record.kind === "fact" ? "现有事实" : "开发建议"}</span></div>
      <div className="definition-inline-decision-title"><InlineReportText text={record.text} lines={2} /></div>
      <p className="definition-inline-reason">{record.summary}</p>
      <div className="definition-inline-evidence-grid">
        <div>
          <h5>判断条件</h5>
          {primaryConditions.length ? <ul className="definition-inline-list">{primaryConditions.map((condition, index) => <li key={index}><span className={condition.passed === true ? "definition-inline-muted" : "definition-inline-warning"}>{conditionLabel(condition.passed)}</span> · {condition.description}</li>)}</ul> : <p className="definition-inline-muted">没有保存逐项条件记录。</p>}
          {record.checks.length ? <div className="definition-inline-checks"><h5>仍需核对</h5><ul className="definition-inline-list">{record.checks.map((check, index) => <li key={index}>{check}</li>)}</ul></div> : null}
        </div>
        <DecisionSources record={record} trace={trace} />
      </div>
      <details className="definition-inline-audit">
        <summary>完整核对记录与规则版本</summary>
        <p className="definition-inline-muted">生成时版本：{record.ruleSetVersion}</p>
        <ul className="definition-inline-list">{record.matchedConditions.map((condition, index) => <li key={index}>{conditionLabel(condition.passed)} · {condition.description}</li>)}</ul>
        {record.ruleIds.map(id => {
          const rule = trace.ruleDefinitions.find(item => item.id === id && item.version === record.ruleVersions[id]);
          return <details className="definition-inline-rule" key={id}><summary>{id} · {rule?.name ?? "未保存对应版本规则定义"}</summary>{rule ? <dl><dt>规则说明</dt><dd>{rule.purpose}</dd><dt>适用条件</dt><dd>{rule.conditions.map(describeRulePredicate).join("；")}</dd><dt>排除条件</dt><dd>{rule.exclusions.join("；")}</dd><dt>资料缺失</dt><dd>{rule.missingPolicy}</dd><dt>来源冲突</dt><dd>{rule.conflictPolicy}</dd><dt>正例</dt><dd>{rule.positiveExample}</dd><dt>反例</dt><dd>{rule.negativeExample}</dd></dl> : <p>历史记录未保存该规则定义，不使用当前版本补写。</p>}</details>;
        })}
      </details>
    </div>
  );
}

export function InlineDecisionContent({ trace, decisionIds }: DecisionProps) {
  if (!trace) return <p className="definition-inline-muted">历史结果未记录规则版本</p>;
  const requested = new Set(decisionIds ?? []);
  const records = trace.decisions.filter(record => requested.has(record.candidateId));
  return records.length ? <div className="definition-inline-decisions">{records.map(record => <DecisionDetail key={record.candidateId} record={record} trace={trace} />)}</div> : <p className="definition-inline-muted">这条结果没有保存判定明细。</p>;
}

export function InlineFeatureDecision(props: DecisionProps) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  function close() {
    if (!details.current) return;
    const aboveViewport = details.current.getBoundingClientRect().top < 0;
    details.current.open = false;
    summary.current?.focus({ preventScroll: true });
    if (aboveViewport) details.current.scrollIntoView({ block: "start" });
  }
  return <details ref={details} className="definition-inline-feature"><summary ref={summary}>判定依据</summary><InlineDecisionContent {...props} /><button type="button" className="definition-inline-link" onClick={close}>收起判定依据 ▴</button></details>;
}

export function InlineDecisionTableRow({ children, colSpan, label, ...props }: DecisionProps & { children: ReactNode; colSpan: number; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const row = useRef<HTMLTableRowElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  function close() {
    const aboveViewport = row.current && row.current.getBoundingClientRect().top < 0;
    setExpanded(false);
    button.current?.focus({ preventScroll: true });
    if (aboveViewport) row.current?.scrollIntoView({ block: "start" });
  }
  return <Fragment>
    <tr ref={row} className={expanded ? "definition-inline-selected-row" : undefined}>{children}<td className="definition-inline-trigger-cell"><button ref={button} type="button" className="definition-inline-link" aria-label={`${expanded ? "收起" : "查看"}${label}的判定依据`} aria-expanded={expanded} aria-controls={expanded ? id : undefined} onClick={() => expanded ? close() : setExpanded(true)}>判定依据 {expanded ? "▴" : "▾"}</button></td></tr>
    {expanded ? <tr className="definition-inline-detail-row"><td colSpan={colSpan}><div id={id} className="definition-inline-panel" role="region" aria-label={`${label}的判定依据`}><div className="definition-inline-panel-heading"><b>{label} · 判定依据</b><button type="button" className="definition-inline-link" onClick={close}>收起 ▴</button></div><InlineDecisionContent {...props} /><button type="button" className="definition-inline-link" onClick={close}>收起判定依据 ▴</button></div></td></tr> : null}
  </Fragment>;
}
