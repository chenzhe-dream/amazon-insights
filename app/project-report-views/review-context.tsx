import type { ReviewContext } from '../../shared/review-context';
import type { SellerSpriteReviewAnalysisRecord } from '../seller-sprite-review-analysis';
import { describeReviewCoverage } from '../lib/review-context-display';
import './review-context.css';

const countryNames = {US:'美国',UK:'英国',DE:'德国',CA:'加拿大'};
export function ReviewContextSection({asins,records,contexts,missingMessages}: {
  asins: readonly string[];
  records: Record<string,SellerSpriteReviewAnalysisRecord>;
  contexts: Record<string,ReviewContext>;
  missingMessages: Record<string,string>;
}) {
  if (!asins.length) return null;
  return <>
    <section className="card review-context-card" aria-label="评论覆盖与缺失原因">
      <div className="section-head"><div><h3>评论覆盖与缺失原因</h3><p>接口结果、商品页核查分别列示；保留历史样本，未核实项继续待补。</p></div></div>
      <div className="matrix-wrap"><table className="compare-matrix review-context-table"><thead><tr><th>ASIN</th><th>本地数据状态</th><th>商品页与链接核查</th><th>补充方式</th></tr></thead><tbody>
        {asins.map(asin=>{
          const context=contexts[asin], record=records[asin], coverage=describeReviewCoverage(record,context,missingMessages[asin]);
          return <tr key={asin}><th>{asin}</th><td>{coverage.reason}<small>接口采集：{record?.fetchedAt || '尚无可核验记录'}</small></td><td>{coverage.pageNote}{context && <><small><a href={context.page.url} target="_blank" rel="noreferrer">核查原商品页 ↗</a> · {context.page.checkedAt}</small><small>页面证据：{context.page.evidence}</small>{context.page.lookupNote && <small>{context.page.lookupNote}</small>}</>}</td><td>{coverage.next}</td></tr>;
        })}
      </tbody></table></div>
    </section>
    {asins.some(asin=>contexts[asin]?.internationalReferences.length) && <section className="card review-context-card" aria-label="国际评论独立参考">
      <div className="section-head"><div><h3>国际评论独立参考</h3><p>来自商品页“其他国家评论”区域，仅为当前页面可见样本，不是全量评论。不计入本地样本、占比、覆盖率、VOC 综合总结或新品定义。</p></div><span className="source-badge">Amazon 商品页原文</span></div>
      <p className="review-reference-notice">商品关系：同一 ASIN 商品页展示的国际评论；评论对应的具体变体尚未核实。全球评分数与评论正文数不能互换。</p>
      <div className="review-reference-grid">{asins.map(asin=>{
        const context=contexts[asin]; if(!context?.internationalReferences.length)return null;
        const refs=context.internationalReferences;
        const countries=[...new Set(refs.map(r=>countryNames[r.sourceCountry]))].join('、');
        return <details key={asin} className="review-reference-product"><summary><b>{asin}</b> · {countries}参考 {refs.length} 条 · 本地样本 {records[asin]?.sampledReviews ?? '未知'} 条</summary><p>来源市场：{countries} · 展示站点：{countryNames[context.marketplace]} · 核查时间：{context.page.checkedAt}</p>
          {refs.map(ref=><article key={ref.reviewId}><h4>{ref.title}</h4><p>{countryNames[ref.sourceCountry]} · {ref.reviewedAt}{ref.rating ? ` · ${ref.rating} 星` : ''} · ID：{ref.reviewId}</p><small>{ref.countryDateText}</small>{ref.variationText && <small>页面购买/规格标记：{ref.variationText}</small>}<blockquote>{ref.body}</blockquote><a href={`${ref.sourceUrl}#${ref.reviewId}`} target="_blank" rel="noreferrer">查看来源商品页 ↗</a></article>)}
        </details>;
      })}</div>
    </section>}
  </>;
}
