'use client';
import type { MarketShapePublicRevision } from '../shared/market-shape-public-contracts';
export function MarketShapeSourcePolicyNote({ report }: {
    report: MarketShapePublicRevision;
}) {
    if (!report.sourcePolicy)
        return null;
    const scopeBound = report.products.filter(p => p.provenance?.scopeBasis === 'request-bound').length, scopeEcho = report.products.filter(p => p.provenance?.scopeBasis === 'response-verified').length, currencyContract = report.products.filter(p => p.provenance?.currencyBasis === 'provider-contract').length, currencyEcho = report.products.filter(p => p.provenance?.currencyBasis === 'response-echo').length, periodBound = report.products.flatMap(p => p.observations).filter(o => o.provenance?.periodBasis === 'request-bound').length;
    return <aside role="note" aria-label="商品数据依据" className="market-research-note market-shape-source-policy">
    <strong>商品数据依据</strong>
    <p>范围：{scopeBound} 个商品按请求范围绑定，{scopeEcho} 个有响应范围回显。按所选类目取得的样本，不代表全市场。</p>
    <p>月份：{periodBound} 条商品月份数据按查询参数取得；查询月份依据与响应回显分别保留，不把缺失月份补成0。</p>
    <p>币种：{currencyContract} 个商品按供应商站点定义使用 {report.scope.currency}，{currencyEcho} 个有币种回显。价格仍是来源观测参考价，不是已核验的历史成交价。</p>
    <a href={report.sourcePolicy.scopeDocumentation} target="_blank" rel="noreferrer">查看供应商查询月份与站点定义</a>
  </aside>;
}
