import {z} from 'zod';

export const MODULES = [
 {key:'market',label:'市场调研'},{key:'overview',label:'竞品概览'},
 {key:'voc',label:'VOC'},{key:'keywords',label:'关键词调研'},
 {key:'definition',label:'新品定义'},{key:'checklist',label:'立项前确认清单'},
 {key:'traffic',label:'竞品流量分析'},{key:'favorites',label:'收藏夹'},
 {key:'admin-users',label:'用户与使用统计'},
] as const;
export const ModuleKeySchema=z.enum(MODULES.map(module=>module.key));
export type ModuleKey=z.infer<typeof ModuleKeySchema>;
export const ALL_MODULES:ModuleKey[]=MODULES.map(module=>module.key);
export const VisibleModulesSchema=z.array(ModuleKeySchema).max(MODULES.length).refine(items=>new Set(items).size===items.length,'模块不能重复');
export function isModuleVisible(modules:readonly ModuleKey[]|undefined,key:ModuleKey){return modules===undefined||modules.includes(key);}
export const VisibilityPeopleQuerySchema=z.strictObject({q:z.string().trim().max(100).default(''),page:z.coerce.number().int().min(1).max(1_000_000).default(1)});
export const VisibilityPersonSchema=z.strictObject({userId:z.string().uuid(),displayName:z.string(),account:z.string(),visibleModules:VisibleModulesSchema,version:z.number().int().nonnegative(),configured:z.boolean(),statisticsViewGranted:z.boolean().default(false),isSystemOwner:z.boolean().default(false),configurationSource:z.enum(['legacy','personal','new-user-default']).optional()});
export const VisibilityPeopleResponseSchema=z.strictObject({people:z.array(VisibilityPersonSchema),page:z.number().int().positive(),pageSize:z.literal(10),total:z.number().int().nonnegative()});
export const VisibilitySaveSchema=z.strictObject({visibleModules:VisibleModulesSchema,version:z.number().int().nonnegative()});
export const PersonalVisibilitySaveSchema=VisibilitySaveSchema.extend({statisticsViewGranted:z.boolean().optional()}).refine(value=>value.statisticsViewGranted!==true||value.visibleModules.includes('admin-users'),'授予统计查看权限时必须显示统计模块');
export const VisibilitySaveResponseSchema=z.strictObject({person:VisibilityPersonSchema});
export type VisibilityPerson=z.infer<typeof VisibilityPersonSchema>;
export type VisibilityPeopleResponse=z.infer<typeof VisibilityPeopleResponseSchema>;

// Frozen rollout baseline: adding to MODULES must not silently open new features.
export const INITIAL_NEW_USER_MODULES:readonly ModuleKey[]=Object.freeze(['market','overview','voc','keywords','definition','checklist','traffic','favorites','admin-users']);
export const ModuleVisibilityDefaultsSchema=z.strictObject({visibleModules:VisibleModulesSchema,version:z.number().int().nonnegative()});
export type ModuleVisibilityDefaults=z.infer<typeof ModuleVisibilityDefaultsSchema>;
