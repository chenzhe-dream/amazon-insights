import { EntityIdSchema } from '../../../shared/agent-contracts';
import { mapVocAutomation, VocAutomationRecordSchema, type VocAutomationRecord, type VocAutomationRepository } from '../voc-automation-repository';
import type { PostgresQueryContext } from './query-context';

export class PostgresVocAutomationStore implements VocAutomationRepository {
  constructor(private readonly queries: PostgresQueryContext) {}
  async get(organizationId: string, projectId: string): Promise<VocAutomationRecord | null> {
    const result = await this.queries.query('SELECT * FROM voc_automation_intents WHERE organization_id = $1 AND project_id = $2', [EntityIdSchema.parse(organizationId), EntityIdSchema.parse(projectId)]);
    return result.rows[0] ? mapVocAutomation(result.rows[0]) : null;
  }
  async lock(organizationId: string, projectId: string): Promise<void> {
    const result = await this.queries.query('SELECT id FROM projects WHERE organization_id = $1 AND id = $2 FOR UPDATE', [EntityIdSchema.parse(organizationId), EntityIdSchema.parse(projectId)]);
    if (!result.rowCount) throw new Error('VOC automation project not found');
  }
  async save(record: VocAutomationRecord): Promise<void> {
    const r = VocAutomationRecordSchema.parse(record);
    const result = await this.queries.query(`INSERT INTO voc_automation_intents
      (organization_id, project_id, actor_id, base_sync_run_id, selected_asins_json, retry_key, fingerprint, run_id, updated_at)
      SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9
      WHERE EXISTS (SELECT 1 FROM projects p JOIN users u ON u.id = $3 AND u.organization_id = p.organization_id
        JOIN analysis_runs b ON b.id = $4 AND b.project_id = p.id
        WHERE p.id = $2 AND p.organization_id = $1 AND p.asins_json @> $5::jsonb
        AND ($8::text IS NULL OR EXISTS (SELECT 1 FROM analysis_runs r WHERE r.id = $8 AND r.project_id = p.id)))
      ON CONFLICT (organization_id, project_id) DO UPDATE SET actor_id=excluded.actor_id,
        base_sync_run_id=excluded.base_sync_run_id, selected_asins_json=excluded.selected_asins_json,
        retry_key=excluded.retry_key, fingerprint=excluded.fingerprint, run_id=excluded.run_id, updated_at=excluded.updated_at`,
      [r.organizationId, r.projectId, r.actorId, r.baseSyncRunId, JSON.stringify(r.selectedAsins), r.retryKey, r.fingerprint, r.runId, r.updatedAt]);
    if (result.rowCount !== 1) throw new Error('VOC automation scope mismatch');
  }
  async list(): Promise<VocAutomationRecord[]> {
    return (await this.queries.query('SELECT * FROM voc_automation_intents ORDER BY organization_id, project_id')).rows.map(mapVocAutomation);
  }
}
