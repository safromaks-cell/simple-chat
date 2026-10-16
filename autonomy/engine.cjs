'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const tool=require('./tools.cjs'),seeds=require('./curriculum.cjs');
function save(file,value){fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2));fs.renameSync(file+'.tmp',file);}
function testsValid(tests){if(!Array.isArray(tests)||tests.length<2||tests.length>40||tests.some(t=>!t||!Object.hasOwn(t,'input')||!Object.hasOwn(t,'expected')))throw Error('Нужно 2–40 эталонных тестов input/expected');if(JSON.stringify(tests).length>100000)throw Error('Тесты слишком большие');}
function complexity(steps){return steps.reduce((n,s)=>n+1+(s.steps?complexity(s.steps):0),0);}
class Engine{
 constructor({directory=path.join(__dirname,'data'),infer}={}){
  this.directory=directory;fs.mkdirSync(directory,{recursive:true});this.file=path.join(directory,'state.json');this.infer=infer;this.controller=null;this.timer=null;this.busy=false;
  this.state={schema:1,config:{models:[],reviewer:'',intervalSeconds:60,requestTimeoutSeconds:600,maxAttempts:3},running:false,status:'Остановлено',cycles:0,consecutiveErrors:0,tasks:structuredClone(seeds).map(t=>({...t,state:'pending',attempts:0})),registry:{},metrics:{},events:[],lessons:[]};
  if(fs.existsSync(this.file)){const s=JSON.parse(fs.readFileSync(this.file,'utf8'));if(s.schema!==1)throw Error('Неизвестная версия state.json');this.state=s;for(const t of s.tasks)if(t.state==='working')t.state='pending';s.running=false;s.status='Остановлено после перезапуска';}
  this.persist();
 }
 persist(){save(this.file,this.state);}
 event(type,message){this.state.events.push({at:new Date().toISOString(),type,message:String(message).slice(0,3000)});this.state.events=this.state.events.slice(-150);this.persist();}
 snapshot(){return {...this.state,busy:this.busy};}
 configure(d){
  if(this.busy||this.state.running)throw Error('Сначала остановите цикл');
  if(!Array.isArray(d.models)||!d.models.length||d.models.length>10||d.models.some(m=>typeof m!=='string'))throw Error('Выберите 1–10 моделей');
  for(const [k,min,max] of [['intervalSeconds',10,3600],['requestTimeoutSeconds',30,1800],['maxAttempts',1,6]])if(!Number.isInteger(d[k])||d[k]<min||d[k]>max)throw Error(k+': '+min+'–'+max);
  if(typeof d.reviewer!=='string'||(d.reviewer&&!d.models.includes(d.reviewer)))throw Error('Проверяющий должен быть среди выбранных моделей');
  this.state.config={models:[...new Set(d.models)],reviewer:d.reviewer,intervalSeconds:d.intervalSeconds,requestTimeoutSeconds:d.requestTimeoutSeconds,maxAttempts:d.maxAttempts};this.persist();
 }
 addTask(d){
  if(typeof d.title!=='string'||!d.title.trim()||d.title.length>120||typeof d.description!=='string'||!d.description.trim()||d.description.length>6000)throw Error('Нужны title и description');
  testsValid(d.tests);if(this.state.tasks.length>=200)throw Error('Лимит 200 задач');
  const t={id:crypto.randomUUID(),title:d.title,description:d.description,tests:d.tests,state:'pending',attempts:0};this.state.tasks.push(t);this.event('task','Добавлена задача: '+t.title);return t;
 }
 retry(id){const t=this.state.tasks.find(t=>t.id===id);if(!t)throw Error('Задача не найдена');if(t.state==='working')throw Error('Задача выполняется');t.state='pending';t.attempts=0;this.persist();}
 start(){if(this.state.running)return;if(this.busy)throw Error('Остановка ещё выполняется');if(!this.state.config.models.length)throw Error('Выберите модели');this.state.running=true;this.state.consecutiveErrors=0;this.event('start','Цикл включён');this.schedule(0);}
 stop(){this.state.running=false;clearTimeout(this.timer);this.controller?.abort();this.state.status=this.busy?'Останавливаем запрос…':'Остановлено';this.event('stop','Остановка запрошена');}
 schedule(ms){clearTimeout(this.timer);if(this.state.running)this.timer=setTimeout(()=>this.tick().catch(e=>{this.state.running=false;this.event('fatal',e.stack);}),ms);}
 choose(){const models=this.state.config.models;return [...models].sort((a,b)=>{const x=this.state.metrics[a]||{},y=this.state.metrics[b]||{};const sx=(x.successes||0)*2-(x.failures||0)-(x.calls||0)*.1;const sy=(y.successes||0)*2-(y.failures||0)-(y.calls||0)*.1;return sy-sx;})[0];}
 async call(model,messages,signal){
  const m=this.state.metrics[model]??={calls:0,successes:0,failures:0,totalMs:0};m.calls++;this.persist();const time=Date.now();
  try{const result=await this.infer({model,messages,signal,timeoutSeconds:this.state.config.requestTimeoutSeconds});if(signal.aborted)throw Error('Остановлено');return result;}finally{m.totalMs+=Date.now()-time;this.persist();}
 }
 async tick(){
  if(!this.state.running||this.busy)return;
  this.busy=true;this.controller=new AbortController();const signal=this.controller.signal;
  const task=this.state.tasks.find(t=>t.state==='pending');let model;
  try{
   if(!task){this.audit();this.state.status='Все задачи обработаны. Ждём новые; проверяем сохранённые инструменты.';this.persist();return;}
   task.state='working';task.attempts++;this.state.cycles++;model=this.choose();this.state.status='Создаём: '+task.title;this.event('cycle',task.title+' · '+model+' · попытка '+task.attempts);
   const current=this.state.registry[task.id]?.versions.find(v=>v.id===this.state.registry[task.id]?.active);
   const system=`Ты создаёшь инструменты обработки данных. Верни только JSON {"name":"...","description":"...","steps":[...],"lesson":"..."}. Инструмент — декларативный pipeline, не JavaScript. Разрешены только: trim, lower, upper; split/join с separator; replace с from/to (буквальная замена всех вхождений); parse_json, stringify; get/pluck с key; filter_eq с key/value (строгое равенство JSON); sort с mode numeric или lex; unique; sum; count; map с steps. Все шаги последовательны. Никаких shell, eval, сетевых запросов. Максимум 24 шага на уровень, глубина 3. Примеры: {"op":"map","steps":[{"op":"trim"}]}, {"op":"filter_eq","key":"active","value":true}. Пустая строка split превращается в [""]; уникальность по JSON. Не меняй задачу или эталонные ответы.`;
   const publicExamples=task.tests.slice(0,Math.max(1,Math.floor(task.tests.length/2)));
   const user=JSON.stringify({task:task.description,examples:publicExamples,current:current?.steps,previousFailure:task.lastError,lessons:this.state.lessons.slice(-8)});
   let candidate=tool.parse(await this.call(model,[{role:'system',content:system},{role:'user',content:user}],signal));tool.validate(candidate.steps);
   const reviewer=this.state.config.reviewer;
   if(reviewer){
    this.state.status='Проверяющая модель: '+task.title;this.persist();
    const review=tool.parse(await this.call(reviewer,[{role:'system',content:system+' Проверь предложенный pipeline и верни исправленный или тот же JSON. Рассмотри пустой вход, типы, порядок операций.'},{role:'user',content:JSON.stringify({task:task.description,examples:publicExamples,candidate})}],signal));tool.validate(review.steps);candidate=review;
   }
   if(signal.aborted)throw Error('Остановлено');
   const results=tool.evaluate(candidate.steps,task.tests),pass=results.filter(r=>r.ok).length;
   const auditDir=path.join(this.directory,'attempts');fs.mkdirSync(auditDir,{recursive:true});const artifact=crypto.randomUUID();save(path.join(auditDir,artifact+'.json'),{at:new Date().toISOString(),taskId:task.id,model,reviewer,candidate,results});
   // Every candidate is evaluated against owner-supplied fixtures, never model-generated tests.
   if(pass!==results.length){throw Error('Эталонные тесты: '+pass+'/'+results.length+'. '+JSON.stringify(results.filter(r=>!r.ok)));}
   this.state.metrics[model].successes++;this.state.consecutiveErrors=0;
   const reg=this.state.registry[task.id]??={title:task.title,active:null,versions:[]};
   const cost=complexity(candidate.steps),identical=current&&JSON.stringify(current.steps)===JSON.stringify(candidate.steps);
   if(!current||(!identical&&cost<complexity(current.steps))){
    const version={id:crypto.randomUUID(),at:new Date().toISOString(),model,reviewer,steps:candidate.steps,description:typeof candidate.description==='string'?candidate.description.slice(0,1000):task.description,testsPassed:pass,cost};reg.versions.push(version);reg.active=version.id;this.event('promote',task.title+': все '+pass+' тестов прошли, версия '+reg.versions.length+', операций '+cost);
   }else this.event('retain',task.title+': тесты прошли, текущая версия не сложнее; оставлена');
   task.state='done';task.lastError=null;this.state.lessons.push({task:task.title,model,note:typeof candidate.lesson==='string'?candidate.lesson.slice(0,1000):'Pipeline прошёл эталонные тесты',at:new Date().toISOString()});this.state.lessons=this.state.lessons.slice(-100);
  }catch(e){
   if(task){task.lastError=e.message.slice(0,3000);task.state=signal.aborted?'pending':task.attempts>=this.state.config.maxAttempts?'failed':'pending';}
   if(signal.aborted&&task)task.attempts--;if(!signal.aborted){if(model)this.state.metrics[model].failures++;this.state.consecutiveErrors++;this.event('error',e.message);if(this.state.consecutiveErrors>=3){this.state.running=false;this.event('pause','Три ошибки подряд. Цикл остановлен; проверьте журнал и нажмите «Запустить».');}}
  }finally{
   this.busy=false;this.controller=null;if(!this.state.running)this.state.status='Остановлено';this.persist();this.schedule(this.state.config.intervalSeconds*1000);
  }
 }
 audit(){for(const [id,reg] of Object.entries(this.state.registry)){const task=this.state.tasks.find(t=>t.id===id),v=reg.versions.find(v=>v.id===reg.active);if(v&&task&&tool.evaluate(v.steps,task.tests).some(t=>!t.ok)){reg.active=null;task.state='failed';this.event('audit','Инструмент отключён после провала регрессии: '+task.title);}}}
 runTool(id,input){const r=this.state.registry[id],v=r?.versions.find(v=>v.id===r.active);if(!v)throw Error('Активный инструмент не найден');return tool.execute(v.steps,input);}
 rollback(id,version){const r=this.state.registry[id],v=r?.versions.find(v=>v.id===version),task=this.state.tasks.find(t=>t.id===id);if(!v||!task)throw Error('Версия не найдена');if(tool.evaluate(v.steps,task.tests).some(t=>!t.ok))throw Error('Версия не проходит регрессию');r.active=v.id;this.event('rollback','Выбрана версия '+v.id+' для '+task.title);}
}
async function chatInference({model,messages,signal,timeoutSeconds}){
 const timeout=AbortSignal.timeout(timeoutSeconds*1000),combined=AbortSignal.any([signal,timeout]);
 const response=await fetch('http://127.0.0.1:8791/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:combined,body:JSON.stringify({model,systemPrompt:messages[0].content,messages:messages.slice(1)})});
 if(!response.ok)throw Error(await response.text());
 let buffer='',output='',done=false;const decoder=new TextDecoder();
 const consume=line=>{if(!line.startsWith('data:'))return;const data=line.slice(5).trim();if(data==='[DONE]'){done=true;return;}if(!data)return;const d=JSON.parse(data);if(d.error)throw Error(typeof d.error==='string'?d.error:JSON.stringify(d.error));const delta=d.choices?.[0]?.delta?.content;if(delta)output+=delta;if(output.length>100000)throw Error('Ответ превышает 100000 символов');};
 const reader=response.body.getReader();try{for(;;){const {value,done:finished}=await reader.read();if(finished)break;buffer+=decoder.decode(value,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,i).trimEnd());buffer=buffer.slice(i+1);}if(buffer.length>100000)throw Error('Слишком большое событие SSE');}buffer+=decoder.decode();if(buffer.trim())consume(buffer.trimEnd());}finally{await reader.cancel().catch(()=>{});}
 if(!done||!output.trim())throw Error('Поток завершился без полного ответа');return output;
}
module.exports={Engine,chatInference,complexity};

