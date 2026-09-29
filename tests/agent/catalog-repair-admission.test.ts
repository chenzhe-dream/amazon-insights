import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncJobService } from '../../server/services/sync-job-service';
import type { SyncJobRepository, SyncJobRecord } from '../../server/db/sync-job-repository';
import type { AsinModuleStatus } from '../../app/lib/sync-server';

test('repair includes incomplete primary catalog even when fallback is available', async () => {
  const asins = ['B0FGJNBNYD', 'B0DQDD5SY5'];
  const admissions: Parameters<SyncJobRepository['admit']>[0][] = [];
  const parent = {jobId:'parent',organizationId:'org',projectId:'project',runId:'old-run',marketplace:'US',asins,status:'failed',stages:[],asinProgress:{}} as unknown as SyncJobRecord;
  const repository = {
    findById: async () => parent,
    admit: async (data: Parameters<SyncJobRepository['admit']>[0]) => {
      admissions.push(data);
      return {disposition:'created',job:{...data,status:'queued',updatedAt:data.createdAt,asinProgress:{}}};
    },
  } as unknown as SyncJobRepository;
  const statuses: AsinModuleStatus[] = asins.map(asin => ({asin,inCatalog:true,keywords:'ready',reviews:'ready',sales:'ready',childSales:'ready',priceStrategy:'ready',fba:'ready',listing:'ready',imageRemarks:'ready',category:'ready',traffic:'ready',voc:'ready'}));
  const service = new SyncJobService(repository, {
    findXydcRepairAsins: async () => [], bypassProviderReadiness:true,
    loadStatusModule:async()=>({
      getAsinDataStatus:()=>statuses,
      asinsNeedingCatalogSync:(_asins,options)=>options?.retryFallback?[asins[0]]:[],
      asinsNeedingMcpSync:()=>[],asinsNeedingListingSync:()=>[],asinsNeedingTrafficSync:()=>[],asinsNeedingImageRemarksSync:()=>[],
      countPendingImageRemarks:()=>0,estimateAutoSyncSeconds:()=>10,estimateAlexaVocSeconds:()=>0,
    }),
  });
  await service.start({organizationId:'org',projectId:'project',actorId:'actor',marketplace:'US',asins,mode:'repair-incomplete',parentJobId:'parent'});
  assert.equal(admissions.length,1);
  assert.deepEqual(admissions[0].stages.find(stage=>stage.id==='catalog')?.repairAsins,[asins[0]]);
  assert.ok(admissions[0].stages.filter(stage=>stage.repairAsins && stage.id!=='catalog').every(stage=>stage.repairAsins?.length===0));
});
