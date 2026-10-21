import {createAgentService} from '../../server/agent-service';
import {loadAgentConfig} from '../../server/config';
if(process.env.AGENT_SERVICE_PORT!=='33901'||!process.env.AGENT_DATABASE_URL?.endsWith('/amazon_de_ca_formalbase_20261021'))throw new Error('Candidate only');
try{
 const service=await createAgentService({logger:true});
 await service.start(loadAgentConfig());
 console.log('Candidate boot diagnostic succeeded');
 await service.stop();
}catch(error){
 let detail=error instanceof Error?`${error.name}: ${error.message}\n${error.stack}`:'Unknown startup error';
 for(const [key,value] of Object.entries(process.env))if(value&&value.length>=8&&/KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL/.test(key))detail=detail.replaceAll(value,'[redacted]');
 console.error(detail);process.exitCode=1;
}
