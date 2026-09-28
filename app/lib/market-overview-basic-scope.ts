import type {MarketResearchJob,MarketResearchScope} from '../../shared/market-research-contracts';

export type OverviewBasicContext={status:'idle'|'loading'|'failed'}|{status:'ready';runId:string;scope:MarketResearchScope};

export function matchesOverviewBasicScope(job:MarketResearchJob,scope:MarketResearchScope){
  const path=job.report?.nodeIdPath??job.scope.nodeQuery,query=scope.nodeQuery;
  const sameNode=path===query||(!path.includes(':')||!query.includes(':'))&&path.split(':').at(-1)===query.split(':').at(-1);
  return sameNode&&job.scope.marketplace===scope.marketplace&&job.scope.month===scope.month&&job.scope.headTopN===scope.headTopN&&job.scope.newProductMonths===scope.newProductMonths;
}
