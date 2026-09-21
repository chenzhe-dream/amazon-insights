import { createAgentServiceClient } from "../../lib/agent-service-client";
import { createLocalRuleReportHandlers } from "../../lib/local-rule-report-server";
import { createLocalRuleReportStore } from "../../../server/services/local-rule-report-store";
import { getProjectRoot } from "../../../scripts/lib/project-root.mjs";
import { resolveRuntimeRoots } from "../../../scripts/lib/runtime-roots.mjs";
const roots = resolveRuntimeRoots({ codeRoot: getProjectRoot(), env: process.env, formal: Boolean(process.env.AGENT_FORMAL_WORKTREE_ROOT), commit: undefined });
const handlers = createLocalRuleReportHandlers({ client: createAgentServiceClient(), store: createLocalRuleReportStore(roots.dataRoot) });
export const GET = handlers.GET;
export const POST = handlers.POST;
