import { z } from "zod";
import type { NamedOutputRepairPatchContract } from "../runtime/skill-runner";
import type { SafeValidationIssue } from "../runtime/safe-validation-issues";
import { VocPositioningOutputShapeSchema } from "../domain/voc/voc-positioning-contracts";

const schema = z.strictObject({
 schemaVersion:z.literal("1.0.0"),kind:z.literal("voc-strategy-repair"),
 changes:z.array(z.strictObject({index:z.number().int().min(0).max(9),strategy:z.enum(["retain","redesign","differentiate","avoid","validate"])})).min(1).max(10),
});
function indexes(issues:readonly SafeValidationIssue[]) {
 if(!issues.length || issues.some(x=>!["voc-positioning-strategy-stance-mismatch","voc-protected-positioning-strategy-downgrade"].includes(x.ruleId??"") || x.path.length!==4 || x.path[0]!=="positioningProjection" || x.path[1]!=="positioning" || !Number.isInteger(x.path[2]) || x.path[3]!=="strategy")) return null;
 return new Set(issues.map(x=>Number(x.path[2])));
}
function projection(output:unknown) {
 return VocPositioningOutputShapeSchema.parse((output as Record<string,unknown>).positioningProjection);
}
export const vocStrategyRepair:NamedOutputRepairPatchContract={
 name:"AmazonVocStrategyRepair_1_0_0",schema,selfContained:true,
 canHandle(output,issues){try{return indexes(issues)!==null && !!projection(output);}catch{return false;}},
 guidance(output,issues){const allowed=indexes(issues);if(!allowed)return null;const value=projection(output);return ["Only replace the listed strategy fields. Preserve all evidence, stances and insight text.",JSON.stringify([...allowed].map(index=>({index,...value.positioning[index],allowedStrategies:value.positioning[index].stance==="supported-by-voc"?["retain","redesign","avoid"]:value.positioning[index].stance==="requires-validation"?["differentiate","validate"]:["validate"]})))];},
 apply(output,patch,issues){const allowed=indexes(issues);const parsed=schema.parse(patch);if(!allowed || parsed.changes.length!==allowed.size || new Set(parsed.changes.map(x=>x.index)).size!==allowed.size || parsed.changes.some(x=>!allowed.has(x.index)))throw new Error("Strategy repair exceeded its authorized fields");const result=structuredClone(output) as {positioningProjection:z.infer<typeof VocPositioningOutputShapeSchema>};for(const change of parsed.changes)result.positioningProjection.positioning[change.index].strategy=change.strategy;return result;},
};
