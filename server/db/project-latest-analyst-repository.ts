export type ProjectLatestAnalyst = { projectId: string; displayName: string | null };
export type ProjectLatestAnalystInput = { organizationId: string; projectIds: readonly string[] };

export interface ProjectLatestAnalystRepository {
  listLatestProjectAnalysts(input: ProjectLatestAnalystInput): Promise<ProjectLatestAnalyst[]>;
}

/** Bounded parameter lists; each indexed project lookup selects only its newest run. */
export async function readLatestProjectAnalysts(
  input: ProjectLatestAnalystInput,
  dialect: "sqlite" | "postgres",
  query: (sql: string, values: string[]) => Promise<Array<{ project_id: string; display_name: string | null }>>,
): Promise<ProjectLatestAnalyst[]> {
  const ids = [...new Set(input.projectIds)];
  const result: ProjectLatestAnalyst[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    const parameter = (index: number) => dialect === "postgres" ? `$${index}` : "?";
    const rows = await query(`
      SELECT p.id AS project_id, u.display_name
      FROM projects p
      LEFT JOIN analysis_runs r ON r.id = (
        SELECT latest.id FROM analysis_runs latest
        WHERE latest.project_id = p.id
        ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
      )
      LEFT JOIN users u ON u.id = r.created_by AND u.organization_id = p.organization_id
      WHERE p.organization_id = ${parameter(1)}
        AND p.id IN (${batch.map((_, index) => parameter(index + 2)).join(", ")})
    `, [input.organizationId, ...batch]);
    result.push(...rows.map(row => ({ projectId: row.project_id, displayName: row.display_name?.trim() || null })));
  }
  return result;
}
