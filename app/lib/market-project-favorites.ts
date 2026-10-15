import {ProjectContextSchema,projectModules,type ProjectContext,type ProjectModule} from '../../shared/market-project-favorites-contracts';
const prefixes={shapes:'marketShape',keywords:'marketKeyword',themes:'marketTheme'} as const;
const runKeys={overview:'overviewRun',shapes:'shapeRun',keywords:'keywordRun',themes:'themeRun'} as const;
export function captureProjectContext(params:URLSearchParams,latestMonth:string):ProjectContext{
 const context:Record<string,unknown>={};
 for(const m of projectModules){const prefix=m==='overview'?'market':prefixes[m];const own=params.has(prefix+'Node'),fallback=m==='overview'||(!own&&params.get('themeView')===m);const get=(key:string)=>params.get((fallback?'market':prefix)+key);const runId=params.get(runKeys[m]);const node=get('Node')||(runId?params.get('marketNode'):null);if(!node||!/^\d+(?::\d+)*$/.test(node))continue;
 const raw=get('Month')??latestMonth,toMonth=raw==='last30'?latestMonth:raw;const fromMonth=raw==='last30'?latestMonth:get('From')??toMonth;
 context[m]={marketplace:get('Site')??'US',nodeIdPath:node,fromMonth,toMonth,...(runId?{runId}:{}),...(raw==='last30'?{overviewPeriod:'last30'}:{})};
 }
 if(params.has('marketHead'))context.headTopN=params.get('marketHead');if(params.has('marketNew'))context.newProductMonths=params.get('marketNew');return ProjectContextSchema.parse(context);
}
export function projectModuleHref(context:ProjectContext,module:ProjectModule,conditionsOnly=false):string{
 const params=new URLSearchParams({tab:'market-overview',themeView:module});
 for(const m of projectModules){const s=context[m];if(!s)continue;const prefix=m==='overview'?'market':prefixes[m];params.set(prefix+'Site',s.marketplace);params.set(prefix+'Node',s.nodeIdPath);params.set(prefix+'From',s.fromMonth);params.set(prefix+'Month',s.overviewPeriod??s.toMonth);if(s.runId&&!conditionsOnly)params.set(runKeys[m],s.runId);}
 if(context.headTopN)params.set('marketHead',context.headTopN);if(context.newProductMonths)params.set('marketNew',context.newProductMonths);
 return '/?'+params;
}
export function projectPrimaryScope(context:ProjectContext){return context.overview??context.shapes??context.keywords??context.themes!}
