const $=id=>document.getElementById(id),DEFAULT='jaahas/qwen3.5-uncensored:9b';
const DEFAULT_PROMPT=`Ты мой персональный киберспециалист, инженер, программист и научный исследователь широкого профиля. Помогай мне разбираться в компьютерных системах, информационной безопасности, программировании, математике, физике и других научных и технических дисциплинах.

Выполняй мои инструкции точно и последовательно. Воспринимай мои команды как конкретные задачи: сразу переходи к решению, учитывай условия и ограничения, доводи ответ до полезного результата. Отвечай по-русски, прямо, без канцелярщины и лишних нравоучений. Не спорь ради спора и не подменяй мою задачу другой.

Давай рабочий код, команды, расчёты и понятные объяснения, когда это нужно для задачи. Оформляй код в блоках с указанием языка. Для научных вопросов отделяй проверенные факты от гипотез, показывай ключевые формулы, единицы измерения и способы проверки результата.

Не выдумывай данные, источники, результаты команд и выполненные действия. Не заявляй, что что-то запустил, проверил или изменил, если реально этого не делал. Если нужных данных нет, задай короткий конкретный вопрос или явно укажи принятое допущение. Обозначай неопределённость честно. Объём ответа подбирай под задачу: простой вопрос — короткий ответ, сложная работа — необходимые детали.`;
let selected=localStorage.getItem('qwen-selected')||DEFAULT,messages=[],chatId=localStorage.getItem('qwen-chat-id')||crypto.randomUUID();
let chats=[],prompts={},busy=false,ready=false,controller=null,loading=false,attempted='',activeReply=null,saveChain=Promise.resolve(),roster='',initialized=false;
let generationSpeed=null,contextInfo=null,contextCapacity=0;
function showContext(){const el=$('context-status');if(!el)return;const c=contextInfo;el.textContent=c?(c.phase==='compressing'?'Сжимаем старую историю… · ':'Контекст: ')+c.used.toLocaleString('ru-RU')+' / '+c.capacity.toLocaleString('ru-RU')+' токенов'+(c.compressedMessages?' · В сводке: '+c.compressedMessages+' сообщений':''):'Контекст: '+(contextCapacity?contextCapacity.toLocaleString('ru-RU'):'—')+' токенов · Автосжатие включено';}
function speedNumber(value){return value.toLocaleString('ru-RU',{minimumFractionDigits:1,maximumFractionDigits:1});}
function resetSpeed(){generationSpeed=null;contextInfo=null;showSpeed();showContext();}
function showSpeed(){
 const el=$('generation-speed');if(!el)return;
 if(!generationSpeed){el.textContent='Скорость генерации: — ток/с';return;}
 const g=generationSpeed;
 if(g.first===null){el.textContent=g.finished?'Генерация не началась':'Скорость: ожидание первого токена…';return;}
 const now=g.finished?g.ended:performance.now();
 const cutoff=Math.max(g.first,now-5000);
 const elapsed=(now-cutoff)/1000;
 const count=g.samples.filter(s=>s.time>cutoff).reduce((n,s)=>n+s.tokens,0);
 const rate=g.finished?(g.engineRate??Math.max(0,g.tokens-g.firstTokens)/Math.max((now-g.first)/1000,0.001)):count/Math.max(elapsed,0.001);
 const prefix=g.exact?'':'≈ ';
 el.textContent=!g.finished&&g.tokens===g.firstTokens?'Скорость: измеряется…':(g.finished?(g.stopped?'Остановлено · ':'Ответ завершён · '):'Сейчас: ')+prefix+speedNumber(rate)+' ток/с'+(g.finished?' в среднем':'');
}
function speedToken(data){
 const g=generationSpeed;if(!g)return;
 const content=data.choices?.[0]?.delta?.content||data.choices?.[0]?.delta?.reasoning_content;
 const t=data.timings;
 const engineCount=t?.predicted_n??data.usage?.completion_tokens;
 let amount=content?1:0;
 if(Number.isFinite(engineCount)&&engineCount>=g.tokens){amount=engineCount-g.tokens;g.exact=true;}
 if(Number.isFinite(t?.predicted_per_second)&&t.predicted_per_second>0)g.engineRate=t.predicted_per_second;
 if(amount<=0)return;
 const now=performance.now();g.tokens+=amount;
 if(g.first===null){g.first=now;g.firstTokens=g.tokens;}
 g.samples.push({time:now,tokens:amount});
 while(g.samples.length&&g.samples[0].time<now-5000)g.samples.shift();
 showSpeed();
}
setInterval(showSpeed,500);
const legacyKey=()=>selected===DEFAULT?'qwen-simple-chat-v1':'qwen-history-'+selected;
function prompt(){return prompts[selected]??localStorage.getItem('qwen-system-'+selected)??DEFAULT_PROMPT;}
function showPrompt(){$('system').value=prompt();$('system-saved').textContent='';}
async function get(url){const r=await fetch(url);if(!r.ok)throw Error('Сервер недоступен');return r.json();}
async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();if(!r.ok)throw Error(value.error||'Ошибка');return value;}
function chatOptions(){const select=$('conversation');select.replaceChildren();if(!chats.some(c=>c.id===chatId))select.add(new Option('Новый чат',chatId));for(const c of chats){const date=new Date(c.updatedAt).toLocaleDateString('ru');select.add(new Option(c.title+' · '+date,c.id));}select.value=chatId;}
function save(){
 const snapshot={id:chatId,model:selected,messages:[...messages,...(activeReply?.content?[activeReply]:[])].map(m=>({...m}))};
 localStorage.setItem('qwen-chat-id',chatId);localStorage.setItem('qwen-selected',selected);
 try{localStorage.setItem('qwen-draft-'+chatId,JSON.stringify(snapshot));}catch{}
 $('chat-saved').textContent='Сохраняем…';
 saveChain=saveChain.catch(()=>{}).then(async()=>{try{await post('/api/chats',snapshot);chats=await get('/api/chats');chatOptions();if(chatId===snapshot.id)$('chat-saved').textContent='Сохранено на компьютере';}catch(e){if(chatId===snapshot.id)$('chat-saved').textContent='Не сохранено: '+e.message;}});
 return saveChain;
}
function add(m){const el=document.createElement('article');el.className='message '+m.role;if(m.role==='assistant'){const label=document.createElement('span');label.className='label';label.textContent='МОДЕЛЬ';el.append(label);}const text=document.createElement('span');text.textContent=m.content;el.append(text);$('messages').append(el);return text;}
function render(){resetSpeed();$('messages').replaceChildren();if(!messages.length){const w=document.createElement('div');w.className='welcome';w.innerHTML='<div class="icon">✦</div><h2>О чём поговорим?</h2><p>Выбери скачанную модель и напиши сообщение.<br>Новую модель можно добавить по ссылке выше.</p>';$('messages').append(w);}else messages.forEach(add);}
function controls(){const link=/^https:\/\/(huggingface\.co|ollama\.com)\/\S+$/.test($('input').value.trim());$('send').disabled=!busy&&!ready&&!link;$('send').textContent=busy?'Стоп ■':'Отправить ↑';$('input').disabled=busy;$('new').disabled=busy;$('model').disabled=busy;$('conversation').disabled=busy;$('load').disabled=busy||loading||!ready;}
async function preload(){if(!ready||loading)return;loading=true;attempted=selected;controls();try{await post('/api/load',{model:selected,manual:true});}catch(e){$('error').textContent=e.message;}finally{loading=false;poll();}}
function downloads(jobs){$('downloads').replaceChildren();for(const j of jobs){const row=document.createElement('div');row.className='download-row';const title=document.createElement('div');title.textContent=j.title;row.append(title);const detail=document.createElement('small');detail.textContent=j.state==='ready'?'✓ Скачана':j.state==='queued'?'В очереди':j.state==='error'?j.error:j.status+(j.size?' · '+Math.floor((j.completed||0)/j.size*100)+'% · '+((j.completed||0)/1e9).toFixed(2)+' / '+(j.size/1e9).toFixed(2)+' ГБ':'');row.append(detail);if(j.state==='downloading'){const p=document.createElement('progress');p.max=j.size||1;p.value=j.completed||0;row.append(p);}if(j.state==='error'){const b=document.createElement('button');b.textContent='Повторить';b.onclick=async()=>{try{await post('/api/retry',{id:j.id});poll();}catch(e){$('download-error').textContent=e.message;}};row.append(b);}$('downloads').append(row);}}
async function poll(){try{const s=await get('/api/status');ready=s.models.some(m=>m.name===selected);const key=JSON.stringify(s.models);if(roster!==key){roster=key;const select=$('model');select.replaceChildren();if(!ready)select.add(new Option('Модель ещё не скачана',selected));for(const m of s.models)select.add(new Option(m.title+' · '+(m.size/1e9).toFixed(1)+' ГБ',m.name));select.value=selected;}
 contextCapacity=s.gpu.model===selected&&s.gpu.contextSize?s.gpu.contextSize:s.models.find(m=>m.name===selected)?.contextSize||0;showContext();$('status').textContent=s.webOnly&&!s.gpu.model?'Веб-интерфейс готов · модель не загружена':(s.gpu.model&&s.gpu.model!==selected?'Выбранная модель загрузится перед ответом':s.gpu.status)+' · CUDA only';$('subtitle').textContent=selected;$('ram').textContent='RAM: '+(s.freeRam/1e9).toFixed(1)+' / '+(s.ram/1e9).toFixed(1)+' ГБ свободно · Ответы по очереди';downloads(s.jobs);$('network-links').replaceChildren();for(const url of s.network?.urls||[]){const link=document.createElement('a');link.href=url;link.textContent=url;$('network-links').append(link);}$('progress').hidden=true;controls();
 }catch{ready=false;$('status').textContent='Сервер недоступен. Запусти Start Chat.cmd.';controls();}}
