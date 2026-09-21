'use client';

import type { MarketShapeExplanationPresentation } from '../shared/market-shape-explanation-presentation';
import { LaunchSection } from './launch-section';

type Dimension = MarketShapeExplanationPresentation['dimensions'][number]['dimension'];

/** Select saved prose only. This presentation adapter never scores or classifies products. */
export function MarketShapeSavedConclusion({ title, dimension, presentation }: {
  title: string;
  dimension: Dimension;
  presentation?: MarketShapeExplanationPresentation | null;
}) {
  const section = presentation?.dimensions.find(item => item.dimension === dimension);
  return <div className="listing-age-conclusion listing-age-entry-gray market-shape-saved-conclusion">
    <div className="listing-age-conclusion-head">
      <div><p className="listing-age-conclusion-eyebrow">已保存的结构解释</p><h4 className="listing-age-conclusion-title">{title}</h4></div>
      <span className="source-badge">{section ? section.status === 'explained' ? '已有解释' : '证据不足' : '待生成解释'}</span>
    </div>
    <p>{section?.summary.text ?? '此版本尚无可展示的保存解释；统计结果保留，不能据此推断进入机会。'}</p>
    <p className="market-research-note">结论口径：保存版本全部所选商品；表格筛选不重新分析。</p>
    {section && <>
      <ul>{section.findings.map((item, index) => <li key={index}><strong>{item.kind === 'observed' ? '观测' : '推断'}：</strong>{item.text}</li>)}</ul>
      <div className="market-structure-synthesis-extra-split">
        <div><h5>风险与限制</h5><ul>{section.limitations.map((item, index) => <li key={index}>{item.text}</li>)}</ul></div>
        <div><h5>待验证</h5><ul>{section.verification.map((item, index) => <li key={index}>{item.text}</li>)}</ul></div>
      </div>
      <p className="market-research-note">来源行与数值口径见下方「形态结构解释」中的同维度证据。</p>
    </>}
  </div>;
}

const dimensions = { scope: '样本范围', shape: '商品形态', price: '价格带结构', brand: '品牌竞争', age: '上架年龄', month: '月度变化' };
const decisions = { 'insufficient-evidence': '证据不足，暂不能形成综合结论', 'exploratory-opportunity': '存在待验证的探索机会', 'competitive-risk': '存在竞争风险', 'mixed-signals': '综合信号不一致' };

export function MarketShapeFinalConclusion({ presentation, sampleSize }: {
  presentation?: MarketShapeExplanationPresentation | null;
  sampleSize: number;
}) {
  return <LaunchSection title="类目商品链接调研 · 最终结论" description="综合商品形态、价格带、品牌、上架年龄与月度变化；依据本版本保存的结构解释。" badge={<span className="source-badge">{sampleSize} 个所选链接 · 非最终立项决策</span>}>
    <div className="listing-age-conclusion listing-age-entry-gray market-structure-synthesis">
      <div className="market-structure-synthesis-top">
        <div className="market-structure-synthesis-verdict-card"><p className="listing-age-conclusion-eyebrow">结构综合判断</p><h4 className="listing-age-conclusion-title">{presentation ? decisions[presentation.synthesis.decision] : '等待本版本的保存解释'}</h4><p className="market-structure-synthesis-def">{presentation?.synthesis.summary.text ?? '当前统计结果可供比较；解释尚未生成，不能推断市场机会。'}</p></div>
        <div className="market-structure-synthesis-meta-grid">
          <div><span>样本链接</span><b>{sampleSize}</b></div><div><span>原版综合评分</span><b>未提供</b></div><div><span>可进入毛利链接</span><b>未知</b></div><div><span>Top3 Listing</span><b>未知</b></div>
        </div>
      </div>
      <div className="market-structure-dimension-grid">{(Object.keys(dimensions) as Dimension[]).map(key => {
        const dimension = presentation?.dimensions.find(item => item.dimension === key);
        return <article className="market-structure-dimension-card" key={key}><header className="market-structure-dimension-head"><h5>{dimensions[key]}</h5><span className="source-badge">{dimension ? dimension.status === 'explained' ? '已有解释' : '证据不足' : '暂无解释'}</span></header><p>{dimension?.summary.text ?? '此版本未提供该维度的保存解释。'}</p></article>;
      })}</div>
      <div className="market-structure-synthesis-extra"><p className="market-structure-synthesis-extra-title">机会与风险</p><div className="market-structure-synthesis-extra-body market-structure-synthesis-extra-split">
        <div><h5>待验证方向</h5>{presentation ? <ul>{presentation.synthesis.verification.map((item, index) => <li key={index}>{item.text}</li>)}</ul> : <p>等待保存的验证建议。</p>}</div>
        <div><h5>主要风险</h5>{presentation ? <ul>{presentation.synthesis.limitations.map((item, index) => <li key={index}>{item.text}</li>)}</ul> : <p>解释未生成；当前数据不足以作进入判断。</p>}</div>
      </div></div>
      <p className="market-research-note">当前版本未提供原版毛利准入分析、综合评分和可信 TOP3 样本占比，以上字段保持未知；不从价格或销量推算。</p>
    </div>
  </LaunchSection>;
}
