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
if (fs.existsSync(DB_PATH)) { try { db = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch (e) {} }
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
  const token = crypto.randomBytes(24).toString("hex");
  tokens[token] = u;
  res.json({ ok: true, token, role: user.role });
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!tokens[req.body.token]) return res.json({ ok: false });
  if (!req.file) return res.json({ ok: false });
  res.json({ ok: true, url: "/uploads/" + req.file.filename });
});

app.post("/report", (req, res) => {
  const { token, target, reason } = req.body || {};
  const reporter = tokens[token];
  if (!reporter) return res.json({ ok: false });
  db.reports.push({ id: crypto.randomBytes(6).toString("hex"), reporter, target, reason: reason || "", time: Date.now(), status: "new" });
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
  if (!t) return res.json({ ok: false, err: "لا يوجد" });
  if (action === "ban") t.banned = true;
  if (action === "unban") t.banned = false;
  if (action === "mute") t.muted = true;
  if (action === "unmute") t.muted = false;
  save();
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
function broadcast(roomName, obj) {
  wss.clients.forEach(c => { if (c.room === roomName && c.readyState === WebSocket.OPEN) send(c, obj); });
}

wss.on("connection", ws => {
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.type === "auth") {
      const u = tokens[m.token];
      if (!u) return send(ws, { type: "error", msg: "توكن غير صالح" });
      ws.user = u;
      return send(ws, { type: "auth_ok", username: u });
    }
    if (!ws.user) return send(ws, { type: "error", msg: "سجل دخول" });
    const user = db.users[ws.user];
    if (!user || user.banned) return send(ws, { type: "error", msg: "محظور" });

    if (m.type === "join") {
      const room = db.rooms[m.room];
      if (!room) return send(ws, { type: "error", msg: "الغرفة غير موجودة" });
      if (room.password && m.password !== room.password) return send(ws, { type: "need_pass", room: m.room });
      room.members = room.members || [];
      if (!room.members.includes(ws.user)) room.members.push(ws.user);
      save();
      ws.room = m.room;
      const hist = db.messages.filter(x => x.room === m.room).slice(-50);
      send(ws, { type: "history", room: m.room, messages: hist });
      return;
    }
    if (m.type === "create") {
      const name = String(m.name || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (name.length < 2) return send(ws, { type: "error", msg: "اسم قصير" });
      if (db.rooms[name]) return send(ws, { type: "error", msg: "موجودة" });
      db.rooms[name] = { type: m.roomType === "private" ? "private" : "group", owner: ws.user, password: m.password || "", members: [ws.user], created: Date.now() };
      save();
      send(ws, { type: "created", room: name });
      return;
    }
    if (m.type === "dm") {
      const to = String(m.to || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (!db.users[to]) return send(ws, { type: "error", msg: "الشخص غير موجود" });
      const id = "dm_" + [ws.user, to].sort().join("_");
      if (!db.rooms[id]) { db.rooms[id] = { type: "dm", owner: null, members: [ws.user, to] }; save(); }
      ws.room = id;
      const hist = db.messages.filter(x => x.room === id).slice(-50);
      send(ws, { type: "history", room: id, messages: hist });
      return;
    }
    if (m.type === "msg") {
      if (user.muted) return send(ws, { type: "error", msg: "مكتوم" });
      const text = String(m.text || "").slice(0, 2000).trim();
      if ((!text && !m.img && !m.file) || !ws.room) return;
      const msg = { id: crypto.randomBytes(6).toString("hex"), room: ws.room, from: ws.user, text, replyTo: m.replyTo || null, img: m.img || null, file: m.file || null, fname: m.fname || null, burn: !!m.burn, time: Date.now() };
      db.messages.push(msg);
      if (db.messages.length > 5000) db.messages = db.messages.slice(-5000);
      save();
      broadcast(ws.room, { type: "msg", message: msg });
      return;
    }
    if (m.type === "burn") {
      const idx = db.messages.findIndex(x => x.id === m.id);
      if (idx >= 0) {
        const msg = db.messages[idx];
        db.messages.splice(idx, 1);
        save();
        broadcast(msg.room, { type: "deleted", id: m.id });
      }
      return;
    }
    if (m.type === "del") {
      const idx = db.messages.findIndex(x => x.id === m.id);
      if (idx < 0) return;
      const msg = db.messages[idx];
      const owner = db.rooms[msg.room] && db.rooms[msg.room].owner;
      if (msg.from !== ws.user && user.role !== "owner" && owner !== ws.user) return;
      db.messages.splice(idx, 1);
      save();
      broadcast(msg.room, { type: "deleted", id: m.id });
      return;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Hantom " + PORT));
