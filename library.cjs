const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn,execFileSync} = require('node:child_process');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const root = path.join(__dirname,'models');
fs.mkdirSync(root,{recursive:true});
const statePath=path.join(root,'library.json');
let hfToken='';
const tokenPath=path.join(__dirname,'credentials','hf-token.dpapi');
if(fs.existsSync(tokenPath)){
  try{hfToken=execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop'; $s=Get-Content -LiteralPath '${tokenPath.replaceAll("'","''")}' | ConvertTo-SecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)} finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}`],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')}}).trim();}catch{console.error('Could not read protected HF token');}
}
const hfHeaders=()=>hfToken?{Authorization:'Bearer '+hfToken}:{};
let jobs=[];
try{jobs=JSON.parse(fs.readFileSync(statePath,'utf8'));}catch{}
for(const job of jobs) if(!['ready','error'].includes(job.state)) job.state='queued';
let working=false;
const persist=()=>{fs.writeFileSync(statePath+'.tmp',JSON.stringify(jobs,null,2));fs.renameSync(statePath+'.tmp',statePath);};
async function api(url,options){const r=await fetch('http://127.0.0.1:11434'+url,options);if(!r.ok)throw Error(await r.text());return r;}
async function tags(){return (await (await api('/api/tags')).json()).models||[];}
function validPart(value){return /^[\w.-]+$/.test(value)&&!['.','..'].includes(value);}
async function inspect(link,depth=0){
  let url;try{url=new URL(link);}catch{throw Error('Вставь ссылку https://huggingface.co/автор/модель или https://ollama.com/автор/модель.');}
  if(url.protocol!=='https:'||url.username||url.password||url.port)throw Error('Нужна обычная HTTPS-ссылка на Hugging Face или Ollama.');
  const parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if(url.hostname==='ollama.com'){
    if(parts[0]==='library')parts.shift();
    const model=parts.join('/');
    if(!/^[\w.-]+(?:\/[\w.-]+)?(?::[\w.-]+)?$/.test(model))throw Error('Некорректная ссылка Ollama.');
    const name=model.includes(':')?model:model+':latest';
    return {kind:'ollama',model:name,title:name,source:link};
  }
  if(url.hostname!=='huggingface.co'||parts.length<2||!parts.slice(0,2).every(validPart))throw Error('Поддерживаются ссылки на Hugging Face и Ollama.');
  const repo=parts.slice(0,2).join('/');
  let revision='main',exact='';
  if(['blob','resolve','tree'].includes(parts[2])){revision=parts[3];if(!revision||!validPart(revision))throw Error('Некорректная ревизия.');exact=parts.slice(4).join('/');}
  else if(parts.length>2)throw Error('Вставь ссылку на репозиторий или конкретный GGUF-файл.');
  const metadata=await fetch(`https://huggingface.co/api/models/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`,{headers:hfHeaders()});
  if(!metadata.ok)throw Error(metadata.status===401||metadata.status===403?'Модель требует авторизации Hugging Face. Пока поддерживаются публичные модели.':'Не удалось прочитать репозиторий: HTTP '+metadata.status);
  const data=await metadata.json();
  let files=(data.siblings||[]).filter(f=>/\.gguf$/i.test(f.rfilename)&&!/(^|\/)(mmproj|imatrix)|plus-mtp|vision|projector|adapter/i.test(f.rfilename)&&f.size>100*1024*1024);
  if(exact&&parts[2]!=='tree')files=files.filter(f=>f.rfilename===exact);
  if(!files.length){
    if(depth===0){
      const readme=await fetch(`https://huggingface.co/${repo}/raw/${data.sha}/README.md`,{headers:hfHeaders()});
      if(readme.ok){const text=await readme.text();const counterpart=repo+'-GGUF';if(text.includes(counterpart)){const result=await inspect('https://huggingface.co/'+counterpart,1);return {...result,source:link,convertedSource:'https://huggingface.co/'+counterpart};}}
    }
    throw Error('Здесь нет GGUF и не указан GGUF-репозиторий автора. Нужна ссылка на GGUF этой же модели.');
  }
  const score=f=>/Q4_K_M/i.test(f.rfilename)?0:/IQ4_XS/i.test(f.rfilename)?1:/Q4_K_S/i.test(f.rfilename)?2:/Q5_K_M/i.test(f.rfilename)?3:10;
  files.sort((a,b)=>score(a)-score(b)||a.size-b.size);
  const choice=files[0];
  const split=choice.rfilename.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
  const selected=split?(data.siblings||[]).filter(f=>f.rfilename.startsWith(split[1]+'-')&&f.rfilename.endsWith('-of-'+split[3]+'.gguf')).sort((a,b)=>a.rfilename.localeCompare(b.rfilename)):[choice];
  if(split&&selected.length!==Number(split[3]))throw Error('Не все части разделённого GGUF доступны.');
  const size=selected.reduce((a,f)=>a+f.size,0);
  if(size>os.totalmem()*.8)throw Error('Модель слишком большая для доступной оперативной памяти. Выбери ссылку на меньшую квантизацию.');
  const id=crypto.createHash('sha256').update(repo+'@'+data.sha+'@'+choice.rfilename).digest('hex').slice(0,12);
  const model='hf-'+repo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,60)+'-'+id+':latest';
  return {kind:'hf',id,repo,revision:data.sha,files:selected,size,model,title:repo.split('/')[1]+' · '+(/(IQ\d_\w+|Q\d_K_[MS]|Q\d_\d|BF16|F16)/i.exec(choice.rfilename)?.[0]||'GGUF'),source:link};
}
async function enqueue(link){
  const item=await inspect(link);
  let existing=jobs.find(j=>j.model===item.model);
  if(existing){if(existing.state==='error'){existing.state='queued';existing.error=null;persist();run();}return existing;}
  const job={...item,id:item.id||crypto.randomUUID(),state:'queued',status:'В очереди',completed:0};
  jobs.push(job);persist();run();return job;
}
async function download(job,file,directory){
  const name=path.basename(file.rfilename);if(!name||name.includes('"'))throw Error('Некорректное имя файла.');
  const target=path.join(directory,name),partial=target+'.partial';
  if(fs.existsSync(target)&&fs.statSync(target).size===file.size){await verify(target,file);return target;}
  const offset=fs.existsSync(partial)?fs.statSync(partial).size:0;
  if(offset===file.size){await verify(partial,file);fs.renameSync(partial,target);return target;}
  const response=await fetch(`https://huggingface.co/${job.repo}/resolve/${job.revision}/${file.rfilename.split('/').map(encodeURIComponent).join('/')}?download=true`,{headers:{...hfHeaders(),...(offset?{Range:`bytes=${offset}-`}:{})}});
  if(!response.ok)throw Error('Ошибка скачивания: HTTP '+response.status);
  const resume=offset>0&&response.status===206;
  const start=resume?offset:0;
  let received=start;
  const base=job.files.slice(0,job.files.indexOf(file)).reduce((a,f)=>a+f.size,0);
  const stream=Readable.fromWeb(response.body);
  stream.on('data',chunk=>{received+=chunk.length;job.completed=base+received;});
  await pipeline(stream,fs.createWriteStream(partial,{flags:resume?'a':'w'}));
  if(fs.statSync(partial).size!==file.size)throw Error('Неполная загрузка. Нажми «Повторить», чтобы продолжить.');
  job.status='Проверяем SHA-256';await verify(partial,file);fs.renameSync(partial,target);return target;
}
async function verify(file,meta){
  if(!meta.lfs?.sha256)return;
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  if(hash.digest('hex')!==meta.lfs.sha256){fs.renameSync(file,file+'.corrupt-'+Date.now());throw Error('SHA-256 не совпал. Повреждённый файл сохранён отдельно. Повтори загрузку.');}
}
async function processJob(job){
  const found=(await tags()).find(m=>m.name===job.model);if(found){job.state='ready';job.status='Готово';job.size=found.size;job.completed=found.size;return;}
  if(job.kind==='ollama'){
    job.state='downloading';
    const response=await api('/api/pull',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:job.model,stream:true})});
    let buffer='';for await(const chunk of Readable.fromWeb(response.body)){buffer+=chunk.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const data=JSON.parse(line);if(data.error)throw Error(data.error);job.status=data.status;if(data.total&&data.total>=(job.size||0)){job.completed=data.completed||0;job.size=data.total;}}}
  }else{
    const directory=path.join(root,job.id);fs.mkdirSync(directory,{recursive:true});
    const disk=fs.statfsSync(root);const free=Number(disk.bavail)*Number(disk.bsize);
    if(free<job.size+5e9)throw Error('Недостаточно места на диске: нужен запас под GGUF.');
    job.state='downloading';job.status='Скачиваем GGUF';
    const paths=[];for(const file of job.files)paths.push(await download(job,file,directory));
    job.path=paths[0];
  }
  if(job.kind==='ollama'){const installed=(await tags()).find(m=>m.name===job.model);if(!installed)throw Error('Модель не появилась в Ollama после загрузки.');job.size=installed.size;job.completed=installed.size;}
  job.state='ready';job.status='Готово';job.error=null;
}
async function run(){
  if(working)return;working=true;
  try{for(;;){const job=jobs.find(j=>j.state==='queued');if(!job)break;try{await processJob(job);}catch(e){job.state='error';job.error=e.message;job.status='Ошибка';}persist();}}
  finally{working=false;}
}
function retry(id){const job=jobs.find(j=>j.id===id);if(!job)throw Error('Загрузка не найдена');if(job.state==='error'){job.state='queued';job.error=null;persist();run();}return job;}
async function status(){const models=await tags();const displayJobs=jobs.map(j=>{const installed=j.kind==='ollama'&&models.find(m=>m.name===j.model);return installed&&j.state==='ready'?{...j,size:installed.size,completed:installed.size}:j;});return {jobs:displayJobs,models:[...models.map(m=>({name:m.name,size:m.size,title:jobs.find(j=>j.model===m.name)?.title||m.name})),...jobs.filter(j=>j.kind==='hf'&&j.state==='ready').map(j=>({name:j.model,size:j.size,title:j.title}))],ram:os.totalmem(),freeRam:os.freemem()};}
async function modelPath(model){
  const job=jobs.find(j=>j.model===model&&j.state==='ready');
  if(job?.path)return job.path;
  if(!(await tags()).some(m=>m.name===model))throw Error('Модель не скачана');
  const data=await (await api('/api/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model})})).json();
  const match=data.modelfile?.match(/^FROM\s+(.+)$/m);if(!match)throw Error('Не найден GGUF модели');
  const target=match[1].trim().replace(/^"|"$/g,'');if(!fs.existsSync(target))throw Error('GGUF модели недоступен: '+target);
  return target;
}
module.exports={enqueue,status,retry,run,modelPath};
