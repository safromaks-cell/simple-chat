'use strict';
const $=id=>document.getElementById(id);let state,available=[],loaded=false,polling=false;
function el(tag,text,cls){const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;}
async function api(route,data){const r=await fetch('/api/'+route,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
async function action(fn){try{$('notice').textContent='';await fn();await refresh();}catch(e){$('notice').textContent=e.message;}}
function button(text,fn){const b=el('button',text);b.onclick=()=>action(fn);return b;}
function initModels(){
 $('models').replaceChildren();$('reviewer').replaceChildren(new Option('Только эталонные тесты',''));
 const defaultModel=available.find(m=>/qwen.*9b/i.test(m.name));
 for(const m of available){const l=el('label');const input=el('input');input.type='checkbox';input.value=m.name;input.checked=state.config.models.length?state.config.models.includes(m.name):m.name===defaultModel?.name;l.append(input,document.createTextNode(m.title+' · '+(m.size/1e9).toFixed(1)+' ГБ'));$('models').append(l);$('reviewer').add(new Option(m.title,m.name));}
 $('reviewer').value=state.config.reviewer;$('interval').value=state.config.intervalSeconds;$('timeout').value=state.config.requestTimeoutSeconds;$('attempts').value=state.config.maxAttempts;loaded=true;
}
async function saveConfig(){return api('config',{models:[...$('models').querySelectorAll('input:checked')].map(x=>x.value),reviewer:$('reviewer').value,intervalSeconds:Number($('interval').value),requestTimeoutSeconds:Number($('timeout').value),maxAttempts:Number($('attempts').value)});}
async function refresh(){
 if(polling)return;polling=true;try{
 state=await api('state');if(!loaded){try{const d=await api('models');available=d.models;$('gpu').textContent='GPU: '+d.gpu.status;initModels();}catch(e){$('notice').textContent='Сначала запустите обычный чат. '+e.message;}}
 $('status').textContent=state.status;$('cycles').textContent='Циклов: '+state.cycles+' · '+(state.running?'включён':'остановлен');$('start').disabled=state.running||state.busy;$('save').disabled=state.running||state.busy;
 const selected=$('tool').value;$('tool').replaceChildren();$('tasks').replaceChildren();
 const labels={pending:'Ожидает',working:'В работе',done:'Готово',failed:'Ошибка'};
 for(const t of state.tasks){const row=el('div',undefined,'task');row.append(el('strong',t.title),el('div',labels[t.state]+' · попыток '+t.attempts,'muted'));
 const r=state.registry[t.id];if(r?.active){$('tool').add(new Option(t.title,t.id));const version=r.versions.find(v=>v.id===r.active);row.append(el('div',version.testsPassed+' тестов · операций '+version.cost,'badge'));const detail=el('details');detail.append(el('summary','Pipeline и версии'),el('pre',JSON.stringify(version.steps,null,2)));for(const v of r.versions)detail.append(button('Версия '+(r.versions.indexOf(v)+1)+(v.id===r.active?' · активна':''),()=>api('rollback',{id:t.id,version:v.id})));row.append(detail);}
 if(t.state!=='working')row.append(button(t.state==='done'?'Попробовать улучшить':'Повторить',()=>api('retry',{id:t.id})));
 if(t.lastError){const detail=el('details');detail.append(el('summary','Причина ошибки'),el('pre',t.lastError,'error'));row.append(detail);}$('tasks').append(row);}
 if([...$('tool').options].some(o=>o.value===selected))$('tool').value=selected;
 $('events').replaceChildren(...state.events.slice(-25).reverse().map(e=>el('p',new Date(e.at).toLocaleTimeString()+' · '+e.message,'muted')));
 $('metrics').textContent=Object.entries(state.metrics).map(([name,m])=>name+'\n  ответов: '+m.calls+' · успешных кандидатов: '+m.successes+' · ошибок автора: '+m.failures+' · время: '+Math.round(m.totalMs/1000)+' с').join('\n\n')||'Пока нет попыток';
 $('lessons').replaceChildren(...state.lessons.slice(-6).reverse().map(l=>el('p',l.task+': '+l.note,'muted')));
 }catch(e){$('notice').textContent=e.message;}finally{polling=false;}
}
$('save').onclick=()=>action(saveConfig);$('start').onclick=()=>action(async()=>{await saveConfig();await api('start',{});});$('stop').onclick=()=>action(()=>api('stop',{}));
$('add').onclick=()=>action(()=>api('tasks',{title:$('title').value,description:$('description').value,tests:JSON.parse($('tests').value)}));
$('run').onclick=()=>action(async()=>{const d=await api('run',{id:$('tool').value,input:JSON.parse($('input').value)});$('result').textContent=JSON.stringify(d.result,null,2);});
refresh();setInterval(refresh,2500);
