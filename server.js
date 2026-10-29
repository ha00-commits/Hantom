const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const DB_PATH = path.join(__dirname, "data.json");
let db = { users: {}, rooms: {}, messages: [], reports: [] };
try { if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch (e) {}
if (!db.users) db.users = {};
if (!db.rooms) db.rooms = {};
if (!db.messages) db.messages = [];
if (!db.reports) db.reports = [];
if (!db.rooms.general) db.rooms.general = { type: "public", owner: null, members: [] };
function save() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname.replace(/[^\w.\-]/g, ""))
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

const tokens = {};

app.post("/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, err: "بيانات ناقصة" });
  const u = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (u.length < 3) return res.json({ ok: false, err: "اسم قصير" });
  if (db.users[u]) return res.json({ ok: false, err: "الاسم مستخدم" });
  const owner = Object.keys(db.users).length === 0;
  db.users[u] = { username: u, name: u, pass: bcrypt.hashSync(password, 10), role: owner ? "owner" : "member", banned: false, muted: false, created: Date.now() };
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
  res.json({ ok: true, token: t, role: user.role, name: user.name || u });
});

app.post("/setname", (req, res) => {
  const { token, name } = req.body || {};
  const u = tokens[token];
  if (!u) return res.json({ ok: false });
  db.users[u].name = String(name || "").slice(0, 30);
  save();
  res.json({ ok: true });
});

app.get("/users", (req, res) => {
  if (!tokens[req.query.token]) return res.json({ ok: false });
  res.json({ ok: true, users: Object.keys(db.users) });
});

app.get("/search", (req, res) => {
  if (!tokens[req.query.token]) return res.json({ ok: false });
  const q = String(req.query.q || "").toLowerCase();
  if (q.length < 2) return res.json({ ok: true, results: [] });
  const results = db.messages.filter(m => m.text && m.text.toLowerCase().includes(q)).slice(-50);
  res.json({ ok: true, results });
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!tokens[req.body.token]) return res.json({ ok: false });
  if (!req.file) return res.json({ ok: false });
  res.json({ ok: true, url: "/uploads/" + req.file.filename });
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
      return send(ws, { type: "auth_ok", username: u, name: db.users[u].name || u });
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
      if (!text && !m.img) return;
      const msg = { id: crypto.randomBytes(6).toString("hex"), room: ws.room, from: ws.user, fromName: user.name || ws.user, text, img: m.img || null, fname: m.fname || null, burn: !!m.burn, time: Date.now() };
      db.messages.push(msg);
      if (db.messages.length > 5000) db.messages = db.messages.slice(-5000);
      save();
      return broadcast(ws.room, { type: "msg", message: msg });
    }
    if (m.type === "typing") return broadcast(ws.room, { type: "typing", from: ws.user, fromName: user.name || ws.user });
    if (m.type === "voice_join") return broadcast(ws.room, { type: "voice_peer", from: ws.user });
    if (m.type === "voice_leave") return broadcast(ws.room, { type: "voice_left", from: ws.user });
    if (m.type === "voice_signal") {
      wss.clients.forEach(c => { if (c.user === m.to && c.readyState === 1) send(c, { type: "voice_signal", from: ws.user, data: m.data }); });
      return;
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
