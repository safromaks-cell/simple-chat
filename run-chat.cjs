const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const data=path.join(__dirname,'data');fs.mkdirSync(data,{recursive:true});
const lock=path.join(data,'supervisor.pid');
if(fs.existsSync(lock)){
 const pid=Number(fs.readFileSync(lock,'utf8'));
 if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);process.exit(0);}catch(e){if(e.code!=='ESRCH')throw e;}}
 fs.unlinkSync(lock);
}
try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});}catch(e){if(e.code==='EEXIST')process.exit(0);throw e;}
process.on('exit',()=>{try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}});
function available(){return new Promise(resolve=>{const req=http.get('http://127.0.0.1:8791/',res=>{res.resume();resolve(res.statusCode===200);});req.setTimeout(3000,()=>req.destroy());req.on('error',()=>resolve(false));});}
async function run(){
 if(await available()){setTimeout(run,5000);return;}
 const out=fs.openSync(path.join(__dirname,'server.log'),'a'),err=fs.openSync(path.join(__dirname,'server-error.log'),'a');
 let closed=false;const retry=()=>{if(closed)return;closed=true;fs.closeSync(out);fs.closeSync(err);setTimeout(run,5000);};
 try{const child=spawn(process.execPath,[path.join(__dirname,'server.cjs'),...process.argv.slice(2)],{cwd:__dirname,windowsHide:true,stdio:['ignore',out,err]});child.once('error',retry);child.once('close',retry);}catch{retry();}
}
run();
