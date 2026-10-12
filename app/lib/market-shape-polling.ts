/** Null means stop automatic polling and keep the last successful report visible. */
export function shapePollingDelay(failures:number,error:unknown):number|null{
 const status=typeof error==='object'&&error!==null&&'status' in error?error.status:undefined;
 if(status===401||status===403||status===404||failures>=5)return null;
 return [4000,8000,16000,30000][Math.max(0,failures-1)]??30000;
}
