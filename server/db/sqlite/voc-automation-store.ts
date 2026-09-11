import type { DatabaseSync } from 'node:sqlite';
import { EntityIdSchema } from '../../../shared/agent-contracts';
import { mapVocAutomation, VocAutomationRecordSchema, type VocAutomationRecord, type VocAutomationRepository } from '../voc-automation-repository';

export class SqliteVocAutomationStore implements VocAutomationRepository {
  constructor(private readonly options: {
    database: DatabaseSync;
    serialize: <T>(operation: () => T) => Promise<T>;
    requireTransaction: () => void;
  }) {}

  get(organizationId: string, projectId: string): Promise<VocAutomationRecord | null> {
    return this.options.serialize(() => {
      const row = this.options.database.prepare('SELECT * FROM voc_automation_intents WHERE organization_id = ? AND project_id = ?').get(EntityIdSchema.parse(organizationId), EntityIdSchema.parse(projectId));
      return row ? mapVocAutomation(row) : null;
    });
  }
  lock(organizationId: string, projectId: string): Promise<void> {
    return this.options.serialize(() => {
      this.options.requireTransaction();
      if (!this.options.database.prepare('SELECT id FROM projects WHERE organization_id = ? AND id = ?').get(EntityIdSchema.parse(organizationId), EntityIdSchema.parse(projectId))) throw new Error('VOC automation project not found');
    });
  }
  save(record: VocAutomationRecord): Promise<void> {
    return this.options.serialize(() => {
      const r = VocAutomationRecordSchema.parse(record);
      const result = this.options.database.prepare(`INSERT INTO voc_automation_intents
        (organization_id, project_id, actor_id, base_sync_run_id, selected_asins_json, retry_key, fingerprint, run_id, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM projects p JOIN users u ON u.id = ? AND u.organization_id = p.organization_id
          JOIN analysis_runs b ON b.id = ? AND b.project_id = p.id
          WHERE p.id = ? AND p.organization_id = ?
          AND NOT EXISTS (SELECT 1 FROM json_each(?) s WHERE s.value NOT IN (SELECT value FROM json_each(p.asins_json)))
          AND (? IS NULL OR EXISTS (SELECT 1 FROM analysis_runs r WHERE r.id = ? AND r.project_id = p.id)))
        ON CONFLICT (organization_id, project_id) DO UPDATE SET actor_id=excluded.actor_id,
          base_sync_run_id=excluded.base_sync_run_id, selected_asins_json=excluded.selected_asins_json,
          retry_key=excluded.retry_key, fingerprint=excluded.fingerprint, run_id=excluded.run_id, updated_at=excluded.updated_at`)
        .run(r.organizationId, r.projectId, r.actorId, r.baseSyncRunId, JSON.stringify(r.selectedAsins), r.retryKey, r.fingerprint, r.runId, r.updatedAt,
          r.actorId, r.baseSyncRunId, r.projectId, r.organizationId, JSON.stringify(r.selectedAsins), r.runId, r.runId);
      if (result.changes !== 1) throw new Error('VOC automation scope mismatch');
    });
  }
  list(): Promise<VocAutomationRecord[]> {
    return this.options.serialize(() => this.options.database.prepare('SELECT * FROM voc_automation_intents ORDER BY organization_id, project_id').all().map(mapVocAutomation));
  }
}
