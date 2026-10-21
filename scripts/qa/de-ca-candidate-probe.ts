import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {openRuntimeAgentRepository} from '../../server/db/open-runtime-repository';
import {loadAgentStorageConfig,loadVocPositioningRuntimeConfig} from '../../server/config';
import {hashPassword} from '../../server/auth/password';
import {requestSorftimeMcp,readSorftimeKey} from '../lib/sorftime-mcp-client.mjs';

const db=new URL(process.env.AGENT_DATABASE_URL??'');
if(db.hostname!=='127.0.0.1'||db.port!=='64733'||db.pathname!=='/amazon_de_ca_formalbase_20261021'||process.env.AGENT_SERVICE_PORT!=='33901')throw new Error('Isolated DE/CA candidate environment required');
const root=path.resolve(process.env.AGENT_RUNTIME_ROOT!,'..');
const repository=await openRuntimeAgentRepository(loadAgentStorageConfig());
try {
 const org='22222222-2222-4222-8222-222222222222';
 const authPath=path.join(root,'qa-login.json');
 if(!fs.existsSync(authPath)){
  const password=randomBytes(24).toString('base64url');
  const user=await repository.createLocalUser!({id:randomUUID(),organizationId:org,email:'de-ca-candidate@local.invalid',displayName:'DE CA Candidate QA',passwordHash:await hashPassword(password),role:'admin',status:'active',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  if(!user.created)throw new Error('Candidate QA account already exists without local login artifact');
  fs.writeFileSync(authPath,JSON.stringify({email:user.user.email,password,organizationId:org,userId:user.user.id}));
 }
 const config=loadVocPositioningRuntimeConfig();
 console.log(JSON.stringify({database:db.pathname.slice(1),runtime:root,model:config.model.name,synthetic:process.env.AGENT_VOC_LOCAL_FAKE==='1',credentials:{sorftime:!!process.env.SORFTIME_MCP_KEY,sif:!!process.env.SIF_MCP_SECRET,sellerSprite:!!process.env.SELLERSPRITE_SECRET_KEY},accountReady:true}));
 const schema=await requestSorftimeMcp(readSorftimeKey(),'tools/list',{}, {env:process.env,requireResourceGovernor:false,emitDiagnostics:false});
 const result=(schema as {tools?:{name:string;description?:string;inputSchema?:unknown}[]});
 fs.writeFileSync(path.join(root,'evidence','sorftime-tools.json'),JSON.stringify(result??schema,null,2));
 console.log(JSON.stringify({discovery:true,tools:result?.tools?.filter(x=>['product_detail','product_review_analysis','product_customers_say','product_search_from_name'].includes(x.name)).map(x=>({name:x.name,inputSchema:x.inputSchema}))}));
 if(process.env.DE_CA_DISCOVER_CA==='1'){
  const search=await requestSorftimeMcp(readSorftimeKey(),'tools/call',{name:'product_search_from_name',arguments:{name:'balance board',query_type:1,page:1,amz_site:'CA'}},{env:process.env,requireResourceGovernor:false,emitDiagnostics:false});
  fs.writeFileSync(path.join(root,'evidence','ca-cohort-discovery.json'),JSON.stringify({request:{name:'product_search_from_name',arguments:{name:'balance board',query_type:1,page:1,amz_site:'CA'}},response:search},null,2));
  console.log('CA_SEARCH '+JSON.stringify(search).slice(0,6000));
 }
}finally{await repository.close();}
