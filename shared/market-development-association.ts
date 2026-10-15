import {z} from 'zod';
const text=z.string(),number=z.number().finite();
export const DevelopmentObservationsSchema=z.object({
 demands:z.array(z.object({label:text,dimension:z.enum(['audience','scenario','feature']),keywords:z.array(text),volume:number.nonnegative().nullable(),period:text,ref:text}).strict()).optional(),
 products:z.array(z.object({asin:text,title:text,shape:text.nullable(),price:number.positive().nullable(),currency:text.nullable(),period:text,ref:text}).strict()).optional(),
 reviews:z.array(z.object({asin:text,topic:text,text,positive:number.nonnegative(),negative:number.nonnegative(),period:text,ref:text}).strict()).optional(),
 metrics:z.array(z.object({key:text,label:text,value:number,unit:text,period:text,denominator:text,sample:text,ref:text}).strict()).optional(),
}).strict();
export type DevelopmentObservations=z.infer<typeof DevelopmentObservationsSchema>;
const evidence=z.object({module:text,ref:text,description:text}).strict();
export const DevelopmentDecisionSchema=z.object({
 marketContext:z.array(evidence),
 rules:z.array(z.object({id:text,version:text,condition:text,limitation:text}).strict()),
 candidates:z.array(z.object({id:text,label:text,dimension:text,status:z.enum(['supported','needs-evidence','hold']),reason:text,keywords:z.array(text),asins:z.array(text),price:text,evidence:z.array(evidence),counterevidence:z.array(text),missing:z.array(text),next:text}).strict()),
 conflicts:z.array(z.object({kind:z.enum(['basis','conflict']),message:text,refs:z.array(text)}).strict()),
 risks:z.array(z.object({asin:text,ref:text,text,reason:text}).strict()),
 reconciliations:z.array(text),
 coverage:text,
}).strict();
export type DevelopmentDecision=z.infer<typeof DevelopmentDecisionSchema>;
