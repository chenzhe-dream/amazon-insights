import {mkdir,mkdtemp,readFile,writeFile,readdir,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const MAX=25*1024*1024,hash=b=>createHash('sha256').update(b).digest('hex');
const failure=(status,message)=>Object.assign(new Error(message),{status});
function zipBudget(b){
 let end=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0)throw failure(422,'不是有效的XLSX压缩包');
 const count=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),start=b.readUInt32LE(end+16);
 if(count>12000||start+size>end||b.readUInt16LE(end+4)||b.readUInt16LE(end+6))throw failure(422,'不支持的XLSX结构');
 let pos=start,total=0;
 for(let i=0;i<count;i++){
  if(pos+46>end||b.readUInt32LE(pos)!==0x02014b50)throw failure(422,'XLSX目录损坏');
  const nameLen=b.readUInt16LE(pos+28),extra=b.readUInt16LE(pos+30),comment=b.readUInt16LE(pos+32),n=b.subarray(pos+46,pos+46+nameLen).toString('utf8');
  total+=b.readUInt32LE(pos+24);if(total>150*1024*1024||n.includes('..')||n.startsWith('/')||n.includes('\\')||/vbaProject\.bin$/i.test(n))throw failure(422,'XLSX内容超出允许范围');
  pos+=46+nameLen+extra+comment;
 }if(pos!==start+size)throw failure(422,'XLSX目录不一致');
}
async function boundedForm(request){
 if(Number(request.headers.get('content-length'))>MAX+65536)throw failure(413,'文件超过25MB');
 if(!request.body)throw failure(400,'缺少上传内容');const reader=request.body.getReader(),chunks=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX+65536){await reader.cancel();throw failure(413,'文件超过25MB');}chunks.push(Buffer.from(value));}
 try{return await new Response(Buffer.concat(chunks),{headers:{'content-type':request.headers.get('content-type')||''}}).formData();}catch{throw failure(400,'上传格式无效');}
}
export function createPendingHandler({root,authenticate,JSZip}){
 const base=path.resolve(root);
 return async request=>{
  try{
   if(!['GET','POST'].includes(request.method))return Response.json({error:'Method not allowed'},{status:405});
   if(request.method==='POST'&&request.headers.get('origin')!==new URL(request.url).origin)throw failure(403,'请求来源不匹配');
   const user=await authenticate(request);if(!user?.id)throw failure(401,'请先登录');
   if(request.method==='GET'){
    const dirs=await readdir(base,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});const files=[];
    for(const d of dirs){if(!d.isDirectory()||!/^file-[a-f0-9]{64}$/.test(d.name))continue;const r=JSON.parse(await readFile(path.join(base,d.name,'receipt.json'),'utf8'));if(r.ownerId===user.id){const {ownerId,...safe}=r;files.push(safe);}}
    return Response.json({files:files.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))},{headers:{'Cache-Control':'no-store'}});
   }
   const form=await boundedForm(request),file=form.get('file'),jobId=form.get('jobId'),expected=form.get('sha256');
   if(form.get('intakeMode')!=='pending-import'||form.get('autoImport')!=='false')throw failure(400,'此入口只保存待导入文件');
   if(typeof jobId!=='string'||!/^[-\w]{1,100}$/.test(jobId)||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||!file||typeof file.arrayBuffer!=='function'||!file.name.toLowerCase().endsWith('.xlsx'))throw failure(400,'上传字段无效');
   if(file.size>MAX)throw failure(413,'文件超过25MB');const bytes=Buffer.from(await file.arrayBuffer());if(hash(bytes)!==expected)throw failure(422,'文件校验值不匹配');
   if(request.headers.get('Idempotency-Key')!==jobId+':'+expected)throw failure(400,'缺少匹配的幂等编号');
   zipBudget(bytes);let archive;try{archive=await JSZip.loadAsync(bytes,{checkCRC32:true});}catch{throw failure(422,'XLSX压缩包校验失败');}
   if(!['[Content_Types].xml','xl/workbook.xml','_rels/.rels'].every(n=>archive.file(n)))throw failure(422,'XLSX缺少工作簿结构');
   const artifactId='file-'+hash(JSON.stringify([user.id,jobId,expected])),destination=path.join(base,artifactId);
   await mkdir(base,{recursive:true});
   const existing=async()=>{const r=JSON.parse(await readFile(path.join(destination,'receipt.json'),'utf8'));if(r.sha256!==expected||r.ownerId!==user.id||hash(await readFile(path.join(destination,'original.xlsx')))!==expected)throw failure(500,'已保存文件校验失败');return r;};
   let receipt;try{receipt=await existing();}catch(e){if(e.code!=='ENOENT')throw e;}
   if(!receipt){
    receipt={status:'stored',artifactId,sha256:expected,intakeStatus:'pending-import',importStarted:false,ownerId:user.id,jobId,filename:file.name.split(/[\\/]/).pop().slice(0,180),bytes:bytes.length,createdAt:new Date().toISOString()};
    const temporary=await mkdtemp(path.join(base,'.upload-'));
    try{await writeFile(path.join(temporary,'original.xlsx'),bytes,{flag:'wx'});await writeFile(path.join(temporary,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'});try{await rename(temporary,destination);}catch(e){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(e.code))throw e;receipt=await existing();}}
    finally{if(path.dirname(path.resolve(temporary))!==base||!path.basename(temporary).startsWith('.upload-'))throw failure(500,'临时存储路径异常');await rm(temporary,{recursive:true,force:true});}
   }
   const {ownerId,...safe}=receipt;return Response.json(safe,{headers:{'Cache-Control':'no-store'}});
  }catch(e){return Response.json({error:e.status?e.message:'待导入文件保存失败'},{status:e.status||500});}
 };
}
