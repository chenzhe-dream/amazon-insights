import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ProjectIdParamsSchema } from '../../shared/agent-contracts';
import { VocAutomationRequestSchema, VocAutomationStatusSchema } from '../../shared/voc-automation-contracts';
import type { VocAutomationService } from '../services/voc-automation-service';
import { ContractRouteError } from './analysis-runs';

export function registerVocAutomationRoutes(app: FastifyInstance, service: VocAutomationService | null) {
 const scope = (request: FastifyRequest) => {
  if (request.authPrincipal?.kind !== 'user') throw new ContractRouteError(403,'FORBIDDEN','Authentication is required');
  const params = ProjectIdParamsSchema.safeParse(request.params);
  if (!params.success) throw new ContractRouteError(400,'VALIDATION_ERROR','Invalid project');
  return {projectId:params.data.projectId,organizationId:request.authPrincipal.organizationId,actorId:request.authPrincipal.userId};
 };
 const required = () => { if (!service) throw new ContractRouteError(503,'CONFIGURATION_ERROR','自动分析服务暂不可用');return service; };
 app.post('/v1/projects/:projectId/voc-automation', async request => {
  const input = VocAutomationRequestSchema.safeParse(request.body);
  if (!input.success) throw new ContractRouteError(400,'VALIDATION_ERROR','Invalid analysis scope');
  return VocAutomationStatusSchema.parse(await required().register(scope(request),input.data));
 });
 app.get('/v1/projects/:projectId/voc-automation', async request => VocAutomationStatusSchema.parse(await required().read(scope(request))));
}
