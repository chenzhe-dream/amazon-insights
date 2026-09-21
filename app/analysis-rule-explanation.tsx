import type { ReactNode } from "react";

import {
  RULE_DEFINITIONS,
  RULE_SET_VERSION,
  describeRulePredicate,
  type AnalysisRuleTrace,
  type DecisionRecord,
  type RuleDefinition,
} from "../shared/product-structure-rules";

const styles = new Proxy({} as Record<string, string>, {
  get: (_target, key) => `analysis-rule-${String(key)}`,
});

const criticalStyles = `
.analysis-rule-shell{overflow:hidden}.analysis-rule-overview>summary,.analysis-rule-rowDetails>summary{cursor:pointer;list-style:none}.analysis-rule-overview>summary{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.15rem;font-weight:750}.analysis-rule-overview>summary small{margin-left:auto;color:#64748b}.analysis-rule-body{border-top:1px solid #e2e8f0;padding:1.15rem}.analysis-rule-flow,.analysis-rule-ruleGrid,.analysis-rule-decisionList{display:grid;gap:.7rem}.analysis-rule-flow{grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));padding:0;list-style:none}.analysis-rule-flow li,.analysis-rule-ruleCard,.analysis-rule-decision{border:1px solid #e2e8f0;border-radius:.7rem;padding:.75rem}.analysis-rule-ruleGrid{grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr));margin-top:1rem}.analysis-rule-ruleHeading,.analysis-rule-decision header,.analysis-rule-decisionMeta,.analysis-rule-ruleTags{display:flex;gap:.55rem;flex-wrap:wrap}.analysis-rule-ruleFacts div{display:grid;grid-template-columns:5.4rem minmax(0,1fr);gap:.5rem;font-size:.78rem}.analysis-rule-ruleFacts dd{margin:0;overflow-wrap:anywhere}.analysis-rule-versionNotice{border-left:3px solid #0f766e;background:#f0fdfa;padding:.7rem}.analysis-rule-rejected{border-left:4px solid #dc2626;background:#fffafa}.analysis-rule-supported{border-left:4px solid #16a34a}.analysis-rule-needs_check{border-left:4px solid #d97706}.analysis-rule-rowDetails>summary{color:#0f766e;font-size:.78rem;font-weight:750;text-decoration:underline}.analysis-rule-rowDetailBody{min-width:min(32rem,75vw);margin-top:.45rem}.analysis-rule-muted,.analysis-rule-empty,.analysis-rule-rowUnavailable{color:#64748b}.analysis-rule-unavailable{color:#b45309}@media(max-width:640px){.analysis-rule-overview>summary{align-items:flex-start;flex-wrap:wrap}.analysis-rule-body{padding:.85rem}.analysis-rule-ruleFacts div{grid-template-columns:1fr}.analysis-rule-rowDetails{min-width:0}.analysis-rule-rowDetailBody{min-width:0;width:100%}}
`;

type RuleDecisionExplanationProps = {
  trace?: AnalysisRuleTrace;
  decisionIds?: string[];
  emptyLabel?: string;
};

type AnalysisRuleExplanationProps = {
  trace?: AnalysisRuleTrace;
  resultAvailable?: boolean;
  decisionIds?: string[];
  title?: string;
};

const FLOW_STEPS = [
  ["01", "限定项目、站点与 ASIN 范围"],
  ["02", "保留名称与别名，不从名称直接推导硬件"],
  ["03A", "逐个产品记录用途、形态、结构与来源"],
  ["03B", "提取人群、场景、痛点与期待效果"],
  ["04", "结合产品信息与需求生成候选输出"],
  ["05A / 05B", "分别核验现有事实与开发建议"],
  ["06 / 07", "按相容形态汇总并输出事实、建议、待核对"],
] as const;

function resultLabel(outcome: DecisionRecord["outcome"]) {
  if (outcome === "supported") return "已采用";
  if (outcome === "rejected") return "未采用";
  return "待核对";
}

