import type {FastifyInstance,FastifyRequest} from 'fastify';
import {ADMIN_READ_WRITE_ROUTES} from '../shared/admin-request-timing';

export function registerAdminRequestDiagnostics(app:FastifyInstance){
 const timings=new WeakMap<FastifyRequest,{started:number;authenticatedMs:number|null;readyMs:number|null;logged:boolean}>();
 app.addHook('onRoute',route=>{
  if(!ADMIN_READ_WRITE_ROUTES.has(route.url))return;
  route.handlerTimeout=60_000;
  const previous=route.preHandler?(Array.isArray(route.preHandler)?route.preHandler:[route.preHandler]):[];
  // Route hooks run after the shared session-authentication preHandler hooks.
  route.preHandler=[...previous,async request=>{const state=timings.get(request);if(state)state.authenticatedMs=Math.round(performance.now()-state.started);}];
 });
 app.addHook('onRequest',async(request,reply)=>{
  const route=request.routeOptions.url;
  if(!route||!ADMIN_READ_WRITE_ROUTES.has(route))return;
  const state={started:performance.now(),authenticatedMs:null as number|null,readyMs:null as number|null,logged:false};timings.set(request,state);
  reply.raw.once('close',()=>{
   if(!reply.raw.writableFinished&&!state.logged){state.logged=true;request.log.warn({event:'admin-service-timing',requestId:request.id,route,method:request.method,outcome:'connection-closed',preHandlerMs:state.authenticatedMs,responseReadyMs:state.readyMs,totalMs:Math.round(performance.now()-state.started)},'Management response connection closed');}
  });
 });
 app.addHook('onSend',async(request,_reply,payload)=>{const state=timings.get(request);if(state&&state.readyMs===null)state.readyMs=Math.round(performance.now()-state.started);return payload;});
 app.addHook('onResponse',async(request,reply)=>{
  const state=timings.get(request);if(!state||state.logged)return;state.logged=true;
  request.log.info({event:'admin-service-timing',requestId:request.id,route:request.routeOptions.url,method:request.method,status:reply.statusCode,outcome:'completed',preHandlerMs:state.authenticatedMs,responseReadyMs:state.readyMs,totalMs:Math.round(performance.now()-state.started)},'Management request timing');
 });
}
