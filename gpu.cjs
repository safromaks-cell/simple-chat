const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),library=require('./library.cjs');
const context=require('./context.cjs');
let child=null,current=null,state={status:'Выбери модель',mode:'CUDA · все слои GPU'},logs='',sequence=Promise.resolve();
const url='http://127.0.0.1:8792';
const key=require('node:crypto').randomBytes(32).toString('hex');
const headers={Authorization:'Bearer '+key};
function queue(action){const next=sequence.then(action,action);sequence=next.catch(()=>{});return next;}
async function stop(){if(child){const old=child;child=null;if(old.exitCode===null)await new Promise(resolve=>{old.once('close',resolve);old.kill();});}current=null;}
async function load(model,signal){
 if(current===model&&child&&child.exitCode===null)return;
 await stop();if(signal?.aborted)throw Error('Остановлено');
 const modelPath=await library.modelPath(model);let capacity=context.limit(model),cache='q8_0';
 for(;;){try{return await launch(model,modelPath,capacity,cache,signal);}catch(e){
  if(signal?.aborted)throw e;
  if(cache==='q8_0'&&/(unsupported|not supported|invalid).*(cache|quantiz)|(cache|quantiz).*(unsupported|not supported|invalid)/i.test(e.message)){cache='f16';capacity=Math.max(4096,capacity/2);continue;}
  if(capacity>4096&&/alloc|memory|out of|cuda.*error/i.test(e.message)){capacity=Math.max(4096,capacity/2);continue;}
  throw e;
 }}
}
async function launch(model,modelPath,capacity,cache,signal){
 state={status:'Загружаем веса на GPU…',model,mode:'CUDA · все слои GPU'};
 const exe=path.join(__dirname,'runtime','llama-server.exe');
 const logfile=fs.createWriteStream(path.join(__dirname,'gpu-runtime.log'),{flags:'w'});logs='';
 child=spawn(exe,['--model',modelPath,'--host','127.0.0.1','--port','8792','--api-key',key,'--device','CUDA0','--n-gpu-layers','all','--fit','off','--ctx-size',String(capacity),'--cache-type-k',cache,'--cache-type-v',cache,'--parallel','1','--batch-size','128','--ubatch-size','64','--flash-attn','on','--jinja','--reasoning-budget','0','--no-warmup','--log-verbosity','4'],{windowsHide:true,cwd:path.dirname(exe),env:{...process.env,GGML_CUDA_FORCE_MMQ:'1'}});
 const running=child;let spawnError;
 running.on('error',e=>spawnError=e);
 const capture=c=>{const text=c.toString().replaceAll(key,'[redacted]');logs=(logs+text).slice(-100000);logfile.write(text);};running.stdout.on('data',capture);running.stderr.on('data',capture);running.once('close',()=>logfile.end());
 try{
  const deadline=Date.now()+15*60*1000;
  while(Date.now()<deadline){
   if(signal?.aborted)throw Error('Остановлено');if(spawnError)throw spawnError;
   if(running.exitCode!==null)throw Error('CUDA не смог загрузить модель. CPU fallback отключён. '+logs.slice(-1500));
   try{const r=await fetch(url+'/health',{headers,signal:AbortSignal.timeout(2000)});if(r.ok){const m=[...logs.matchAll(/offloaded\s+(\d+)\/(\d+)\s+layers to GPU/gi)].at(-1);if(!m||m[1]!==m[2])throw Error('Не все слои на GPU. CPU fallback запрещён.');current=model;state={status:'Готово · '+m[1]+'/'+m[2]+' слоёв GPU',model,mode:'CUDA · все слои GPU',gpuLayers:Number(m[1]),contextSize:capacity,requestedContext:context.limit(model),kvCache:cache};return;}}catch(e){if(e.message.includes('CPU fallback'))throw e;}
   await new Promise(resolve=>setTimeout(resolve,500));
  }throw Error('Загрузка GPU превысила 15 минут');
 }catch(e){await stop();state={status:'Ошибка загрузки GPU',error:e.message,model,mode:'CUDA · CPU fallback отключён'};throw e;}
}
module.exports={queue,load,status:()=>state,url,headers,stop};
