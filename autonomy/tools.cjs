'use strict';
const assert=require('node:assert/strict');
const OPS=['trim','lower','upper','split','join','replace','parse_json','stringify','get','pluck','filter_eq','sort','unique','sum','count','map'];
const LIMIT=1024*1024;
function bounded(x){const s=JSON.stringify(x);if(s===undefined||s.length>LIMIT)throw Error('Результат не JSON или превышает 1 МБ');return x;}
function key(k){if(typeof k!=='string'||k.length>120||['__proto__','constructor','prototype'].includes(k))throw Error('Недопустимый ключ');return k;}
function validate(steps,depth=0){
 if(depth>3||!Array.isArray(steps)||!steps.length||steps.length>24)throw Error('Нужен pipeline из 1–24 шагов; вложенность до 3');
 for(const s of steps){
  if(!s||!OPS.includes(s.op))throw Error('Неизвестная операция: '+s?.op);
  if(['get','pluck','filter_eq'].includes(s.op))key(s.key);
  if(['split','join'].includes(s.op)&&(typeof s.separator!=='string'||s.separator.length>100))throw Error('separator должен быть строкой');
  if(s.op==='replace'&&(typeof s.from!=='string'||!s.from||typeof s.to!=='string'||s.from.length>1000||s.to.length>1000))throw Error('replace требует непустой from и строковый to');
  if(s.op==='sort'&&s.mode!==undefined&&!['numeric','lex'].includes(s.mode))throw Error('sort.mode: numeric или lex');
  if(s.op==='map')validate(s.steps,depth+1);
 }
 return steps;
}
function execute(steps,input){
 validate(steps);bounded(input);let budget=100000;
 function run(list,value){
  for(const s of list){
   if(--budget<0)throw Error('Лимит операций');
   const arr=()=>{if(!Array.isArray(value)||value.length>10000)throw Error(s.op+': нужен массив до 10000 элементов');return value;};
   const str=()=>{if(typeof value!=='string')throw Error(s.op+': нужна строка');return value;};
   const field=(v,k)=>{if(v===null||typeof v!=='object'||!Object.hasOwn(v,k))throw Error('Нет поля '+k);return v[k];};
   switch(s.op){
    case 'trim':value=str().trim();break;
    case 'lower':value=str().toLowerCase();break;
    case 'upper':value=str().toUpperCase();break;
    case 'split':value=str().split(s.separator);break;
    case 'join':value=arr().join(s.separator);break;
    case 'replace':value=str().split(s.from).join(s.to);break;
    case 'parse_json':value=JSON.parse(str());break;
    case 'stringify':value=JSON.stringify(value);break;
    case 'get':value=field(value,s.key);break;
    case 'pluck':value=arr().map(v=>field(v,s.key));break;
    case 'filter_eq':value=arr().filter(v=>v&&Object.hasOwn(v,s.key)&&JSON.stringify(v[s.key])===JSON.stringify(s.value));break;
    case 'sort':value=[...arr()].sort(s.mode==='numeric'?(a,b)=>{if(typeof a!=='number'||typeof b!=='number')throw Error('Числовая сортировка требует числа');return a-b;}:undefined);break;
    case 'unique':{const seen=new Set();value=arr().filter(v=>{const k=JSON.stringify(v);if(seen.has(k))return false;seen.add(k);return true;});break;}
    case 'sum':value=arr().reduce((a,v)=>{if(typeof v!=='number'||!Number.isFinite(v))throw Error('sum требует конечные числа');return a+v;},0);if(!Number.isFinite(value))throw Error('Переполнение');break;
    case 'count':if(typeof value!=='string'&&!Array.isArray(value))throw Error('count требует строку или массив');value=value.length;break;
    case 'map':value=arr().map(v=>run(s.steps,v));break;
   }
   bounded(value);
  }
  return value;
 }
 return run(steps,input);
}
function evaluate(steps,tests){return tests.map((t,i)=>{try{const actual=execute(steps,t.input);assert.deepStrictEqual(actual,t.expected);return {i,ok:true};}catch(e){return {i,ok:false,error:e.message.slice(0,1500)};}});}
function parse(text){
 if(typeof text!=='string'||text.length>100000)throw Error('Некорректный ответ модели');
 const clean=text.replace(/<think>[\s\S]*?<\/think>/g,'').trim();
 try{return JSON.parse(clean);}catch{}
 const start=clean.indexOf('{');if(start<0)throw Error('Модель не вернула JSON');
 let depth=0,quote=false,escape=false;
 for(let i=start;i<clean.length;i++){const c=clean[i];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quote=false;}else if(c==='"')quote=true;else if(c==='{')depth++;else if(c==='}'&&!--depth)return JSON.parse(clean.slice(start,i+1));}
 throw Error('Неполный JSON');
}
module.exports={OPS,validate,execute,evaluate,parse};

