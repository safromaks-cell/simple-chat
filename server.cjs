const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {Readable}=require('node:stream'),library=require('./library.cjs'),gpu=require('./gpu.cjs');
const PORT=8791,DEFAULT='jaahas/qwen3.5-uncensored:9b';
const webOnly=process.argv.includes('--web-only');
const chats=require('./chats.cjs');
const network=require('./network.cjs');
const context=require('./context.cjs');
const memory=context.create({call:async(route,data,signal)=>{const r=await fetch(gpu.url+route,{method:'POST',signal,headers:{...gpu.headers,'Content-Type':'application/json'},body:JSON.stringify(data)});if(!r.ok)throw Error(await r.text());return r.json();}});
function json(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>16*1024*1024)throw Error('Слишком длинный запрос (больше 16 МБ)');}return JSON.parse(text||'{}');}
const server=http.createServer(async(req,res)=>{
 if(!network.inNetwork(req)||!network.hostAllowed(req.headers.host,PORT))return json(res,403,{error:'Доступ только из локальной сети'});
 if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return json(res,403,{error:'Forbidden origin'});
 try{
  if(req.url==='/'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return fs.createReadStream(path.join(__dirname,'index.html')).pipe(res);}
  if(req.url==='/app.js'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});return fs.createReadStream(path.join(__dirname,'app.js')).pipe(res);}
  if(req.url==='/api/status'&&req.method==='GET'){const s=await library.status();return json(res,200,{...s,models:s.models.map(m=>({...m,contextSize:context.limit(m.name)})),gpu:gpu.status(),webOnly,default:DEFAULT,network:network.info(req,PORT)});}
  if(req.url==='/api/chats'&&req.method==='GET')return json(res,200,chats.list());
  if(req.url==='/api/chats'&&req.method==='POST')return json(res,200,chats.save(await body(req)));
  if(req.url==='/api/settings'&&req.method==='GET')return json(res,200,chats.settings());
  if(req.url==='/api/settings'&&req.method==='POST'){const d=await body(req);return json(res,200,chats.savePrompt(d.model,d.prompt));}
  if(req.url==='/api/download'&&req.method==='POST'){const d=await body(req);if(typeof d.url!=='string')throw Error('Вставь ссылку');return json(res,200,await library.enqueue(d.url));}
  if(req.url==='/api/retry'&&req.method==='POST')return json(res,200,library.retry((await body(req)).id));
  if(req.url==='/api/load'&&req.method==='POST'){const d=await body(req);if(webOnly&&d.manual!==true)return json(res,409,{error:'Запущен только веб-интерфейс. Обнови страницу и нажми «Загрузить на GPU», чтобы загрузить модель вручную.'});await gpu.queue(()=>gpu.load(d.model));return json(res,200,gpu.status());}
  if(req.url!=='/api/chat'||req.method!=='POST')return json(res,404,{error:'Not found'});
  const d=await body(req),model=d.model||DEFAULT;
  if(d.systemPrompt!==undefined&&(typeof d.systemPrompt!=='string'||d.systemPrompt.length>32000))throw Error('Системный промпт должен быть текстом до 32000 символов');
  if(!Array.isArray(d.messages)||!d.messages.length||d.messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.content!=='string'))throw Error('Некорректные сообщения');
  if(!(await library.status()).models.some(m=>m.name===model))throw Error('Модель ещё не скачана');
  const abort=new AbortController();res.on('close',()=>{if(!res.writableFinished)abort.abort();});
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store'});res.flushHeaders();
  const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': ожидание\n\n');},15000);
  try{await gpu.queue(async()=>{
   if(abort.signal.aborted)return;await gpu.load(model,abort.signal);
   const prepared=await memory.prepare({id:d.chatId,model,messages:d.messages,system:d.systemPrompt,capacity:gpu.status().contextSize,signal:abort.signal,notify:info=>res.write('data: '+JSON.stringify({context:info})+'\n\n')});
   const r=await fetch(gpu.url+'/v1/chat/completions',{method:'POST',signal:abort.signal,headers:{...gpu.headers,'Content-Type':'application/json'},body:JSON.stringify({model,messages:prepared.messages,stream:true,max_tokens:prepared.maxTokens,temperature:.8,timings_per_token:true,stream_options:{include_usage:true},chat_template_kwargs:{enable_thinking:false}})});
   if(!r.ok)throw Error(await r.text());
   for await(const c of Readable.fromWeb(r.body)){if(abort.signal.aborted)break;res.write(c);}res.end();
  });}finally{clearInterval(heartbeat);}
 }catch(e){if(res.destroyed)return;if(res.headersSent)res.end('data: '+JSON.stringify({error:e.message})+'\n\n');else json(res,400,{error:e.message});}
});
server.listen(PORT,'0.0.0.0',()=>{console.log(`Qwen Chat: http://127.0.0.1:${PORT} (LAN enabled)`);library.run();library.enqueue('https://ollama.com/jaahas/qwen3.5-uncensored:9b').catch(e=>console.error(e.message));});
server.on('error',e=>{console.error(e.message);process.exit(1);});
process.on('SIGINT',async()=>{await gpu.stop();process.exit(0);});
