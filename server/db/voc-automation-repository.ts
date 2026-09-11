import { z } from 'zod';
import { DateTimeSchema, EntityIdSchema } from '../../shared/agent-contracts';

export const VocAutomationRecordSchema = z.strictObject({
  organizationId: EntityIdSchema,
  projectId: EntityIdSchema,
  actorId: EntityIdSchema,
  baseSyncRunId: EntityIdSchema,
  selectedAsins: z.array(z.string().regex(/^[A-Z0-9]{10}$/)).min(1).refine(
    asins => asins.every((asin, index) => index === 0 || asins[index - 1] < asin),
    'Selected ASINs must be unique and sorted',
  ),
  retryKey: z.string().min(1).max(200).nullable(),
  fingerprint: z.string().min(1).max(500).nullable(),
  runId: EntityIdSchema.nullable(),
  updatedAt: DateTimeSchema,
});

export type VocAutomationRecord = z.infer<typeof VocAutomationRecordSchema>;

export interface VocAutomationRepository {
  get(organizationId: string, projectId: string): Promise<VocAutomationRecord | null>;
  /** Must run inside the outer repository transaction, before reading or writing intent. */
  lock(organizationId: string, projectId: string): Promise<void>;
  save(record: VocAutomationRecord): Promise<void>;
  /** Internal worker enumeration; never expose this unscoped list to clients. */
  list(): Promise<VocAutomationRecord[]>;
}

export function mapVocAutomation(row: Record<string, unknown>): VocAutomationRecord {
  return VocAutomationRecordSchema.parse({
    organizationId: row.organization_id, projectId: row.project_id,
    actorId: row.actor_id, baseSyncRunId: row.base_sync_run_id,
    selectedAsins: typeof row.selected_asins_json === 'string' ? JSON.parse(row.selected_asins_json) : row.selected_asins_json,
    retryKey: row.retry_key, fingerprint: row.fingerprint, runId: row.run_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  });
}
