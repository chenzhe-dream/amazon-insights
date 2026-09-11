import { z } from "zod";
import { AmazonVocInsightOutputSchema } from "../domain/voc/amazon-voc-insight-contracts";
import { VocPositioningOutputShapeSchema } from "../domain/voc/voc-positioning-contracts";
import type { VocDeterministicPreprocessingResult } from "../domain/voc/preprocess-voc-snapshot";

const shape = VocPositioningOutputShapeSchema.shape;
const referenced = shape.checklists.shape.mustKeep.element.omit({ evidenceIds: true });
export const compactVocResponseSchema = AmazonVocInsightOutputSchema.extend({
 positioningProjection: VocPositioningOutputShapeSchema.omit({identity:true,coverage:true}).extend({
  coreConclusion:shape.coreConclusion.omit({evidenceIds:true}),
  positioning:shape.positioning.element.omit({evidenceIds:true}).array().length(10),
  themeJudgments:shape.themeJudgments.element.omit({metrics:true,evidenceIds:true,label:true,priority:true}).array(),
  actions:shape.actions.element.omit({evidenceIds:true}).array(),
  nextValidations:shape.nextValidations.element.omit({evidenceIds:true}).array(),
  checklists:shape.checklists.extend({mustKeep:referenced.array().max(3),mustAvoid:referenced.array().max(3),differentiationOpportunities:referenced.array().max(3)}),
 }),
});

/** Only hydrate the compact wire shape. Full legacy outputs retain all validation checks. */
export function hydrateVocOutput(candidate:unknown,facts:VocDeterministicPreprocessingResult):unknown {
 const parsed=compactVocResponseSchema.safeParse(candidate);
 if(!parsed.success)return candidate;
 const value=parsed.data,p=value.positioningProjection;
 const themes=new Map(facts.dimensions.flatMap(d=>d.themes.map(theme=>[JSON.stringify([d.key,theme.key]),theme] as const)));
 const find=(ref:{dimension:string;themeKey:string})=>{const theme=themes.get(JSON.stringify([ref.dimension,ref.themeKey]));if(!theme)throw new z.ZodError([{code:"custom",path:["positioningProjection","themeRefs"],message:`Unknown VOC theme reference: ${ref.dimension}/${ref.themeKey}. Use only dimension/key pairs from the input facts.`}]);return theme;};
 const references=<T extends {themeRefs:{dimension:string;themeKey:string}[]}>(row:T)=>({...row,evidenceIds:[...new Set(row.themeRefs.flatMap(ref=>find(ref).evidenceIds))]});
 return {...value,positioningProjection:{...p,
  identity:{snapshotId:facts.snapshot.id,contentHash:facts.snapshot.contentHash,factsDigest:facts.factsDigest,dataCutoffAt:facts.snapshot.dataCutoffAt},
  coverage:facts.availability.map(s=>({sourceId:s.sourceId,status:s.status,missingAsins:s.missingAsins})),
  coreConclusion:references(p.coreConclusion),positioning:p.positioning.map(references),actions:p.actions.map(references),nextValidations:p.nextValidations.map(references),
  checklists:{mustKeep:p.checklists.mustKeep.map(references),mustAvoid:p.checklists.mustAvoid.map(references),differentiationOpportunities:p.checklists.differentiationOpportunities.map(references)},
  themeJudgments:p.themeJudgments.map(j=>{const theme=find(j);return {...j,label:theme.label,priority:theme.priority.level,evidenceIds:[...theme.evidenceIds],metrics:theme.metrics.map(m=>({evidenceId:m.evidenceId,sourceId:m.sourceId,asin:m.asin,capturedAt:m.capturedAt,mentionCount:m.mentionCount,sampleCount:m.sampleCount,mentionPct:m.mentionPct}))};}),
 }};
}
