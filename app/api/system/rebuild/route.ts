import { authorizeWebMutation } from "../../../lib/authenticated-web-mutation";
import { triggerBackgroundRebuild } from "../../../lib/trigger-rebuild";

type RebuildDependencies = {
  authorize: typeof authorizeWebMutation;
  rebuild: typeof triggerBackgroundRebuild;
};

export function createSystemRebuildHandler(dependencies: Partial<RebuildDependencies> = {}) {
  const authorize = dependencies.authorize ?? authorizeWebMutation;
  const rebuild = dependencies.rebuild ?? triggerBackgroundRebuild;
  return async function handleSystemRebuild(request: Request) {
    const authorization = await authorize(request, { allowedRoles: ["admin"] });
    if (!authorization.ok) return authorization.response;
    let result;
    try {
      result = rebuild();
    } catch {
      return Response.json({ error: "系统后台构建失败" }, { status: 500 });
    }
    return Response.json(result, { status: result.started ? 202 : 409 });
  };
}

export const POST = createSystemRebuildHandler();
