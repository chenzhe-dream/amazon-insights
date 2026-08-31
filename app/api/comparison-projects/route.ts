import {
  createComparisonProjectServer,
  type ComparisonProjectServerDependencies,
} from "../../lib/comparison-project-server";

export function createComparisonProjectsRoute(
  dependencies: ComparisonProjectServerDependencies = {},
) {
  const server = createComparisonProjectServer(dependencies);
  return Object.freeze({ GET: server.list, POST: server.create });
}

const route = createComparisonProjectsRoute();
export const GET = route.GET;
export const POST = route.POST;

