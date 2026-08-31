import {
  createComparisonProjectServer,
  type ComparisonProjectServerDependencies,
} from "../../../lib/comparison-project-server";

export function createComparisonFavoriteRoute(
  dependencies: ComparisonProjectServerDependencies = {},
) {
  const server = createComparisonProjectServer(dependencies);
  return Object.freeze({ DELETE: server.removeFavorite });
}

const route = createComparisonFavoriteRoute();
export const DELETE = route.DELETE;

