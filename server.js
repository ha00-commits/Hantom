const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = path.join(__dirname, "data.json");
let db = { users: {}, messages: [], reports: [], rooms: ["general"] };
if (fs.existsSync(DB_PATH)) {
  try { db = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch (e) {}
}
function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const tokens = {}; // token -> username

app.post("/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, err: "بيانات ناقصة" });
  const u = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (u.length < 3) return res.json({ ok: false, err: "اسم المستخدم قصير" });
  if (db.users[u]) return res.json({ ok: false, err: "الاسم مستخدم" });
  const isOwner = Object.keys(db.users).length === 0;
  db.users[u] = {
    username: u,
    pass: bcrypt.hashSync(password, 10),
    role: isOwner ? "owner" : "member",
    banned: false,
    muted: false,
    created: Date.now()
  };
  save();
  res.json({ ok: true });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const u = (username || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  const user = db.users[u];
  if (!user) return res.json({ ok: false, err: "الحساب غير موجود" });
  if (user.banned) return res.json({ ok: false, err: "حسابك محظور" });
  if (!bcrypt.compareSync(password || "", user.pass)) {
    return res.json({ ok: false, err: "كلمة السر خاطئة" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  tokens[token] = u;
  res.json({ ok: true, token, role: user.role });
});

app.post("/report", (req, res) => {
  const { token, target, reason } = req.body || {};
  const reporter = tokens[token];
  if (!reporter) return res.json({ ok: false, err: "غير مسجل" });
  if (!target) return res.json({ ok: false, err: "لا يوجد هدف" });
  db.reports.push({
    id: crypto.randomBytes(6).toString("hex"),
    reporter, target, reason: reason || "", time: Date.now(), status: "new"
  });
  save();
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
function broadcast(room, obj) {
  wss.clients.forEach(c => {
    if (c.room === room && c.readyState === WebSocket.OPEN) send(c, obj);
  });
}

wss.on("connection", ws => {
  ws.readyState;
  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.type === "auth") {
      const u = tokens[m.token];
      if (!u) { send(ws, { type: "error", msg: "توكن غير صالح" }); return; }
      ws.user = u;
      send(ws, { type: "auth_ok", username: u });
      return;
    }

    if (!ws.user) { send(ws, { type: "error", msg: "سجل دخول أول" }); return; }
    const user = db.users[ws.user];
    if (!user || user.banned) { send(ws, { type: "error", msg: "محظور" }); return; }

    if (m.type === "join") {
      ws.room = m.room || "general";
      const hist = db.messages.filter(x => x.room === ws.room).slice(-50);
      send(ws, { type: "history", room: ws.room, messages: hist });
      return;
    }

    if (m.type === "msg") {
      if (user.muted) { send(ws, { type: "error", msg: "مكتوم" }); return; }
      const text = String(m.text || "").slice(0, 2000).trim();
      if (!text) return;
      const msg = {
        id: crypto.randomBytes(6).toString("hex"),
        room: ws.room || "general",
        from: ws.user,
        text,
        time: Date.now()
      };
      db.messages.push(msg);
      if (db.messages.length > 5000) db.messages = db.messages.slice(-5000);
      save();
      broadcast(msg.room, { type: "msg", message: msg });
      return;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Hantom running on " + PORT);
});
