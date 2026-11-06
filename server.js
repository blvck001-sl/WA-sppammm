import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const app=express(); app.use(express.json({limit:'16kb'})); app.disable('x-powered-by');
// ============================================================
// WHATSAPP MESSAGE TEST SETTINGS — EDIT THESE VALUES
// ============================================================
// Maximum messages in one authorized test (keep tests bounded).
const MAX_TEST_MESSAGES = 200000;
// Time between individual WhatsApp message submissions, in ms.
// 1000 = 1 second, 2000 = 2 seconds, 5000 = 5 seconds.
const DEFAULT_MESSAGE_DELAY_MS = 500;
// The web dashboard allows delays between these values.
const MIN_MESSAGE_DELAY_MS = 1000;
const MAX_MESSAGE_DELAY_MS = 60000;
// IMPORTANT: Baileys sendMessage() success is NOT proof of delivery.
// Test recipients must be the customer's own paired phone number.
// ============================================================
const ROOT=process.env.DATA_DIR||'/data'; const PORT=Number(process.env.PORT||3000);
const ADMIN_USER=process.env.ADMIN_USER; const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD; const COOKIE_SECRET=process.env.COOKIE_SECRET;
if(!ADMIN_USER||!ADMIN_PASSWORD||!COOKIE_SECRET||ADMIN_PASSWORD.length<16||COOKIE_SECRET.length<32) throw Error('Set ADMIN_USER, ADMIN_PASSWORD (16+ chars), COOKIE_SECRET (32+ chars)');
const customersDir=path.join(ROOT,'customers'); const licensesFile=path.join(ROOT,'licenses.json');
await fs.mkdir(customersDir,{recursive:true});
const read=async(p,defaultValue)=>{try{return JSON.parse(await fs.readFile(p,'utf8'))}catch(e){if(e.code==='ENOENT')return defaultValue;throw e}};
const write=async(p,v)=>{const tmp=p+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(v,null,2),{mode:0o600});await fs.rename(tmp,p)};
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const cookieSign=s=>crypto.createHmac('sha256',COOKIE_SECRET).update(s).digest('hex');
const sessions=new Map(); const runtime=new Map(); const pending=new Map();
const cleanPhone=s=>String(s||'').replace(/\D/g,'');
const messageText=message=>{
  let content=message;
  for(let i=0;i<5;i++){
    const wrapped=content?.ephemeralMessage?.message||content?.viewOnceMessage?.message||content?.viewOnceMessageV2?.message||content?.documentWithCaptionMessage?.message;
    if(!wrapped)break;
    content=wrapped;
  }
  return content?.conversation||content?.extendedTextMessage?.text||content?.imageMessage?.caption||content?.videoMessage?.caption||'';
};
const customerPath=id=>path.join(customersDir,id);
const customerFile=id=>path.join(customerPath(id),'customer.json');
const loadCustomer=id=>read(customerFile(id),null);
const saveCustomer=async c=>write(customerFile(c.id),c);
const valid=c=>c&&c.expiresAt&&Date.now()<Date.parse(c.expiresAt)&&c.active;
const tokenAuth=(req,res,next)=>{const cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')));const t=cookies.auth||'';const [user,expires,sig]=t.split('.');const msg=`${user}.${expires}`;if(!user||!expires||!sig||!equal(cookieSign(msg),sig)||Date.now()>Number(expires)||user!==sha(ADMIN_USER))return res.status(401).json({error:'Admin login required'});next()};
const clientAuth=async(req,res,next)=>{const token=String(req.headers['x-license-key']||'');const db=await read(licensesFile,{});const id=db[sha(token)];if(!id)return res.status(401).json({error:'Invalid license'});const c=await loadCustomer(id);if(!valid(c))return res.status(403).json({error:'License expired or disabled'});req.customer=c;next()};
const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baileys Control</title><style>body{font:15px system-ui;background:#0c111b;color:#edf2ff;margin:0;padding:24px}main{max-width:900px;margin:auto}section{background:#171e2c;border:1px solid #293345;padding:20px;border-radius:14px;margin:14px 0}input,button,select{padding:11px;border-radius:8px;border:1px solid #43506a;background:#101725;color:white;margin:5px 4px 5px 0}button{background:#396df0;border:0;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}h1{letter-spacing:-1px}small{color:#9eabc4}</style></head><body><main><h1>Baileys Control</h1><small>JSON + isolated Railway volume sessions</small><section><h3>Admin login</h3><input id="user" placeholder="Admin username"><input id="pass" type="password" placeholder="Password"><button onclick="login()">Login</button><button onclick="logout()">Logout</button></section><section><h3>Create license</h3><select id="days"><option>15</option><option>20</option><option>30</option><option>60</option></select> days <button onclick="createLicense()">Generate</button><pre id="created"></pre></section><section><h3>Customers</h3><button onclick="list()">Refresh</button><pre id="customers"></pre></section><section><h3>Customer activation / demo</h3><input id="license" placeholder="License key"><input id="phone" placeholder="Phone incl country code"><button onclick="pair()">Request pairing code</button><pre id="pairing"></pre><button onclick="status()">Connection status</button><pre id="status"></pre><h4>Test notification to your own number</h4><input id="target" placeholder="Own test number incl country code"><input id="message" placeholder="Test message" value="Notification test"><input id="count" type="number" min="1" max="${MAX_TEST_MESSAGES}" value="3" style="width:70px"><input id="delay" type="number" min="${MIN_MESSAGE_DELAY_MS}" max="${MAX_MESSAGE_DELAY_MS}" value="${DEFAULT_MESSAGE_DELAY_MS}" style="width:90px"> ms delay <button onclick="test()">Send bounded test</button><pre id="result"></pre></section></main><script>
async function api(url,method='GET',data,license=false){const r=await fetch(url,{method,headers:{'Content-Type':'application/json',...(license?{'x-license-key':document.querySelector('#license').value}:{})},body:data?JSON.stringify(data):undefined});const j=await r.json();if(!r.ok)throw Error(j.error||r.status);return j}
const show=(id,v)=>document.getElementById(id).textContent=JSON.stringify(v,null,2);
async function run(id,fn){try{show(id,await fn())}catch(e){show(id,{error:e.message})}}
function login(){run('created',()=>api('/api/admin/login','POST',{username:user.value,password:pass.value}))}
function logout(){run('created',()=>api('/api/admin/logout','POST'))}
function createLicense(){run('created',()=>api('/api/admin/licenses','POST',{days:Number(days.value)}))}
function list(){run('customers',()=>api('/api/admin/customers'))}
function pair(){run('pairing',()=>api('/api/client/pair','POST',{phone:phone.value},true))}
function status(){run('status',()=>api('/api/client/status','GET',null,true))}
function test(){run('result',()=>api('/api/client/test','POST',{phone:target.value,message:message.value,count:Number(count.value),delayMs:Number(delay.value)},true))}
</script></body></html>`;
app.get('/',(_,res)=>res.type('html').send(html));
app.get('/health',(_,res)=>res.json({ok:true}));
const loginAttempts=new Map();
app.post('/api/admin/login',(req,res)=>{const ip=req.ip;const a=loginAttempts.get(ip)||{count:0,until:0};if(a.until>Date.now())return res.status(429).json({error:'Too many attempts'});if(!equal(String(req.body.username||''),ADMIN_USER)||!equal(String(req.body.password||''),ADMIN_PASSWORD)){a.count++;if(a.count>=5){a.until=Date.now()+15*60_000;a.count=0}loginAttempts.set(ip,a);return res.status(401).json({error:'Invalid credentials'})}loginAttempts.delete(ip);const msg=`${sha(ADMIN_USER)}.${Date.now()+8*3600_000}`;res.setHeader('Set-Cookie',`auth=${msg}.${cookieSign(msg)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV==='production'?'; Secure':''}`);res.json({ok:true})});
app.post('/api/admin/logout',(_,res)=>{res.setHeader('Set-Cookie','auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');res.json({ok:true})});
app.post('/api/admin/licenses',tokenAuth,async(req,res)=>{const days=Number(req.body.days);if(![15,20,30,60].includes(days))return res.status(400).json({error:'Select 15, 20, 30 or 60 days'});const id=crypto.randomUUID();const key='BLY-'+crypto.randomBytes(24).toString('base64url');const c={id,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+days*86400000).toISOString(),active:true,phone:null};await fs.mkdir(customerPath(id),{recursive:true});await saveCustomer(c);const db=await read(licensesFile,{});db[sha(key)]=id;await write(licensesFile,db);res.json({id,license:key,expiresAt:c.expiresAt})});
app.get('/api/admin/customers',tokenAuth,async(_,res)=>{const ids=await fs.readdir(customersDir);const cs=await Promise.all(ids.map(loadCustomer));res.json(cs.filter(Boolean).map(c=>({...c,connected:runtime.get(c.id)?.connected||false}))) });
app.post('/api/admin/customers/:id/revoke',tokenAuth,async(req,res)=>{const c=await loadCustomer(req.params.id);if(!c)return res.sendStatus(404);c.active=false;await saveCustomer(c);await disconnect(c.id);res.json({ok:true})});
app.post('/api/admin/customers/:id/renew',tokenAuth,async(req,res)=>{const c=await loadCustomer(req.params.id);if(!c)return res.sendStatus(404);const days=Number(req.body.days);if(![15,20,30,60].includes(days))return res.status(400).json({error:'Invalid days'});c.expiresAt=new Date(Math.max(Date.now(),Date.parse(c.expiresAt))+days*86400000).toISOString();c.active=true;await saveCustomer(c);res.json({ok:true,expiresAt:c.expiresAt})});
async function disconnect(id){const s=sessions.get(id);if(s){try{s.end(undefined)}catch{}}sessions.delete(id);runtime.set(id,{connected:false})}
async function connect(c){if(sessions.has(c.id))return sessions.get(c.id);const authDir=path.join(customerPath(c.id),'session');await fs.mkdir(authDir,{recursive:true});const {state,saveCreds}=await useMultiFileAuthState(authDir);const {version}=await fetchLatestBaileysVersion();const sock=makeWASocket({auth:state,version,printQRInTerminal:false,markOnlineOnConnect:false,syncFullHistory:false});sessions.set(c.id,sock);runtime.set(c.id,{connected:false});sock.ev.on('creds.update',saveCreds);sock.ev.on('connection.update',async u=>{if(u.connection==='open')runtime.set(c.id,{connected:true});if(u.connection==='close'){sessions.delete(c.id);runtime.set(c.id,{connected:false});const current=await loadCustomer(c.id);if(valid(current)&&u.lastDisconnect?.error?.output?.statusCode!==DisconnectReason.loggedOut)setTimeout(()=>connect(current).catch(console.error),3000)}});
sock.ev.on('messages.upsert',async({messages,type})=>{
if(type!=='notify')return;
const latest=await loadCustomer(c.id);
if(!valid(latest)){await disconnect(c.id);return}
for(const m of messages){
if(!m.message||m.key.fromMe)continue;
const from=m.key.remoteJid;
if(!from||(!from.endsWith('@s.whatsapp.net')&&!from.endsWith('@lid')))continue;
const body=messageText(m.message);
const cmd=body.trim().split(/\s+/)[0]?.toLowerCase();
if(!['.ping','.alive','.spam'].includes(cmd))continue;
// .spam command: bounded test, only the account owner's paired phone.
// Syntax: .spam 2348012345678 5 Hello
if(cmd==='.spam'){
  const parts=body.trim().split(/\s+/);
  const target=cleanPhone(parts[1]);
  const count=Number(parts[2]); // Message count, capped by MAX_TEST_MESSAGES.
  const message=parts.slice(3).join(' ');
  // Reject commands from anyone except the paired account owner.
  if(cleanPhone(from.split('@')[0])!==latest.phone||target!==latest.phone||!Number.isInteger(count)||count<1||count>MAX_TEST_MESSAGES||!message||message.length>500){
    await sock.sendMessage(from,{text:`Usage: .spam <your paired phone> <count 1-${MAX_TEST_MESSAGES}> <message>`});
    continue;
  }
  if(testLocks.has(c.id)){
    await sock.sendMessage(from,{text:'A test is already running.'});
    continue;
  }
  testLocks.add(c.id);
  try{
    let sent=0;
    // Main sending loop: sequential submissions, never an unlimited flood.
    for(let i=0;i<count;i++){
      if(!valid(await loadCustomer(c.id)))break;
      await sock.sendMessage(target+'@s.whatsapp.net',{text:message});
      sent++;
      // Countdown / pacing logic: 1 second between submissions.
      if(i<count-1)await sleep(DEFAULT_MESSAGE_DELAY_MS);
    }
    await sock.sendMessage(from,{text:`Test complete: ${sent}/${count} submitted (delivery not guaranteed).`});
  }catch(err){console.error('Test failed',err);await sock.sendMessage(from,{text:'Test failed; check server logs.'}).catch(console.error)}
  finally{testLocks.delete(c.id)}
  continue;
}
const reply=cmd==='.ping'?'Pong 🏓':'Bot is alive ✅';
await sock.sendMessage(from,{text:reply},{quoted:m}).catch(console.error)
}
}).catch(err=>console.error('Message handler failed',err));
return sock}
app.post('/api/client/pair',clientAuth,async(req,res)=>{const c=req.customer;const phone=cleanPhone(req.body.phone);if(!/^\d{8,15}$/.test(phone))return res.status(400).json({error:'Enter full international phone number'});if(c.phone&&c.phone!==phone)return res.status(403).json({error:'License already bound to another phone; contact admin'});if(!c.phone){c.phone=phone;await saveCustomer(c)}try{const sock=await connect(c);if(sock.authState.creds.registered)return res.json({status:'already paired',connected:runtime.get(c.id)?.connected||false});await new Promise(r=>setTimeout(r,1500));const code=await sock.requestPairingCode(phone);res.json({pairingCode:code,expiresAt:c.expiresAt})}catch(e){res.status(503).json({error:'Pairing unavailable; retry shortly',detail:String(e.message||e)})}});
app.get('/api/client/status',clientAuth,(req,res)=>res.json({connected:runtime.get(req.customer.id)?.connected||false,expiresAt:req.customer.expiresAt,phone:req.customer.phone}));
const testLocks=new Set();const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.post('/api/client/test',clientAuth,async(req,res)=>{const c=req.customer;const phone=cleanPhone(req.body.phone),count=Number(req.body.count),delayMs=Number(req.body.delayMs),message=String(req.body.message||'');if(phone!==c.phone)return res.status(400).json({error:'Testing restricted to the paired demo number'});if(!Number.isInteger(count)||count<1||count>MAX_TEST_MESSAGES||!Number.isInteger(delayMs)||delayMs<MIN_MESSAGE_DELAY_MS||delayMs>MAX_MESSAGE_DELAY_MS||!message||message.length>500)return res.status(400).json({error:`Count 1–${MAX_TEST_MESSAGES}, delay ${MIN_MESSAGE_DELAY_MS}–${MAX_MESSAGE_DELAY_MS}ms, message 1–500 chars`});if(testLocks.has(c.id))return res.status(429).json({error:'A test is already running'});if(!runtime.get(c.id)?.connected)return res.status(409).json({error:'WhatsApp not connected'});testLocks.add(c.id);const timings=[];try{for(let i=0;i<count;i++){if(!valid(await loadCustomer(c.id)))break;const start=Date.now();await sessions.get(c.id).sendMessage(phone+'@s.whatsapp.net',{text:message});timings.push({index:i+1,sendCallMs:Date.now()-start});if(i<count-1)await sleep(delayMs)}res.json({sent:timings.length,timings,note:'sendCallMs measures API submission, not recipient delivery'})}catch(e){res.status(503).json({error:String(e.message||e),timings})}finally{testLocks.delete(c.id)}});
setInterval(async()=>{try{const ids=await fs.readdir(customersDir);for(const id of ids){const c=await loadCustomer(id);if(!valid(c)){if(sessions.has(id))await disconnect(id)}else if(c.phone&&!sessions.has(id))await connect(c).catch(console.error)}}catch(e){console.error(e)}},30000);
const ids=await fs.readdir(customersDir);for(const id of ids){const c=await loadCustomer(id);if(valid(c)&&c.phone)connect(c).catch(console.error)}
app.listen(PORT,'0.0.0.0',()=>console.log(`Listening on ${PORT}`));
