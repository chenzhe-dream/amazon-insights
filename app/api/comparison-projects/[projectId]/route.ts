import {
  createComparisonProjectServer,
  type ComparisonProjectServerDependencies,
} from "../../../lib/comparison-project-server";

export function createComparisonProjectRoute(
  dependencies: ComparisonProjectServerDependencies = {},
) {
  const server = createComparisonProjectServer(dependencies);
  return Object.freeze({ GET: server.get, PATCH: server.update });
}

const route = createComparisonProjectRoute();
export const GET = route.GET;
export const PATCH = route.PATCH;
