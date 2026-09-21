import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AsinSchema, EntityIdSchema, GetProjectResponseSchema, GetRunResponseSchema, LocalDataStageOutputResponseSchema, ManualAlexaVocListResponseSchema, SessionResponseSchema } from "../../shared/agent-contracts";
import { isModuleVisible } from "../../shared/module-visibility-contracts";
import type { AgentServiceClient } from "./agent-service-client";
import { buildProductLaunchAnalysis, hasProductLaunchAnalysis, type ProductLaunchRuntimeSources } from "../product-launch-analysis";
import { buildFinalProductDefinition } from "../final-product-definition";
import { buildKeywordDemandAnalysis } from "../keyword-demand-analysis";
import { hasVocDevelopmentData } from "../voc-development-summary";
import { createLocalRuleReportStore } from "../../server/services/local-rule-report-store";
import type { LocalRuleReport } from "../../shared/local-rule-report";
import { reconcileLocalRuleReportSources } from "./local-rule-report-sources";

const text = z.string().max(4000);
const ProductSchema = z.object({ asin: AsinSchema, brand: text, title: text.optional(), subRankCategory: text.optional(), rankCategory: text.optional(),
  price: z.number().nullable().optional(), sales: z.number().nullable().optional(), rating: z.number().nullable().optional(), reviews: z.number().nullable().optional(), launch: text.nullable().optional(),
  productFamily: z.enum(["scooter", "lighting", "generic"]).optional(), features: z.array(text).max(100).optional() }).strict();
const ScopeSchema = z.object({ projectId: EntityIdSchema, asins: z.array(AsinSchema).min(1).max(10).refine(a => new Set(a).size === a.length) });
const RequestSchema = ScopeSchema.extend({ products: z.array(ProductSchema).min(1).max(10), baseSyncRunId: EntityIdSchema.nullable().optional(), jobId: z.string().min(1).max(200).nullable().optional(), reviewFallback: z.boolean().default(false) }).strict();
const fail = (message: string, status: number) => Response.json({ error: message }, { status });

