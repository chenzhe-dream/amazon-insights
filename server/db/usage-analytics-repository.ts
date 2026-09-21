import type {UsageAck,UsageBatch,UsagePerson,UsageQuery,UsageReport,UsageScope} from "../../shared/usage-analytics-contracts";
export interface UsageAnalyticsRepository{
  ingest(scope:UsageScope,batch:UsageBatch,receivedAt:string):Promise<UsageAck|null>;
  searchPeople(organizationId:string,q:string,limit:number):Promise<{people:UsagePerson[];hasMore:boolean}>;
  report(organizationId:string,query:UsageQuery,asOf:string):Promise<UsageReport>;
}
