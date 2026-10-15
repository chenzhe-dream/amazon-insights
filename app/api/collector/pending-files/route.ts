import path from 'node:path';
import JSZip from 'jszip';
import {createAgentServiceClient} from '../../../lib/agent-service-client';
import {SessionResponseSchema} from '../../../../shared/agent-contracts';
import {createPendingHandler} from '../../../lib/collector-pending-receiver.mjs';

export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handle(request:Request){
 if(process.env.COLLECTOR_PENDING_UPLOAD_ENABLED!=='true'||String(process.env.PORT)!=='32900')return Response.json({error:'待导入接收尚未启用'},{status:503});
 const dataRoot=process.env.AGENT_DATA_ROOT;if(!dataRoot)return Response.json({error:'缺少文件存储配置'},{status:503});
 const response=await createPendingHandler({root:path.join(dataRoot,'collector-pending-files'),JSZip,authenticate:async(req:Request)=>{
  const headers=new Headers();const cookie=req.headers.get('cookie');if(cookie)headers.set('cookie',cookie);headers.set('origin',new URL(req.url).origin);
  const result=await createAgentServiceClient()({method:'GET',path:'/v1/auth/session',headers});
  if(result.status!==200)throw Object.assign(Error('登录状态暂时无法验证'),{status:503});const parsed=SessionResponseSchema.safeParse(result.body);
  if(!parsed.success)throw Object.assign(Error('登录状态暂时无法验证'),{status:503});
  return parsed.success&&parsed.data.authenticated?parsed.data.user:null;
 }})(request);
 if(request.method==='GET'&&new URL(request.url).searchParams.get('view')==='upload'&&response.ok){
  return new Response(uploadPage,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
 }
 return response;
}
const uploadPage=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>待导入文件接收验证</title>
<style>body{font:16px system-ui;color:#24344d;background:#f4f7fc;max-width:950px;margin:48px auto;padding:24px}main{background:white;border:1px solid #dde5f1;border-radius:12px;padding:28px}label{display:block;margin:20px 0 6px}input{width:95%;padding:10px}button{padding:12px 18px;margin:20px 10px 0 0;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f7fc;padding:16px}</style>
<main><h1>待导入文件接收验证 · 32900</h1><p>文件仅保存为待导入。不会启动分析或调用 MCP。</p>
<form id="upload"><label for="file">Excel 文件</label><input id="file" type="file" accept=".xlsx" required>
<label for="job">任务编号（重试请保持相同）</label><input id="job" required pattern="[-A-Za-z0-9_]{1,100}">
<label for="hash">原文件 SHA-256</label><input id="hash" required pattern="[a-fA-F0-9]{64}">
<button type="submit">上传为待导入文件</button><button id="list" type="button">查看已保存回执</button></form><pre id="result" role="status">请选择文件。</pre></main>
<script>const form=document.getElementById('upload'),result=document.getElementById('result');
form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button[type=submit]');button.disabled=true;result.textContent='正在上传并校验原文件…';try{const file=document.getElementById('file').files[0],job=document.getElementById('job').value,hash=document.getElementById('hash').value.toLowerCase(),body=new FormData();body.set('file',file);body.set('jobId',job);body.set('sha256',hash);body.set('intakeMode','pending-import');body.set('autoImport','false');const r=await fetch(location.pathname,{method:'POST',headers:{'Idempotency-Key':job+':'+hash},body});result.textContent='HTTP '+r.status+'\\n'+JSON.stringify(await r.json(),null,2);}catch(error){result.textContent='上传失败：'+error.message;}finally{button.disabled=false;}});
document.getElementById('list').addEventListener('click',async()=>{try{const r=await fetch(location.pathname,{cache:'no-store'});result.textContent='HTTP '+r.status+'\\n'+JSON.stringify(await r.json(),null,2);}catch(error){result.textContent='读取失败：'+error.message;}});</script></html>`;
export const POST=handle;
export const GET=handle;
