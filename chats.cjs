const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'data');fs.mkdirSync(root,{recursive:true});
const file=path.join(root,'chats.json');let records={};
const settingsFile=path.join(root,'settings.json');let settings={};
try{settings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Не удалось прочитать настройки. Файл оставлен без изменений.');}
try{records=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Не удалось прочитать сохранённые чаты. Файл оставлен без изменений.');}
function list(){return Object.values(records).sort((a,b)=>b.updatedAt-a.updatedAt);}
function save(chat){
 if(!chat||typeof chat.id!=='string'||!(/^[a-f0-9-]{36}$/i.test(chat.id))||typeof chat.model!=='string'||chat.model.length>200)throw Error('Некорректный чат');
 if(!Array.isArray(chat.messages)||chat.messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.content!=='string'))throw Error('Некорректные сообщения');
 const old=records[chat.id];
 const value={id:chat.id,model:chat.model,title:chat.messages.find(m=>m.role==='user')?.content.slice(0,70)||'Новый чат',messages:chat.messages,createdAt:old?.createdAt||Date.now(),updatedAt:Date.now()};
 const next={...records,[chat.id]:value};
 fs.writeFileSync(file+'.tmp',JSON.stringify(next,null,2));fs.renameSync(file+'.tmp',file);records=next;return value;
}
function savePrompt(model,prompt){if(typeof model!=='string'||model.length>200||typeof prompt!=='string'||prompt.length>32000)throw Error('Некорректный промпт');const next={...settings,[model]:prompt};fs.writeFileSync(settingsFile+'.tmp',JSON.stringify(next,null,2));fs.renameSync(settingsFile+'.tmp',settingsFile);settings=next;return {ok:true};}
module.exports={list,save,settings:()=>settings,savePrompt};
