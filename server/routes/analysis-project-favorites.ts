import type { FastifyInstance, FastifyRequest } from "fastify";
import { AnalysisFavoriteResponseSchema, AnalysisFavoritesResponseSchema, FavoriteEmptySchema,
  FavoriteParamsSchema } from "../../shared/analysis-project-favorite-contracts";
import { FavoriteProjectError, type AnalysisProjectFavoriteStore } from "../services/analysis-project-favorite-store";
import { ContractRouteError } from "./analysis-runs";

export function registerAnalysisProjectFavoriteRoutes(app: FastifyInstance, store: AnalysisProjectFavoriteStore) {
  function principal(request: FastifyRequest) {
    if (request.authPrincipal?.kind !== "user") throw new ContractRouteError(401, "UNAUTHORIZED", "Authentication required");
    if (!FavoriteEmptySchema.safeParse(request.query).success ||
        !FavoriteEmptySchema.safeParse(request.body ?? {}).success) {
      throw new ContractRouteError(400, "VALIDATION_ERROR", "Favorite requests do not accept scope or project data");
    }
    return request.authPrincipal;
  }
  function storageError(error: unknown): never {
    if (error instanceof FavoriteProjectError) throw new ContractRouteError(error.statusCode, "NOT_FOUND", error.message);
    throw new ContractRouteError(500, "INFRASTRUCTURE_ERROR", "收藏服务暂时不可用，请稍后重试");
  }
  app.get("/v1/local-data/project-favorites", async request => {
    const user = principal(request);
    try { return AnalysisFavoritesResponseSchema.parse({ projectIds: store.list(user.organizationId) }); }
    catch (error) { storageError(error); }
  });
  for (const method of ["PUT", "DELETE"] as const) {
    app.route({ method, url: "/v1/local-data/projects/:id/favorite", handler: async request => {
      const user = principal(request);
      const params = FavoriteParamsSchema.safeParse(request.params);
      if (!params.success) throw new ContractRouteError(400, "VALIDATION_ERROR", "Invalid project ID");
      const projectId = params.data.id.toLowerCase(), favorited = method === "PUT";
      try {
        store.set(user.organizationId, user.userId, projectId, favorited);
        return AnalysisFavoriteResponseSchema.parse({ projectId, favorited });
      } catch (error) { storageError(error); }
    } });
  }
}
