/** SQL fragments accept only code-owned expressions, never request text. Read paths only. */
export function marketSharedReadSql(userParameter:string, organizationExpression:string, target:{run:string}|{study:string}):string {
 const binding='run' in target
  ? `b.value->>'runId'=(${target.run})::text`
  : `EXISTS (SELECT 1 FROM market_analysis_module_runs shared_run WHERE shared_run.id::text=b.value->>'runId' AND shared_run.study_id=${target.study} AND shared_run.organization_id=${organizationExpression})`;
 return `EXISTS (SELECT 1 FROM users shared_user WHERE shared_user.id=${userParameter} AND shared_user.status='active' AND shared_user.archived_at IS NULL AND (shared_user.organization_id=${organizationExpression} OR (
   (EXISTS (SELECT 1 FROM system_owners o WHERE o.user_id=shared_user.id AND o.organization_id=shared_user.organization_id) OR NOT EXISTS (SELECT 1 FROM user_module_visibility v WHERE v.user_id=shared_user.id AND v.organization_id=shared_user.organization_id AND NOT (v.modules_json ? 'market')))
   AND EXISTS (SELECT 1 FROM market_project_favorites f CROSS JOIN LATERAL jsonb_each(f.context_json) b WHERE ${binding})
 )))`;
}
