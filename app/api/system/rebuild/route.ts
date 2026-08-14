import { triggerBackgroundRebuild } from "../../../lib/trigger-rebuild";

export async function POST() {
  const result = triggerBackgroundRebuild();
  return Response.json(result, { status: result.started ? 202 : 409 });
}
