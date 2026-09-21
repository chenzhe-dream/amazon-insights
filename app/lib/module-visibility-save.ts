import {VisibilityPeopleResponseSchema,VisibilitySaveResponseSchema,type ModuleKey,type VisibilityPerson} from '../../shared/module-visibility-contracts';
import {localAgentFetch} from './local-agent-browser';

type SaveInput={visibleModules:readonly ModuleKey[];version:number;statisticsViewGranted?:boolean};
const unconfirmed='保存结果尚未确认，请取消后重新打开配置查看实际状态，避免重复提交。';
function saveError(status:number){
 if(status===409)return '配置已被其他人更新，请取消后重新打开。';
 if(status===403)return '无权修改该人员的配置（系统所有者不可修改）。';
 if(status===404)return '保存接口或人员不存在（404），请刷新页面后重试。';
 if(status===400)return '模块配置参数无效，请重新打开配置。';
 if(status===401)return '登录已失效，请重新登录。';
 return '服务处理失败（'+status+'），请稍后重试。';
}

export async function saveModuleVisibility(target:VisibilityPerson,input:SaveInput,request:typeof localAgentFetch=localAgentFetch){
 let response:Response|undefined;
 try{response=await request('/v1/admin/module-visibility/'+target.userId,{method:'PUT',body:JSON.stringify(input)});}catch{/* Lost response: reconcile below, never replay the write. */}
 if(response?.ok){
  try{return {...VisibilitySaveResponseSchema.parse(await response.json()),reconciled:false};}catch{/* A truncated successful response also has an uncertain outcome. */}
 }else if(response&&response.status!==504&&response.status!==502){
  throw new Error(saveError(response.status));
 }
 // A separate five-second budget bounds reconciliation after the sixty-second write.
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5_000);
 try{
  const read=await request('/v1/admin/module-visibility?'+new URLSearchParams({q:target.account,page:'1'}),{signal:controller.signal});
  if(read.ok){
   const data=VisibilityPeopleResponseSchema.parse(await read.json());
   const person=data.people.find(item=>item.userId===target.userId);
   if(person&&person.version>input.version&&person.visibleModules.length===input.visibleModules.length&&input.visibleModules.every(key=>person.visibleModules.includes(key))&&(input.statisticsViewGranted===undefined||person.statisticsViewGranted===input.statisticsViewGranted)){
    return {person,reconciled:true};
   }
  }
 }catch{/* Do not turn an unavailable read into a false claim that the save failed. */}
 finally{clearTimeout(timer);}
 throw new Error(unconfirmed);
}
