import {loadVocPositioningRuntimeConfig} from "../../server/config";
import assert from 'node:assert/strict';import {Pool} from 'pg';import fs from 'node:fs';import path from 'node:path';
assert.equal(new URL(process.env.AGENT_DATABASE_URL!).pathname,'/amazon_de_ca_formalbase_20261021');assert.equal(process.env.AGENT_SERVICE_PORT,'33901');
const pool=new Pool({connectionString:process.env.AGENT_DATABASE_URL});
try{
 const agent=await pool.query('SELECT id,run_id,model,response_id,input_tokens,output_tokens,validation_status,error_json,output_json IS NULL AS output_absent,started_at,completed_at FROM agent_runs WHERE id=$1',['deefda82-60ac-4a46-ae7c-78707e988630']);
 const attempts=await pool.query('SELECT attempt_kind,request_ordinal,response_id,actual_input_tokens,actual_output_tokens,projected_output_tokens,state,dispatched_at,settled_at FROM model_budget_reservations WHERE run_id=$1 ORDER BY dispatched_at',['485ff5cc-5828-45d2-a020-307bbab2dd03']);
 const config=loadVocPositioningRuntimeConfig();const evidence={transport:config.transport,model:config.model.name,maxOutputTokens:config.model.maxOutputTokens,agent:agent.rows,attempts:attempts.rows};const root=path.resolve(process.env.AGENT_RUNTIME_ROOT!,'..');fs.writeFileSync(path.join(root,'evidence','DE-model-diagnostic.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await pool.end();}
