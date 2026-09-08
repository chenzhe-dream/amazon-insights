import {
  createRuntimeAnalysisDataHandler,
  readGeneratedRuntimeAnalysisData,
  readGeneratedXydcOrderProgress,
} from "../../lib/runtime-analysis-data-server";
import { createAgentServiceClient } from "../../lib/agent-service-client";

export const GET = createRuntimeAnalysisDataHandler({
  client: createAgentServiceClient(),
  readSnapshot: readGeneratedRuntimeAnalysisData,
  readProgress: readGeneratedXydcOrderProgress,
});
