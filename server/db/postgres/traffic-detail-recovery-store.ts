import { z } from 'zod';
import { TrafficListingCollectionSchema } from '../../../shared/traffic-listing-contract';
import { EntityIdSchema, DateTimeSchema } from '../../../shared/agent-contracts';
import type { TrafficDetailRecoveryRecord, TrafficDetailRecoveryRepository } from '../traffic-detail-recovery-repository';
import { canonicalJsonSha256 } from '../../runtime/model-request-accounting';
import { PostgresQueryContext } from './query-context';
import { requireSnapshotSubject, validateSnapshotSubjectInput } from './snapshot-subject';

const EvidenceSchema = z.array(z.strictObject({ asin: z.string().regex(/^[A-Z0-9]{10}$/), operation: z.enum(['ops_get_listing_traffic_overview','ops_get_listing_traffic_structure']), fetchedAt: z.iso.datetime(), attemptCount: z.number().int().min(1).max(2), checksum: z.string().regex(/^[a-f0-9]{64}$/) })).min(2).max(20);
function map(row: any): TrafficDetailRecoveryRecord | null {
  if (!row) return null;
  const collection = TrafficListingCollectionSchema.parse(row.collection_json);
  const requests = EvidenceSchema.parse(row.requests_json);
  if (collection.id !== row.id || canonicalJsonSha256({ collection, requests, baseSnapshotId: row.base_snapshot_id }) !== row.content_hash) throw new Error('Traffic recovery integrity failure');
  return { collection, requests, baseSnapshotId: row.base_snapshot_id, revision: row.revision };
}
export class PostgresTrafficDetailRecoveryStore implements TrafficDetailRecoveryRepository {
  constructor(private readonly queries: PostgresQueryContext) {}
  async append(input: Parameters<TrafficDetailRecoveryRepository['append']>[0]): Promise<TrafficDetailRecoveryRecord> {
    const scope = validateSnapshotSubjectInput(input), collection = TrafficListingCollectionSchema.parse(input.collection), requests = EvidenceSchema.parse(input.requests);
    const baseSnapshotId = EntityIdSchema.parse(input.baseSnapshotId), deadline = DateTimeSchema.parse(input.deadlineAt);
    if (collection.marketplace !== scope.expectedMarketplace || collection.asins.join(',') !== scope.expectedAsins.join(',') || requests.length !== collection.asins.length * 2 || collection.collectedAt !== requests.map(item => item.fetchedAt).sort().at(-1)) throw new Error('Traffic recovery scope mismatch');
    for (const asin of collection.asins) for (const operation of ['ops_get_listing_traffic_overview','ops_get_listing_traffic_structure']) if (requests.filter(item => item.asin === asin && item.operation === operation).length !== 1) throw new Error('Traffic recovery evidence mismatch');
    const hash = canonicalJsonSha256({ collection, requests, baseSnapshotId });
    return this.queries.transaction(async () => {
      const remaining = Math.max(1, Math.min(5000, Date.parse(deadline) - Date.now()));
      await this.queries.query(`SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$2,true)`, [String(remaining),String(Math.min(2000,remaining))]);
      await requireSnapshotSubject(this.queries, scope);
      const base = await this.queries.query('SELECT id FROM data_snapshots WHERE id=$1 AND run_id=$2 AND artifact_kind=\'traffic\' AND marketplace=$3 AND asins_json=$4::jsonb', [baseSnapshotId, scope.runId, scope.expectedMarketplace, JSON.stringify(scope.expectedAsins)]);
      if (!base.rowCount) throw new Error('Traffic recovery base snapshot mismatch');
      const prior = await this.queries.query('SELECT * FROM traffic_detail_recoveries WHERE id=$1', [collection.id]);
      if (prior.rows[0]) {
        if (prior.rows[0].run_id !== scope.runId || prior.rows[0].organization_id !== scope.actorOrganizationId || prior.rows[0].content_hash !== hash) throw new Error('Traffic recovery replay conflict');
        return map(prior.rows[0])!;
      }
      const result = await this.queries.query(`INSERT INTO traffic_detail_recoveries
        (id,organization_id,project_id,run_id,base_snapshot_id,created_by,revision,marketplace,asins_json,collection_json,requests_json,content_hash,collected_at)
        SELECT $1,$2,$3,$4,$5,$6,COALESCE((SELECT MAX(revision) FROM traffic_detail_recoveries WHERE run_id=$4),0)+1,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12
        WHERE clock_timestamp() < $13::timestamptz RETURNING *`, [collection.id, scope.actorOrganizationId, scope.expectedProjectId, scope.runId, baseSnapshotId, scope.actorId, collection.marketplace, JSON.stringify(collection.asins), JSON.stringify(collection), JSON.stringify(requests), hash, collection.collectedAt, deadline]);
      if (!result.rows[0]) throw new Error('Traffic recovery deadline expired');
      return map(result.rows[0])!;
    });
  }
  async findById(input: Parameters<TrafficDetailRecoveryRepository['findById']>[0]) {
    const result = await this.queries.query(`SELECT recovery.* FROM traffic_detail_recoveries recovery
      JOIN analysis_runs run ON run.id=recovery.run_id JOIN projects project ON project.id=run.project_id
      WHERE recovery.organization_id=$1 AND project.organization_id=$1 AND recovery.run_id=$2 AND recovery.id=$3 AND recovery.project_id=project.id AND recovery.asins_json=project.asins_json AND recovery.marketplace=project.marketplace`, [EntityIdSchema.parse(input.organizationId),EntityIdSchema.parse(input.runId),z.uuid().parse(input.id)]);
    return map(result.rows[0]);
  }
  async latest(input: Parameters<TrafficDetailRecoveryRepository['latest']>[0]) {
    const result = await this.queries.query(`SELECT recovery.* FROM traffic_detail_recoveries recovery
      JOIN analysis_runs run ON run.id=recovery.run_id JOIN projects project ON project.id=run.project_id
      WHERE recovery.organization_id=$1 AND project.organization_id=$1 AND recovery.project_id=$2 AND project.id=$2 AND recovery.run_id=$3
      AND recovery.marketplace=$4 AND recovery.asins_json=$5::jsonb AND recovery.asins_json=project.asins_json AND recovery.marketplace=project.marketplace
      ORDER BY recovery.collected_at DESC, recovery.revision DESC LIMIT 1`, [EntityIdSchema.parse(input.organizationId),EntityIdSchema.parse(input.projectId),EntityIdSchema.parse(input.runId),input.marketplace,JSON.stringify(input.asins)]);
    return map(result.rows[0]);
  }
}
