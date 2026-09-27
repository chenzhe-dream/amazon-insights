import type {MarketKeywordReconciliationReport} from '../shared/market-keyword-reconciliation-contracts';
import type {MarketKeywordOriginalClassification} from '../shared/market-keyword-original-contracts';

export const keywordDimensions=[['W1','产品','用户在寻找什么产品？'],['W2','人群','谁在使用？'],['W3','场景','在哪里或何时使用？'],['W4','功能属性','需要哪些功能与属性？']] as const;

/** Select saved member labels, without synthesizing a new demand or filling unknown dimensions. */
export function keywordClusterExpression(memberIds:readonly string[],reconciliation?:MarketKeywordReconciliationReport,automatic?:MarketKeywordOriginalClassification){
 const ids=new Set(memberIds);
 if(automatic){
  const rows=automatic.classification.assignments.filter(a=>ids.has(a.keywordId));
  return keywordDimensions.map(([d])=>{const labels=new Set(rows.flatMap(a=>a[d]));return `${d}（${automatic.classification.labels[d].filter(l=>labels.has(l.labelId)).map(l=>l.label).join(' / ')||'未明确'}）`;}).join(' + ');
 }
 const decisions=reconciliation&&['ready','partial'].includes(reconciliation.status)?reconciliation.decisions.filter(d=>ids.has(d.keywordId)):[];
 return keywordDimensions.map(([dimension])=>{
  const candidates=new Set(decisions.flatMap(d=>d[dimension].status==='supported'?d[dimension].candidateIds:[]));
  const labels=reconciliation?.catalog.filter(c=>c.dimension===dimension&&candidates.has(c.candidateId)).map(c=>c.label)??[];
  const incomplete=decisions.length<ids.size||decisions.some(d=>d[dimension].status!=='supported');
  return `${dimension}（${labels.length?labels.join(' / '):'未知'}${labels.length&&incomplete?'；部分原词未知':''}）`;
 }).join(' + ');
}
