import {z} from 'zod';
import type {MarketStepDefinition} from '../../db/market-module-execution-repository';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
const inputId=z.string().regex(/^market-input:[a-f0-9]{64}$/),id=z.string().min(1).max(160);
export const MarketOverviewWindowsStepInputSchema=z.object({phase:z.literal('overview-semantic-windows'),catalogAttemptId:z.string().uuid()}).strict();
export const MarketOverviewWindowPlanSchema=z.object({schemaVersion:z.literal('overview-window-plan/v1'),catalogAttemptId:z.string().uuid(),basisSnapshotId:inputId,
  numericInputSnapshotId:inputId,configurationVersion:z.string().min(1).max(240),dataCutoffAt:z.string().datetime(),selectionRevision:id,
  windows:z.array(z.object({inputSnapshotId:inputId,primaryFactIds:z.array(id).max(2000),gapIds:z.array(id).max(2000)}).strict()).max(2000),
  rejected:z.array(z.object({kind:z.enum(['fact','gap']),id,reason:z.literal('request-too-large')}).strict()).max(2000)}).strict();
export type MarketOverviewWindowPlan=z.infer<typeof MarketOverviewWindowPlanSchema>;
export function marketOverviewWindowPreparations(plan:MarketOverviewWindowPlan):MarketStepDefinition[]{
  return plan.windows.map(w=>({stepKey:`overview-prepare/${digest({catalogAttemptId:plan.catalogAttemptId,snapshotId:w.inputSnapshotId})}`,kind:'prepare-model-batches',subject:{task:'market-overview-explanation'},
    input:{task:'market-overview-explanation',inputSnapshotId:w.inputSnapshotId,selectionRevision:plan.selectionRevision,dataCutoffAt:plan.dataCutoffAt},inputRefs:[{kind:'input',id:w.inputSnapshotId}]}));
}