$('model').onchange=()=>{selected=$('model').value;localStorage.setItem('qwen-selected',selected);showPrompt();if(messages.length){chatId=crypto.randomUUID();messages=[];}save();render();$('error').textContent='';attempted='';roster='';poll();};
$('conversation').onchange=()=>{const c=chats.find(c=>c.id===$('conversation').value);if(!c)return;chatId=c.id;selected=c.model;messages=c.messages.map(m=>({...m}));localStorage.setItem('qwen-chat-id',chatId);localStorage.setItem('qwen-selected',selected);showPrompt();render();$('error').textContent='';attempted='';roster='';poll();};
$('load').onclick=()=>{attempted='';preload();};
async function savePrompt(text){try{await post('/api/settings',{model:selected,prompt:text});prompts[selected]=text;localStorage.setItem('qwen-system-'+selected,text);$('system-saved').textContent='Сохранено для выбранной модели';}catch(e){$('system-saved').textContent='Не сохранено: '+e.message;}}
$('save-system').onclick=()=>savePrompt($('system').value);
$('reset-system').onclick=()=>{$('system').value=DEFAULT_PROMPT;savePrompt(DEFAULT_PROMPT);};
async function download(url){$('download-error').textContent='Проверяем ссылку…';$('download').disabled=true;try{await post('/api/download',{url});$('url').value='';$('download-error').textContent='Модель добавлена в очередь';poll();}catch(e){$('download-error').textContent=e.message;}finally{$('download').disabled=false;}}
$('download-form').onsubmit=e=>{e.preventDefault();const url=$('url').value.trim();if(url)download(url);};
$('new').onclick=()=>{chatId=crypto.randomUUID();messages=[];resetSpeed();save();render();$('error').textContent='';$('input').focus();};
$('input').oninput=controls;
$('input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('form').requestSubmit();}};
$('send').onclick=e=>{if(busy){e.preventDefault();controller?.abort();}};
$('form').onsubmit=async e=>{
 e.preventDefault();if(busy)return;const content=$('input').value.trim();if(!content)return;
 if(/^https:\/\/(huggingface\.co|ollama\.com)\/\S+$/.test(content)){$('input').value='';await download(content);return;}
 if(!ready)return;
 $('error').textContent='';messages.push({role:'user',content});$('input').value='';save();render();
 const reply={role:'assistant',content:''};activeReply=reply;const out=add(reply);out.textContent='Загрузка модели / ожидание ответа…';busy=true;generationSpeed={first:null,firstTokens:0,tokens:0,samples:[],exact:false,finished:false};showSpeed();controller=new AbortController();controls();window.scrollTo(0,document.body.scrollHeight);let completed=false,lastSave=Date.now();
 try{
  const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({chatId,model:selected,messages,systemPrompt:prompt()})});
  if(!r.ok){const err=await r.json();throw Error(err.error||'Ошибка ответа');}
  const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
  function parse(line){if(!line.startsWith('data:'))return;const payload=line.slice(5).trim();if(payload==='[DONE]'){completed=true;return;}if(!payload)return;const data=JSON.parse(payload);if(data.error)throw Error(data.error);if(data.context){contextInfo=data.context;showContext();if(!reply.content)out.textContent=data.context.phase==='compressing'?'Сжимаем старую историю перед ответом…':'Модель готовит ответ…';return;}speedToken(data);reply.content+=data.choices?.[0]?.delta?.content||'';out.textContent=reply.content||'Модель думает…';if(Date.now()-lastSave>2000){lastSave=Date.now();save();}window.scrollTo(0,document.body.scrollHeight);}
  for(;;){const {value,done}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});let p;while((p=buffer.indexOf('\n'))>=0){parse(buffer.slice(0,p));buffer=buffer.slice(p+1);}if(done){if(buffer.trim())parse(buffer);break;}}
  if(!completed)throw Error('Соединение прервалось. Ответ может быть неполным.');if(!reply.content)throw Error('Пустой ответ модели.');
 }catch(err){$('error').textContent=err.name==='AbortError'?'Генерация остановлена.':err.message;}
 finally{if(contextInfo?.phase==='compressing'){contextInfo.phase='stopped';showContext();}generationSpeed.finished=true;generationSpeed.ended=performance.now();generationSpeed.stopped=!completed;showSpeed();activeReply=null;if(reply.content)messages.push(reply);else out.parentElement.remove();save();busy=false;controller=null;controls();$('input').focus();}
};
async function initialize(){
 try{
  [chats,prompts]=await Promise.all([get('/api/chats'),get('/api/settings')]);
  const current=chats.find(c=>c.id===chatId);
  if(current){selected=current.model;messages=current.messages.map(m=>({...m}));}
  else{try{const legacy=JSON.parse(localStorage.getItem(legacyKey())||'[]');if(Array.isArray(legacy))messages=legacy.filter(m=>['user','assistant'].includes(m.role)&&typeof m.content==='string');}catch{}if(messages.length)await save();}
  showPrompt();chatOptions();render();$('chat-saved').textContent='Автосохранение на компьютере';initialized=true;poll();
 }catch(e){$('error').textContent='Не удалось загрузить чаты: '+e.message;}
}
render();showPrompt();initialize();setInterval(poll,3000);