export function createLocalRuleReportHandlers(deps: { client: AgentServiceClient; store: ReturnType<typeof createLocalRuleReportStore> }) {
  async function authorized(request: Request, projectId: string) {
    const headers = new Headers({ origin: new URL(request.url).origin });
    const cookie = request.headers.get("cookie"); if (cookie) headers.set("cookie", cookie);
    const sessionResponse = await deps.client({ method: "GET", path: "/v1/auth/session", headers });
    const session = SessionResponseSchema.safeParse(sessionResponse.body);
    if (sessionResponse.status !== 200 || !session.success || !session.data.authenticated) return fail("请先登录", 401);
    if (!isModuleVisible(session.data.visibleModules, "definition")) return fail("没有新品定义模块权限", 403);
    const response = await deps.client({ method: "GET", path: `/v1/projects/${projectId}`, headers });
    if (response.status !== 200) return Response.json(response.body, { status: response.status });
    const parsed = GetProjectResponseSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.project.id !== projectId || parsed.data.project.organizationId !== session.data.user.organizationId) return fail("项目范围不匹配", 403);
    return { project: parsed.data.project, headers };
  }
  return {
    async GET(request: Request) {
      const url = new URL(request.url);
      const parsed = ScopeSchema.safeParse({ projectId: url.searchParams.get("projectId"), asins: (url.searchParams.get("asins") ?? "").split(",") });
      if (!parsed.success) return fail("报告范围无效", 400);
      const auth = await authorized(request, parsed.data.projectId); if (auth instanceof Response) return auth;
      if (parsed.data.asins.some(asin => !auth.project.asins.includes(asin))) return fail("ASIN 不属于当前项目", 403);
      const reports = await deps.store.list(auth.project.organizationId, auth.project.id, parsed.data.asins);
      // Never reinterpret persisted decisions through the current rule catalog.
      const visibleReports = await Promise.all(reports.map(report => reconcileLocalRuleReportSources(report, deps.client, auth.headers)));
      return Response.json({ reports: visibleReports }, { headers: { "cache-control": "private, no-store" } });
    },
    async POST(request: Request) {
      if (request.headers.get("origin") !== new URL(request.url).origin) return fail("请求来源无效", 403);
      let raw: unknown; try { raw = await request.json(); } catch { return fail("报告输入无效", 400); }
      const parsed = RequestSchema.safeParse(raw); if (!parsed.success) return fail("报告输入无效", 400);
      const input = parsed.data;
      const auth = await authorized(request, input.projectId); if (auth instanceof Response) return auth;
      if (auth.project.marketplace !== "US" || input.asins.some(asin => !auth.project.asins.includes(asin)) || input.products.map(p => p.asin).sort().join(",") !== [...input.asins].sort().join(",")) return fail("商品输入与当前项目范围不匹配", 403);
      if (Boolean(input.baseSyncRunId) !== Boolean(input.jobId)) return fail("采集运行范围不完整", 400);
      const query = new URLSearchParams({ projectId: input.projectId, marketplace: auth.project.marketplace });
      input.asins.forEach(asin => query.append("asins", asin));
      const vocResult = await deps.client({ method: "GET", path: `/v1/manual-alexa-voc?${query}`, headers: auth.headers });
      if (vocResult.status !== 200) return Response.json(vocResult.body, { status: vocResult.status });
      const voc = ManualAlexaVocListResponseSchema.parse(vocResult.body);
      if (voc.records.some(record => !input.asins.includes(record.asin) || record.marketplace !== auth.project.marketplace)) return fail("VOC 来源范围不匹配", 403);
      const manualVocByAsin = Object.fromEntries(voc.records.map(r => [r.asin, r.normalizedRecord]));
      let keywordSources: NonNullable<ProductLaunchRuntimeSources["keywordSources"]> = { analysisByAsin: {}, enrichmentByKeyword: {} };
      let reviewCandidates: ProductLaunchRuntimeSources["reviewAnalysisByAsin"] = {};
      const revisions: unknown[] = [voc.records.map(r => [r.asin, r.revision, r.contentHash])];
      const sourceBindings: NonNullable<LocalRuleReport["sourceBindings"]> = { manualVoc: voc.records.map(({ asin, revision, contentHash }) => ({ asin, revision, contentHash })), stages: [] };
      if (input.baseSyncRunId && input.jobId) {
        const runResult = await deps.client({ method: "GET", path: `/v1/runs/${input.baseSyncRunId}`, headers: auth.headers });
        if (runResult.status !== 200) return Response.json(runResult.body, { status: runResult.status });
        const run = GetRunResponseSchema.parse(runResult.body);
        if (run.run.projectId !== input.projectId) return fail("采集运行不属于当前项目", 403);
        for (const stage of ["keywords", ...(input.reviewFallback ? ["reviews" as const] : [])] as const) {
          const stageResult = await deps.client({ method: "GET", path: `/v1/projects/${input.projectId}/runs/${input.baseSyncRunId}/sync-jobs/${encodeURIComponent(input.jobId)}/stages/${stage}/output`, headers: auth.headers });
          if (stageResult.status !== 200) return Response.json(stageResult.body, { status: stageResult.status });
          const output = LocalDataStageOutputResponseSchema.parse(stageResult.body);
          if (output.projectId !== input.projectId || output.runId !== input.baseSyncRunId || output.jobId !== input.jobId || output.stage !== stage) return fail("采集来源范围不匹配", 403);
          if (output.stageStatus !== "done" || !("data" in output)) return fail(`${stage === "keywords" ? "关键词" : "评论"}来源${output.stageStatus === "partial" ? "不完整" : "采集失败"}，请补齐来源后保存报告。`, 422);
          sourceBindings.stages.push({ stage, runId: input.baseSyncRunId, jobId: input.jobId, status: "done", contentHash: output.contentHash, outputVersion: output.outputVersion });
          revisions.push([stage, output.contentHash, output.outputVersion]);
          if ("data" in output && output.stage === "keywords") keywordSources = output.data as NonNullable<ProductLaunchRuntimeSources["keywordSources"]>;
          if ("data" in output && output.stage === "reviews") reviewCandidates = output.data.analysisByAsin as ProductLaunchRuntimeSources["reviewAnalysisByAsin"];
        }
      }
      const reviewAnalysisByAsin = Object.fromEntries(input.products.filter(p => input.reviewFallback && !hasVocDevelopmentData([p], manualVocByAsin)).flatMap(p => reviewCandidates?.[p.asin] ? [[p.asin, reviewCandidates[p.asin]]] : []));
      const inputScope = { organizationId: auth.project.organizationId, projectId: auth.project.id, marketplace: auth.project.marketplace, asins: [...input.asins].sort(), inputRevision: createHash("sha256").update(JSON.stringify([input.products, revisions, input.reviewFallback])).digest("hex") };
      const sources: ProductLaunchRuntimeSources = { manualVocByAsin, reviewAnalysisByAsin, keywordSources, keywordDemand: buildKeywordDemandAnalysis(input.products, keywordSources), analysisScope: inputScope };
      if (!hasProductLaunchAnalysis(input.products, sources)) return fail("所选输入尚不足以生成报告", 422);
      const analysis = buildProductLaunchAnalysis(input.products, sources);
      const finalDefinition = buildFinalProductDefinition({ categoryLabel: analysis.meta.categoryLabel, productCount: analysis.meta.productCount, dataMonth: analysis.meta.dataMonth, vocPositioning: analysis.vocPositioning, keyword: analysis.keywordConclusions, priceBand: analysis.marketRows.find(row => row.metric.includes("价格"))?.data ?? analysis.productDefinition.targetPrice, hasVocData: true });
      if (!analysis.ruleTrace) return fail("规则执行记录未生成，无法保存", 503);
      const report: LocalRuleReport = { schemaVersion: "local-rule-report/v1", id: randomUUID(), createdAt: new Date().toISOString(), inputScope: analysis.ruleTrace.inputScope, ruleSetVersion: analysis.ruleTrace.ruleSetVersion,
        inputSourceNote: "商品名称、类目及描述保存自本次页面输入；VOC 与关键词来源经当前项目授权读取，规则判定由服务端重新执行。", products: input.products, analysis, finalDefinition, sourceBindings,
        sourceAvailability: { state: "available", message: "生成时来源仍可读取，规则解释使用保存时快照。" } };
      await deps.store.save(report);
      return Response.json({ report }, { status: 201, headers: { "cache-control": "private, no-store" } });
    },
  };
}
