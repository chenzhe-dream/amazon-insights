import { z } from "zod";
import { AmazonVocInsightOutputSchema, AmazonVocInsightShapeSchema } from "../domain/voc/amazon-voc-insight-contracts";
import { VocPositioningOutputShapeSchema } from "../domain/voc/voc-positioning-contracts";
import type { VocDeterministicPreprocessingResult } from "../domain/voc/preprocess-voc-snapshot";

const insightShape = AmazonVocInsightShapeSchema.shape;
// Bound the narrative, not the evidence or protected-theme coverage.
const conciseInsight = AmazonVocInsightShapeSchema.safeExtend({
 summary: insightShape.summary.max(400),
 sevenDimensions: insightShape.sevenDimensions.element.safeExtend({
  rows: insightShape.sevenDimensions.element.shape.rows.max(3),
 }).array().length(7),
 negativePriorities: insightShape.negativePriorities.max(3),
 unmetOpportunities: insightShape.unmetOpportunities.max(3),
 productDirections: insightShape.productDirections.max(3),
 scoredOpportunities: insightShape.scoredOpportunities.max(3),
}).describe("Concise first report: select the three most important findings per section, keep each narrative field to one short sentence. All seven dimensions and three product directions are required. Do not omit protected themes from positioningProjection.");
const shape = VocPositioningOutputShapeSchema.shape;
const referenced = shape.checklists.shape.mustKeep.element.omit({ evidenceIds: true });
export const compactVocResponseSchema = AmazonVocInsightOutputSchema.extend({
 insight: conciseInsight,
 positioningProjection: VocPositioningOutputShapeSchema.omit({identity:true,coverage:true}).extend({
  coreConclusion:shape.coreConclusion.omit({evidenceIds:true}),
  positioning:shape.positioning.element.omit({evidenceIds:true}).array().length(10),
  themeJudgments:shape.themeJudgments.element.omit({metrics:true,evidenceIds:true,label:true,priority:true}).array(),
  actions:shape.actions.element.omit({evidenceIds:true}).array(),
  nextValidations:shape.nextValidations.element.omit({evidenceIds:true}).array(),
  checklists:shape.checklists.extend({mustKeep:referenced.array().max(3),mustAvoid:referenced.array().max(3),differentiationOpportunities:referenced.array().max(3)}),
 }),
});

/** Publish only frozen reference pairs; preserve all narrative and final validation contracts. */
export function createCompactVocResponseSchema(facts: VocDeterministicPreprocessingResult) {
 const p = compactVocResponseSchema.shape.positioningProjection.shape;
 // Sorting makes the prepared response schema digest independent of collection order.
 const dimensions = facts.dimensions.filter(d => d.themes.length > 0)
  .map(d => ({dimension: d.key, keys: [...new Set(d.themes.map(t => t.key))].sort()}))
  .sort((a, b) => a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0);
 if (!dimensions.length) throw new Error("Frozen VOC response schema requires evidence themes");
 const pairs = dimensions.map(d => ({dimension: z.literal(d.dimension), themeKey: z.enum(d.keys)}));
 const themeRefs = z.array(z.union(pairs.map(pair => z.strictObject(pair)))).min(1)
  .describe("Use an exact frozen dimension/themeKey pair. Never translate, rephrase, or move a theme key to another dimension.");
 const checklist = referenced.extend({themeRefs});
 return compactVocResponseSchema.extend({positioningProjection: compactVocResponseSchema.shape.positioningProjection.extend({
  coreConclusion: p.coreConclusion.extend({themeRefs}),
  positioning: p.positioning.element.extend({themeRefs}).array().length(10),
  themeJudgments: z.union(pairs.map(pair => p.themeJudgments.element.extend(pair))).array(),
  actions: p.actions.element.extend({themeRefs}).array(),
  nextValidations: p.nextValidations.element.extend({themeRefs}).array(),
  checklists: p.checklists.extend({mustKeep: checklist.array().max(3), mustAvoid: checklist.array().max(3), differentiationOpportunities: checklist.array().max(3)}),
 })});
}

/** Only hydrate the compact wire shape. Full legacy outputs retain all validation checks. */
export function hydrateVocOutput(candidate:unknown,facts:VocDeterministicPreprocessingResult):unknown {
 const parsed=compactVocResponseSchema.safeParse(candidate);
 if(!parsed.success)return candidate;
 const value=parsed.data,p=value.positioningProjection;
 const themes=new Map(facts.dimensions.flatMap(d=>d.themes.map(theme=>[JSON.stringify([d.key,theme.key]),theme] as const)));
 const find=(ref:{dimension:string;themeKey:string})=>{const theme=themes.get(JSON.stringify([ref.dimension,ref.themeKey]));if(!theme)throw new z.ZodError([{code:"custom",path:["positioningProjection","themeRefs"],message:"voc-forged-theme-reference",params:{ruleId:"voc-forged-theme-reference"}}]);return theme;};
 const references=<T extends {themeRefs:{dimension:string;themeKey:string}[]}>(row:T)=>({...row,evidenceIds:[...new Set(row.themeRefs.flatMap(ref=>find(ref).evidenceIds))]});
 return {...value,positioningProjection:{...p,
  identity:{snapshotId:facts.snapshot.id,contentHash:facts.snapshot.contentHash,factsDigest:facts.factsDigest,dataCutoffAt:facts.snapshot.dataCutoffAt},
  coverage:facts.availability.map(s=>({sourceId:s.sourceId,status:s.status,missingAsins:s.missingAsins})),
  coreConclusion:references(p.coreConclusion),positioning:p.positioning.map(references),actions:p.actions.map(references),nextValidations:p.nextValidations.map(references),
  checklists:{mustKeep:p.checklists.mustKeep.map(references),mustAvoid:p.checklists.mustAvoid.map(references),differentiationOpportunities:p.checklists.differentiationOpportunities.map(references)},
  themeJudgments:p.themeJudgments.map(j=>{const theme=find(j);return {...j,label:theme.label,priority:theme.priority.level,evidenceIds:[...theme.evidenceIds],metrics:theme.metrics.map(m=>({evidenceId:m.evidenceId,sourceId:m.sourceId,asin:m.asin,capturedAt:m.capturedAt,mentionCount:m.mentionCount,sampleCount:m.sampleCount,mentionPct:m.mentionPct}))};}),
 }};
}