function conditionLabel(passed: boolean | null) {
  if (passed === true) return "满足";
  if (passed === false) return "不满足";
  return "未知";
}

function RuleCard({ rule }: { rule: RuleDefinition }) {
  return (
    <article className={styles.ruleCard} data-rule-id={rule.id}>
      <div className={styles.ruleHeading}>
        <span className={styles.ruleId}>{rule.id}</span>
        <div>
          <h4>{rule.name}</h4>
          <small>节点 {rule.flowNode} · v{rule.version}</small>
        </div>
      </div>
      <p>{rule.purpose}</p>
      <dl className={styles.ruleFacts}>
        <div>
          <dt>适用条件</dt>
          <dd>{rule.conditions.length ? rule.conditions.map(describeRulePredicate).join("；") : "无额外条件"}</dd>
        </div>
        <div>
          <dt>不适用 / 排除</dt>
          <dd>{rule.exclusions.length ? rule.exclusions.join("；") : "无额外排除条件"}</dd>
        </div>
        <div>
          <dt>资料缺失</dt>
          <dd>{rule.missingPolicy}</dd>
        </div>
        <div>
          <dt>来源冲突</dt>
          <dd>{rule.conflictPolicy}</dd>
        </div>
        <div>
          <dt>正例</dt>
          <dd>{rule.positiveExample}</dd>
        </div>
        <div>
          <dt>反例</dt>
          <dd>{rule.negativeExample}</dd>
        </div>
      </dl>
    </article>
  );
}

function EvidenceList({ decision, trace }: { decision: DecisionRecord; trace: AnalysisRuleTrace }) {
  if (!decision.evidenceRefs.length) return <p className={styles.muted}>该判断没有可展示的来源引用。</p>;
  const sources = new Map(trace.sources.map(source => [source.id, source]));
  return (
    <ul className={styles.evidenceList}>
      {decision.evidenceRefs.map(ref => {
        const source = sources.get(ref);
        return source ? (
          <li key={ref}>
            <span>{source.kind === "keyword" ? "关键词" : source.kind === "voc" ? "VOC" : "产品信息"}</span>
            <b>{source.asin ?? "项目级"}</b>
            <q>{source.text}</q>
          </li>
        ) : (
          <li key={ref} className={styles.unavailable}>
            来源不可用（{ref}）
          </li>
        );
      })}
    </ul>
  );
}

function DecisionDetail({ decision, trace }: { decision: DecisionRecord; trace: AnalysisRuleTrace }) {
  return (
    <article className={`${styles.decision} ${styles[decision.outcome]}`}>
      <header>
        <span>{resultLabel(decision.outcome)}</span>
        <strong>{decision.text}</strong>
      </header>
      <p>{decision.summary}</p>
      <div className={styles.decisionMeta}>
        <span>类型：{decision.kind === "fact" ? "现有事实" : "开发建议"}</span>
        <span>ASIN：{decision.asin ?? "项目级"}</span>
        <span>结果规则版本：{decision.ruleSetVersion}</span>
      </div>
      <div className={styles.ruleTags}>
        {decision.ruleIds.map(id => <span key={id}>{id} v{decision.ruleVersions[id] ?? "—"}</span>)}
      </div>
      <h5>条件核对</h5>
      {decision.matchedConditions.length ? (
        <ul className={styles.conditionList}>
          {decision.matchedConditions.map((condition, index) => (
            <li key={`${condition.description}-${index}`}>
              <span className={styles[`condition${condition.passed === true ? "Pass" : condition.passed === false ? "Fail" : "Unknown"}`]}>
                {conditionLabel(condition.passed)}
              </span>
              {condition.description}
            </li>
          ))}
        </ul>
      ) : <p className={styles.muted}>没有保存逐项条件记录。</p>}
      <h5>来源</h5>
      <EvidenceList decision={decision} trace={trace} />
      {decision.checks.length ? (
        <>
          <h5>待核对</h5>
          <ul className={styles.checkList}>{decision.checks.map(check => <li key={check}>{check}</li>)}</ul>
        </>
      ) : null}
    </article>
  );
}

function DecisionGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.decisionGroup}><h4>{title}</h4>{children}</section>;
}

export function RuleDecisionExplanation({ trace, decisionIds, emptyLabel = "这条结果没有保存判定明细。" }: RuleDecisionExplanationProps) {
  if (!trace) return <span className={styles.rowUnavailable}>历史结果未记录规则版本</span>;
  const requested = new Set(decisionIds ?? []);
  const decisions = trace.decisions.filter(item => requested.has(item.candidateId));
  return (
    <details className={styles.rowDetails}>
      <summary>为什么这样判断</summary>
      <div className={styles.rowDetailBody}>
        {decisions.length
          ? decisions.map(decision => <DecisionDetail key={decision.candidateId} decision={decision} trace={trace} />)
          : <p className={styles.muted}>{emptyLabel}</p>}
      </div>
    </details>
  );
}

export function AnalysisRuleExplanation({ trace, resultAvailable = false, decisionIds, title = "分析规则说明" }: AnalysisRuleExplanationProps) {
  const definitions = RULE_DEFINITIONS;
  const selected = decisionIds?.length ? new Set(decisionIds) : null;
  const decisions = trace?.decisions.filter(item => !selected || selected.has(item.candidateId)) ?? [];
  const accepted = decisions.filter(item => item.outcome !== "rejected");
  const rejected = decisions.filter(item => item.outcome === "rejected");

  return (
    <section className={`card launch-block ${styles.shell}`} aria-label={title}>
      <style>{criticalStyles}</style>
      <details className={styles.overview}>
        <summary>
          <span>{title}</span>
          <small>当前规则版本 {RULE_SET_VERSION} · 只读</small>
        </summary>
        <div className={styles.body}>
          <p className={styles.lead}>规则用于区分产品事实、开发建议和待核对事项。名称、人群词或单个 ASIN 的结构不会直接传播为整组硬件结论。</p>
          <ol className={styles.flow} aria-label="跨类目分析流程">
            {FLOW_STEPS.map(([node, label]) => <li key={node}><b>{node}</b><span>{label}</span></li>)}
          </ol>
          <div className={styles.versionNotice}>
            {trace ? (
              <>结果采用版本 <b>{trace.ruleSetVersion}</b>；下方结果说明使用生成时保存的定义。</>
            ) : resultAvailable ? (
              <>历史结果未记录规则版本，不会用当前规则冒充当时的执行依据。重新分析后才会生成判定记录。</>
            ) : (
              <>当前还没有分析结果。规则说明仍可查阅，结果生成后会在这里显示实际版本与判定依据。</>
            )}
          </div>
          <h3>当前规则目录（R01–R12）</h3>
          <div className={styles.ruleGrid}>{definitions.map(rule => <RuleCard key={`${rule.id}-${rule.version}`} rule={rule} />)}</div>
          {trace ? (
            <div className={styles.resultDetails}>
              <h3>本次结果的判断依据</h3>
              {trace.ruleDefinitions.length ? (
                <details>
                  <summary>本次结果采用的规则定义快照（{trace.ruleDefinitions.map(rule => rule.id).join("、")}）</summary>
                  <div className={styles.ruleGrid}>{trace.ruleDefinitions.map(rule => <RuleCard key={`saved-${rule.id}-${rule.version}`} rule={rule} />)}</div>
                </details>
              ) : null}
              {!decisions.length ? <p className={styles.empty}>本次结果没有可展示的结构规则判定。</p> : null}
              {accepted.length ? <DecisionGroup title="已采用与待核对"><div className={styles.decisionList}>{accepted.map(item => <DecisionDetail key={item.candidateId} decision={item} trace={trace} />)}</div></DecisionGroup> : null}
              {rejected.length ? <DecisionGroup title="未采用的建议"><p className={styles.muted}>以下候选被规则拦截，不会混入正式产品动作。</p><div className={styles.decisionList}>{rejected.map(item => <DecisionDetail key={item.candidateId} decision={item} trace={trace} />)}</div></DecisionGroup> : null}
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}
