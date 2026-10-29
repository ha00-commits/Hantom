const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = path.join(__dirname, "data.json");
let db = { users: {}, rooms: {}, messages: [], reports: [] };
try { if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch (e) {}
if (!db.users) db.users = {};
if (!db.rooms) db.rooms = {};
if (!db.messages) db.messages = [];
if (!db.reports) db.reports = [];
if (!db.rooms.general) db.rooms.general = { type: "public", owner: null, members: [] };
function save() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

const app = express();
app.use(express.json());

const HTML = [
'<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1"><title>Hantom</title>',
'<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap" rel="stylesheet">',
'<style>',
'*{box-sizing:border-box;margin:0;padding:0}',
'body{font-family:Cairo,sans-serif;background:#0b0f14;color:#fff;height:100vh;overflow:hidden}',
'.hidden{display:none!important}',
'#auth{height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}',
'.card{width:100%;max-width:400px;background:#121820;border:1px solid #1f2a36;border-radius:18px;padding:22px}',
'h1{font-size:28px;font-weight:900}',
'.sub{color:#7d8a99;font-size:13px;margin-bottom:16px}',
'input{width:100%;padding:12px 14px;margin-bottom:10px;border-radius:12px;border:1px solid #24303d;background:#0e141b;color:#fff;font-family:Cairo,sans-serif;font-size:15px;outline:none}',
'button{padding:12px;border:none;border-radius:12px;background:#2f80ed;color:#fff;font-family:Cairo,sans-serif;font-weight:700;font-size:14px;cursor:pointer}',
'button.ghost{background:#1a2330}',
'.w100{width:100%}',
'#app{display:flex;height:100vh}',
'#side{width:200px;background:#0e141b;border-left:1px solid #1f2a36;display:flex;flex-direction:column}',
'#side h2{font-size:16px;padding:14px;font-weight:900}',
'#rooms{flex:1;overflow-y:auto}',
'.room{padding:10px 14px;cursor:pointer;font-size:14px;border-bottom:1px solid #161f29}',
'#sideBtns{padding:10px;display:flex;flex-direction:column;gap:6px}',
'#main{flex:1;display:flex;flex-direction:column;min-width:0}',
'.topbar{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:#121820;border-bottom:1px solid #1f2a36;gap:6px}',
'.tag{color:#2f80ed;font-weight:700;font-size:12px}',
'#msgs{flex:1;overflow-y:auto;padding:14px}',
'.msg{margin-bottom:10px}',
'.who{font-size:11px;color:#6d7b8a}',
'.body{display:inline-block;background:#182230;padding:9px 12px;border-radius:12px;max-width:85%;font-size:15px;margin-top:2px;word-break:break-word}',
'.msg.me{text-align:left}',
'.msg.me .body{background:#2f80ed}',
'.acts{font-size:11px;color:#6d7b8a;margin-top:3px}',
'.acts span{cursor:pointer;margin-inline-end:10px}',
'.bottom{display:flex;gap:6px;padding:10px;background:#121820;border-top:1px solid #1f2a36;align-items:center}',
'.bottom input{margin:0}',
'.burn{font-size:10px;color:#ff7043;margin-top:3px}',
'#typing{font-size:11px;color:#6d7b8a;padding:0 14px 6px}',
'</style></head><body>',
'<div id="auth"><div class="card"><h1>Hantom</h1><div class="sub">تواصل آمن بأسماء مستخدمين</div>',
'<input id="u" placeholder="@username"><input id="p" type="password" placeholder="كلمة السر">',
'<button class="w100" onclick="register()">إنشاء حساب</button>',
'<button class="ghost w100" style="margin-top:8px" onclick="login()">تسجيل الدخول</button>',
'<div class="sub" id="err" style="color:#ff6b6b;margin-top:10px"></div></div></div>',
'<div id="app" class="hidden"><div id="side"><h2>Hantom</h2><div id="rooms"></div>',
'<div id="sideBtns"><button class="ghost" onclick="newGroup()">+ مجموعة</button>',
'<button class="ghost" onclick="newPrivate()">+ غرفة بكلمة سر</button>',
'<button class="ghost" onclick="newDm()">@ محادثة خاصة</button>',
'<button class="ghost" onclick="joinRoom()">🔑 انضمام</button></div></div>',
'<div id="main"><div class="topbar"><b id="title">general</b><span class="tag" id="me"></span>',
'<button class="ghost" id="ownerBtn" style="display:none" onclick="openAdmin()">👑</button></div>',
'<div id="msgs"></div><div id="typing"></div>',
'<div class="bottom"><button class="ghost" onclick="report()">⚠️</button>',
'<button class="ghost" onclick="emoji()">😀</button>',
'<button class="ghost" id="burnBtn" onclick="toggleBurn()">🔥</button>',
'<input id="t" placeholder="اكتب رسالة..." style="flex:1"><button onclick="send()">إرسال</button></div></div></div>',
'<script>',
'let token=localStorage.getItem("hantom_token"),me="",myRole="member",ws=null,room="general",replyTo=null,burnMode=false;',
'async function api(p,b){const r=await fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return r.json();}',
'function err(t){document.getElementById("err").textContent=t||"";}',
'async function register(){const res=await api("/register",{username:u.value.trim(),password:p.value});if(!res.ok)return err(res.err);login();}',
'async function login(){const res=await api("/login",{username:u.value.trim(),password:p.value});if(!res.ok)return err(res.err);token=res.token;myRole=res.role;localStorage.setItem("hantom_token",token);start();}',
'function start(){document.getElementById("auth").classList.add("hidden");document.getElementById("app").classList.remove("hidden");',
'const proto=location.protocol==="https:"?"wss":"ws";ws=new WebSocket(proto+"://"+location.host);',
'ws.onopen=()=>{ws.send(JSON.stringify({type:"auth",token}));ws.send(JSON.stringify({type:"join",room:"general"}));};',
'ws.onmessage=e=>{const m=JSON.parse(e.data);',
'if(m.type==="auth_ok"){me=m.username;document.getElementById("me").textContent="@"+me;if(myRole==="owner")document.getElementById("ownerBtn").style.display="inline-block";}',
'if(m.type==="history"){msgs.innerHTML="";m.messages.forEach(addMsg);if(m.room)setTitle(m.room);}',
'if(m.type==="msg")addMsg(m.message);',
'if(m.type==="deleted"){const el=document.getElementById("m_"+m.id);if(el)el.remove();}',
'if(m.type==="created"){alert("تم إنشاء: "+m.room);join(m.room);}',
'if(m.type==="need_pass"){const pw=prompt("كلمة سر الغرفة:");if(pw)ws.send(JSON.stringify({type:"join",room:m.room,password:pw}));}',
'if(m.type==="typing"){if(m.from!==me){const el=document.getElementById("typing");el.textContent="@"+m.from+" يكتب...";clearTimeout(el._h);el._h=setTimeout(()=>el.textContent="",1500);}}',
'if(m.type==="error")alert(m.msg);};}',
'function setTitle(r){room=r;document.getElementById("title").textContent=r;}',
'function join(r){replyTo=null;ws.send(JSON.stringify({type:"join",room:r}));setTitle(r);}',
'function addMsg(m){const div=document.createElement("div");div.id="m_"+m.id;div.className="msg"+(m.from===me?" me":"");',
'let html="<div class=\\"who\\">@"+m.from+"</div><div class=\\"body\\"></div>";',
'html+="<div class=\\"acts\\"><span onclick=\\"setReply(\'"+m.id+"\')\\">رد</span><span onclick=\\"del(\'"+m.id+"\')\\">حذف</span></div>";',
'div.innerHTML=html;div.querySelector(".body").textContent=m.text||"";',
'if(m.burn){const f=document.createElement("div");f.className="burn";f.textContent="🔥 تُحرق بعد 10 ثواني";div.appendChild(f);setTimeout(()=>{if(ws)ws.send(JSON.stringify({type:"burn",id:m.id}));},10000);}',
'msgs.appendChild(div);msgs.scrollTop=msgs.scrollHeight;}',
'function setReply(id){replyTo=id;document.getElementById("t").placeholder="رد على رسالة...";}',
'function del(id){ws.send(JSON.stringify({type:"del",id}));}',
'function toggleBurn(){burnMode=!burnMode;document.getElementById("burnBtn").textContent=burnMode?"🔥✔":"🔥";}',
'function emoji(){const list="😀😃😄😁😆😅😂🤣😊😍😘😎🥳😭😢🤭🤍😳😏🍃🪶😡🥀🥰🥱🤢😹😸😺😾😿🙀😽😼😻💘🖤🩷🩶🩵👉🏻👈🏻🫀🔥💔🗿🍭🕊🥹😚🪽";const e=prompt("اختر إيموجي:",list);if(e){document.getElementById("t").value+=e;document.getElementById("t").focus();}}',
'function send(){const t=document.getElementById("t").value.trim();if(!t)return;ws.send(JSON.stringify({type:"msg",text:t,replyTo,burn:burnMode}));document.getElementById("t").value="";replyTo=null;burnMode=false;document.getElementById("burnBtn").textContent="🔥";}',
'function newGroup(){const n=prompt("اسم المجموعة:");if(n)ws.send(JSON.stringify({type:"create",name:n,roomType:"group"}));}',
'function newPrivate(){const n=prompt("اسم الغرفة:");if(!n)return;const pw=prompt("كلمة السر:");if(pw)ws.send(JSON.stringify({type:"create",name:n,roomType:"private",password:pw}));}',
'function newDm(){const to=prompt("اسم الشخص (@):");if(to)ws.send(JSON.stringify({type:"dm",to:to.replace("@","")}));}',
'function joinRoom(){const r=prompt("اسم الغرفة:");if(r)join(r);}',
'async function report(){const target=prompt("الشخص (@):");if(!target)return;const reason=prompt("السبب:")||"";const res=await api("/report",{token,target:target.replace("@",""),reason});alert(res.ok?"تم ✅":"فشل");}',
'async function openAdmin(){const r=await fetch("/admin/reports?token="+token);const res=await r.json();if(!res.ok)return alert("للمالك فقط");if(!res.reports.length)return alert("لا بلاغات");const lines=res.reports.map(x=>x.reporter+" → @"+x.target+" : "+(x.reason||"-")).join("\\n");const target=prompt("البلاغات:\\n"+lines+"\\n\\n@الاسم:");if(!target)return;const act=prompt("ban / unban / mute / unmute");if(!act)return;const a=await api("/admin/action",{token,target:target.replace("@",""),action:act});alert(a.ok?"تم ✅":"فشل");}',
'document.addEventListener("input",function(ev){if(ev.target&&ev.target.id==="t"&&ws&&ws.readyState===1){ws.send(JSON.stringify({type:"typing"}));}});',
'if(token)start();',
'</script></body></html>'
].join("");

app.get("/", (req, res) => res.type("html").send(HTML));

const tokens = {};
app.post("/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, err: "بيانات ناقصة" });
  const u = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (u.length < 3) return res.json({ ok: false, err: "اسم قصير" });
  if (db.users[u]) return res.json({ ok: false, err: "الاسم مستخدم" });
  const owner = Object.keys(db.users).length === 0;
  db.users[u] = { username: u, pass: bcrypt.hashSync(password, 10), role: owner ? "owner" : "member", banned: false, muted: false, created: Date.now() };
  save();
  res.json({ ok: true });
});
app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const u = (username || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  const user = db.users[u];
  if (!user) return res.json({ ok: false, err: "غير موجود" });
  if (user.banned) return res.json({ ok: false, err: "محظور" });
  if (!bcrypt.compareSync(password || "", user.pass)) return res.json({ ok: false, err: "كلمة السر خاطئة" });
  const t = crypto.randomBytes(24).toString("hex");
  tokens[t] = u;
  res.json({ ok: true, token: t, role: user.role });
});
app.post("/report", (req, res) => {
  const { token, target, reason } = req.body || {};
  const rep = tokens[token];
  if (!rep) return res.json({ ok: false });
  db.reports.push({ id: crypto.randomBytes(6).toString("hex"), reporter: rep, target, reason: reason || "", time: Date.now() });
  save();
  res.json({ ok: true });
});
app.get("/admin/reports", (req, res) => {
  const u = tokens[req.query.token];
  if (!u || db.users[u].role !== "owner") return res.json({ ok: false });
  res.json({ ok: true, reports: db.reports.slice(-100).reverse() });
});
app.post("/admin/action", (req, res) => {
  const { token, target, action } = req.body || {};
  const u = tokens[token];
  if (!u || db.users[u].role !== "owner") return res.json({ ok: false });
  const t = db.users[target];
  if (!t) return res.json({ ok: false });
  if (action === "ban") t.banned = true;
  if (action === "unban") t.banned = false;
  if (action === "mute") t.muted = true;
  if (action === "unmute") t.muted = false;
  save();
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
function send(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
function broadcast(r, o) { wss.clients.forEach(c => { if (c.room === r && c.readyState === 1) send(c, o); }); }

wss.on("connection", ws => {
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.type === "auth") {
      const u = tokens[m.token];
      if (!u) return send(ws, { type: "error", msg: "توكن غير صالح" });
      ws.user = u;
      return send(ws, { type: "auth_ok", username: u });
    }
    if (!ws.user) return;
    const user = db.users[ws.user];
    if (!user || user.banned) return;
    if (m.type === "join") {
      const room = db.rooms[m.room];
      if (!room) return send(ws, { type: "error", msg: "الغرفة غير موجودة" });
      if (room.password && m.password !== room.password) return send(ws, { type: "need_pass", room: m.room });
      ws.room = m.room;
      const hist = db.messages.filter(x => x.room === m.room).slice(-50);
      return send(ws, { type: "history", room: m.room, messages: hist });
    }
    if (m.type === "create") {
      const name = String(m.name || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (name.length < 2 || db.rooms[name]) return;
      db.rooms[name] = { type: m.roomType === "private" ? "private" : "group", owner: ws.user, password: m.password || "", members: [ws.user] };
      save();
      return send(ws, { type: "created", room: name });
    }
    if (m.type === "dm") {
      const to = String(m.to || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (!db.users[to]) return send(ws, { type: "error", msg: "الشخص غير موجود" });
      const id = "dm_" + [ws.user, to].sort().join("_");
      if (!db.rooms[id]) { db.rooms[id] = { type: "dm", owner: null, members: [ws.user, to] }; save(); }
      ws.room = id;
      const hist = db.messages.filter(x => x.room === id).slice(-50);
      return send(ws, { type: "history", room: id, messages: hist });
    }
    if (m.type === "msg") {
      if (user.muted || !ws.room) return;
      const text = String(m.text || "").slice(0, 2000).trim();
      if (!text) return;
      const msg = { id: crypto.randomBytes(6).toString("hex"), room: ws.room, from: ws.user, text, burn: !!m.burn, time: Date.now() };
      db.messages.push(msg);
      if (db.messages.length > 5000) db.messages = db.messages.slice(-5000);
      save();
      return broadcast(ws.room, { type: "msg", message: msg });
    }
    if (m.type === "typing") {
      return broadcast(ws.room, { type: "typing", from: ws.user });
    }
    if (m.type === "burn") {
      const i = db.messages.findIndex(x => x.id === m.id);
      if (i >= 0) { const msg = db.messages[i]; db.messages.splice(i, 1); save(); broadcast(msg.room, { type: "deleted", id: m.id }); }
      return;
    }
    if (m.type === "del") {
      const i = db.messages.findIndex(x => x.id === m.id);
      if (i < 0) return;
      const msg = db.messages[i];
      const owner = db.rooms[msg.room] && db.rooms[msg.room].owner;
      if (msg.from !== ws.user && user.role !== "owner" && owner !== ws.user) return;
      db.messages.splice(i, 1);
      save();
      return broadcast(msg.room, { type: "deleted", id: m.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Hantom " + PORT));
