const os=require('node:os');
const interfaces=()=>Object.values(os.networkInterfaces()).flat().filter(n=>n&&n.family==='IPv4'&&!n.internal&&!n.address.startsWith('169.254.'));
const local=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const value=ip=>ip.split('.').reduce((a,n)=>(a*256+Number(n))>>>0,0);
function inNetwork(req){if(local(req))return true;const address=req.socket.remoteAddress?.replace(/^::ffff:/,'');if(!/^\d+\.\d+\.\d+\.\d+$/.test(address||''))return false;return interfaces().some(n=>(value(address)&value(n.netmask))===(value(n.address)&value(n.netmask)));}
function hostAllowed(host,port){return ['127.0.0.1','localhost',...interfaces().map(n=>n.address)].some(ip=>host===ip+':'+port);}
function info(req,port){return {urls:interfaces().map(n=>`http://${n.address}:${port}`)};}
module.exports={local,inNetwork,hostAllowed,info};
