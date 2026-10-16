'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {Engine,chatInference}=require('./engine.cjs');
const engine=new Engine({infer:chatInference}),PORT=8793;
const json=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>1024*1024)throw Error('Запрос больше 1 МБ');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
async function models(){const r=await fetch('http://127.0.0.1:8791/api/status',{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('Чат недоступен');const d=await r.json();return {models:d.models,gpu:d.gpu};}
const server=http.createServer(async(req,res)=>{
 const host=req.headers.host;if(!['127.0.0.1:'+PORT,'localhost:'+PORT].includes(host))return json(res,403,{error:'Invalid host'});
 if(req.method==='POST'&&req.headers.origin!=='http://'+host)return json(res,403,{error:'Откройте локальную панель для управления'});
 res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'");res.setHeader('X-Content-Type-Options','nosniff');
 try{
  if(req.method==='GET'&&['/','/app.js'].includes(req.url)){res.setHeader('Content-Type',req.url==='/'?'text/html; charset=utf-8':'application/javascript; charset=utf-8');return fs.createReadStream(path.join(__dirname,req.url==='/'?'index.html':'app.js')).pipe(res);}
  if(req.url==='/api/state'&&req.method==='GET')return json(res,200,engine.snapshot());
  if(req.url==='/api/models'&&req.method==='GET')return json(res,200,await models());
  if(req.method!=='POST')return json(res,404,{error:'Not found'});
  const d=await body(req);
  switch(req.url){
   case '/api/config':{const available=(await models()).models.map(m=>m.name);if(!Array.isArray(d.models)||d.models.some(m=>!available.includes(m)))throw Error('Модель недоступна');engine.configure(d);break;}
   case '/api/start':{const available=(await models()).models.map(m=>m.name);if(engine.state.config.models.some(m=>!available.includes(m)))throw Error('Выбранная модель недоступна');engine.start();break;}
   case '/api/stop':engine.stop();break;
   case '/api/tasks':engine.addTask(d);break;
   case '/api/retry':engine.retry(d.id);break;
   case '/api/run':return json(res,200,{result:engine.runTool(d.id,d.input)});
   case '/api/rollback':engine.rollback(d.id,d.version);break;
   default:return json(res,404,{error:'Not found'});
  }
  return json(res,200,engine.snapshot());
 }catch(e){json(res,400,{error:e.message});}
});
server.listen(PORT,'127.0.0.1',()=>console.log('Autonomy: http://127.0.0.1:'+PORT));
server.on('error',e=>{console.error(e);process.exit(1);});
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{engine.stop();server.close();setTimeout(()=>process.exit(),1500).unref();});
