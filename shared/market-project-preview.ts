import {projectModules,type ProjectContext,type ProjectModule,type ProjectStatus} from './market-project-favorites-contracts';

export type ProjectPreviewCandidate={context:ProjectContext;status:ProjectStatus;createdAt:string;hasReport?:boolean};

/** Read-only preview association. Never relabel a report or borrow another site's data. */
export function buildProjectPreviewContext(source:ProjectContext,module:ProjectModule,candidates:ProjectPreviewCandidate[]):ProjectContext{
 const anchor=source[module];if(!anchor)throw new Error('预览入口缺少所选模块条件');
 const {runId:_,...scope}=anchor;
 const result:ProjectContext={headTopN:source.headTopN,newProductMonths:source.newProductMonths};
 const leaf=(path:string)=>path.split(':').at(-1);
 for(const target of projectModules){
  if(target===module){result[target]={...anchor};if(target==='keywords')result.keywordInput=source.keywordInput;continue;}
  // A rolling overview is not a calendar-month report for the other modules.
  result[target]={...scope,...(target!=='overview'?{overviewPeriod:undefined}:{})};
  const eligible=candidates.filter(c=>{
   const s=c.context[target];return s?.runId&&['ready','partial'].includes(c.status)&&s.marketplace===anchor.marketplace
    &&leaf(s.nodeIdPath)===leaf(anchor.nodeIdPath)&&s.toMonth===anchor.toMonth&&s.overviewPeriod===anchor.overviewPeriod;
  }).sort((a,b)=>{
   const left=a.context[target]!,right=b.context[target]!;
   return Number(right.runId===source[target]?.runId)-Number(left.runId===source[target]?.runId)
    ||Number(right.fromMonth===anchor.fromMonth)-Number(left.fromMonth===anchor.fromMonth)
    ||Number(b.hasReport??b.status==='ready')-Number(a.hasReport??a.status==='ready')
    ||Number(b.status==='ready')-Number(a.status==='ready')||b.createdAt.localeCompare(a.createdAt)
    ||right.runId!.localeCompare(left.runId!);
  });
  const peer=eligible[0];if(!peer)continue;
  result[target]={...peer.context[target]!};
  if(target==='overview'){result.headTopN=peer.context.headTopN;result.newProductMonths=peer.context.newProductMonths;}
  if(target==='keywords')result.keywordInput=peer.context.keywordInput;
 }
 return result;
}
