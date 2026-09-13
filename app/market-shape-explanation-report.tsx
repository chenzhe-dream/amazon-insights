'use client';

import type { CSSProperties } from 'react';
import type {
  MarketShapeExplanationPresentation,
  MarketShapeExplanationPresentedStatement,
} from '../shared/market-shape-explanation-presentation';

const dimensionNames = { scope: '分析范围', shape: '形态结构', price: '价格带', brand: '品牌结构', age: '上架年龄', month: '月度变化' };
const kindNames = { observed: '观测', inferred: '推断', risk: '风险与限制', verification: '待验证' };
const decisionNames = {
  'insufficient-evidence': '证据不足，暂不能形成综合结论',
  'exploratory-opportunity': '存在待验证的探索机会',
  'competitive-risk': '存在竞争风险',
  'mixed-signals': '综合信号不一致',
};
const wrapping: CSSProperties = { minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' };

function Statement({ statement }: { statement: MarketShapeExplanationPresentedStatement }) {
  return <div style={wrapping}>
    <p><strong>{kindNames[statement.kind]}：</strong>{statement.text}</p>
    <details>
      <summary>查看来源行与限制（{statement.evidenceRows.length} 行来源，{statement.limitations.length} 项限制）</summary>
      {statement.evidenceRows.length === 0 && <p className="market-research-note">此声明未引用数值行。</p>}
      {statement.evidenceRows.map(row => <div key={row.id} style={wrapping}>
        <p><strong>{dimensionNames[row.dimension]} · {row.path}</strong><br />引用行：{row.id}</p>
        <dl>{Object.entries(row.context).map(([key, value]) => <div key={key}><dt>{key}</dt><dd style={{marginInlineStart:'1rem'}}>{value ?? '未知'}</dd></div>)}</dl>
        <ul>{row.cells.map(cell => <li key={cell.id}>
          {cell.id}：{cell.value === null ? '未知' : String(cell.value)} ({cell.unit})<br />
          <small>来源位置：{cell.path}</small>
        </li>)}</ul>
      </div>)}
      {statement.limitations.length === 0 ? <p className="market-research-note">此声明未单列来源限制；请同时阅读本维度及综合判断的风险与限制。</p> :
        <ul>{statement.limitations.map((limitation, index) => <li key={`${limitation.code}/${index}`}><strong>{limitation.code}：</strong>{limitation.detail}</li>)}</ul>}
    </details>
  </div>;
}

/** Present only saved server text. No requests, computation, or HTML injection. */
export function MarketShapeExplanationReport({ presentation }: { presentation: MarketShapeExplanationPresentation }) {
  return <section className="card market-shape-explanation-report" role="region" aria-label="形态结构解释报告" style={wrapping}>
    <h3>形态结构解释</h3>
    {presentation.dimensions.map(dimension => <section key={dimension.dimension} aria-label={dimensionNames[dimension.dimension]} style={wrapping}>
      <h4>{dimensionNames[dimension.dimension]} · {dimension.status === 'insufficient-evidence' ? '证据不足' : '已有解释'}</h4>
      <Statement statement={dimension.summary} />
      {dimension.findings.map((statement, index) => <Statement key={`finding/${index}`} statement={statement} />)}
      <h5>风险与限制</h5>
      {dimension.limitations.map((statement, index) => <Statement key={`limitation/${index}`} statement={statement} />)}
      <h5>待验证</h5>
      {dimension.verification.map((statement, index) => <Statement key={`verification/${index}`} statement={statement} />)}
    </section>)}
    <section aria-label="综合判断" style={wrapping}>
      <h4>综合判断 · {decisionNames[presentation.synthesis.decision]}</h4>
      <Statement statement={presentation.synthesis.summary} />
      <h5>风险与限制</h5>
      {presentation.synthesis.limitations.map((statement, index) => <Statement key={`limitation/${index}`} statement={statement} />)}
      <h5>待验证</h5>
      {presentation.synthesis.verification.map((statement, index) => <Statement key={`verification/${index}`} statement={statement} />)}
    </section>
  </section>;
}
