// Relay-сервер онлайн-гри. Нічого не знає про саму гру: лише
//   * впізнає гравців (публічний код друга = хеш від секрету, який зберігається лише у гравця),
//   * показує, хто з друзів у мережі,
//   * передає запрошення в кімнату,
//   * тримає кімнати до MAX_PLAYERS гравців і пересилає між ними пакети (relay).
// Друзі зберігаються у самих гравців (user://profile.json), на сервері нічого не пишеться на диск —
// тому безкоштовний Render, який "засинає", нічого не втрачає.
//
// Запуск:  npm install && npm start      (порт береться зі змінної PORT)

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 4;
const ROOM_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_MSGS_PER_SEC = 250;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("wave-server ok\n");
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

const byId = new Map();     // код друга -> з'єднання
const rooms = new Map();    // код кімнати -> { code, members: Map(pid -> conn), locked }
const pending = new Map();  // "від>кому" -> час: запити в друзі, що чекають відповіді
const lastInvite = new Map();

function send(c, obj) {
  if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
}
function err(c, msg) { send(c, { t: "error", msg }); }

function cleanName(s) {
  s = String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16);
  return s || "Гравець";
}
function friendCode(secret) {
  return crypto.createHash("sha256").update("wave:" + secret).digest("hex").slice(0, 8).toUpperCase();
}
function newRoomCode() {
  for (let n = 0; n < 200; n++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += ROOM_LETTERS[crypto.randomInt(ROOM_LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function roster(room) {
  return [...room.members.entries()].map(([pid, c]) => ({ pid, id: c.id, name: c.name }));
}
function areFriends(a, b) {
  return a.friends.has(b.id) && b.friends.has(a.id);
}

// ---------- Кімнати ----------

function leaveRoom(c, reason) {
  const room = c.room;
  if (!room) return;
  c.room = null;
  const pid = c.pid;
  c.pid = 0;
  room.members.delete(pid);
  if (pid === 1) {
    // хост пішов — кімната закривається для всіх
    for (const m of room.members.values()) {
      m.room = null;
      m.pid = 0;
      send(m, { t: "room_closed", why: reason || "host_left" });
    }
    rooms.delete(room.code);
  } else {
    for (const m of room.members.values()) send(m, { t: "player_left", pid });
    if (room.members.size === 0) rooms.delete(room.code);
  }
}

function handle(c, m) {
  const t = String(m.t || "");

  if (t === "hello") {
    const secret = String(m.secret || "");
    if (secret.length < 16 || secret.length > 128) return err(c, "Невірний профіль");
    const id = friendCode(secret);
    const old = byId.get(id);
    if (old && old !== c) {
      send(old, { t: "replaced" });
      old.ws.close();
      cleanup(old);
    }
    c.id = id;
    c.name = cleanName(m.name);
    c.friends = new Set(Array.isArray(m.friends) ? m.friends.slice(0, 200).map(x => String(x).toUpperCase()) : []);
    byId.set(id, c);
    return send(c, { t: "welcome", id, name: c.name });
  }
  if (!c.id) return err(c, "Спочатку треба увійти");

  switch (t) {
    case "set_friends":
      c.friends = new Set(Array.isArray(m.ids) ? m.ids.slice(0, 200).map(x => String(x).toUpperCase()) : []);
      return;

    case "status": {
      const list = [];
      for (const raw of Array.isArray(m.ids) ? m.ids.slice(0, 200) : []) {
        const id = String(raw).toUpperCase();
        const o = byId.get(id);
        if (o && areFriends(c, o)) {
          list.push({ id, online: true, name: o.name, room: o.room ? o.room.code : "",
            joinable: !!(o.room && !o.room.locked && o.room.members.size < MAX_PLAYERS) });
        } else {
          list.push({ id, online: false });
        }
      }
      return send(c, { t: "status", list });
    }

    case "friend_add": {
      const id = String(m.id || "").trim().toUpperCase();
      const o = byId.get(id);
      if (id === c.id) return err(c, "Це твій власний код");
      if (!o) return err(c, "Гравця з таким кодом зараз немає в мережі");
      if (areFriends(c, o)) return err(c, "Ви вже друзі");
      pending.set(c.id + ">" + id, Date.now());
      send(o, { t: "friend_req", id: c.id, name: c.name });
      return send(c, { t: "sent", what: "friend_req", name: o.name });
    }

    case "friend_accept": {
      const id = String(m.id || "").toUpperCase();
      const o = byId.get(id);
      if (!pending.has(id + ">" + c.id)) return err(c, "Запит застарів");
      pending.delete(id + ">" + c.id);
      if (!o) return err(c, "Гравець вже вийшов з мережі. Нехай надішле запит ще раз");
      c.friends.add(o.id);
      o.friends.add(c.id);
      send(o, { t: "friend_ok", id: c.id, name: c.name });
      return send(c, { t: "friend_ok", id: o.id, name: o.name });
    }

    case "friend_decline":
      pending.delete(String(m.id || "").toUpperCase() + ">" + c.id);
      return;

    case "create": {
      leaveRoom(c);
      const code = newRoomCode();
      if (!code) return err(c, "Не вдалося створити кімнату");
      const room = { code, members: new Map(), locked: false };
      room.members.set(1, c);
      rooms.set(code, room);
      c.room = room;
      c.pid = 1;
      return send(c, { t: "created", code, pid: 1, players: roster(room) });
    }

    case "join": {
      const code = String(m.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (c.room && c.room === room) return send(c, { t: "joined", code, pid: c.pid, players: roster(room) });
      if (!room) return err(c, "Кімнату не знайдено");
      if (room.locked) return err(c, "У цій кімнаті гра вже почалась");
      if (room.members.size >= MAX_PLAYERS) return err(c, "Кімната заповнена");
      leaveRoom(c);
      let pid = 2;
      while (room.members.has(pid)) pid++;
      room.members.set(pid, c);
      c.room = room;
      c.pid = pid;
      for (const o of room.members.values()) if (o !== c) send(o, { t: "player_joined", pid, id: c.id, name: c.name });
      return send(c, { t: "joined", code, pid, players: roster(room) });
    }

    case "invite": {
      if (!c.room) return err(c, "Спочатку створи кімнату");
      if (c.room.locked) return err(c, "Гра вже почалась");
      if (c.room.members.size >= MAX_PLAYERS) return err(c, "Кімната заповнена");
      const o = byId.get(String(m.id || "").toUpperCase());
      if (!o || !areFriends(c, o)) return err(c, "Друг не в мережі");
      if (o.room === c.room) return err(c, "Він уже в кімнаті");
      const key = c.id + ">" + o.id;
      const now = Date.now();
      if (now - (lastInvite.get(key) || 0) < 3000) return;
      lastInvite.set(key, now);
      send(o, { t: "invite", from: c.id, name: c.name, code: c.room.code });
      return send(c, { t: "sent", what: "invite", name: o.name });
    }

    case "lock":
      if (c.room && c.pid === 1) c.room.locked = !!m.on;
      return;

    case "leave":
      return leaveRoom(c, "left");

    case "relay": {
      const room = c.room;
      if (!room || typeof m.data !== "object" || m.data === null) return;
      const out = { t: "relay", from: c.pid, data: m.data };
      if (m.to !== undefined && m.to !== null) {
        send(room.members.get(Number(m.to)), out);
      } else {
        for (const o of room.members.values()) if (o !== c) send(o, out);
      }
      return;
    }
  }
}

function cleanup(c) {
  if (c.dead) return;
  c.dead = true;
  leaveRoom(c, "disconnect");
  if (c.id && byId.get(c.id) === c) byId.delete(c.id);
}

wss.on("connection", (ws) => {
  const c = { ws, id: "", name: "", friends: new Set(), room: null, pid: 0, alive: true, dead: false, budget: MAX_MSGS_PER_SEC, tick: Date.now() };
  ws._c = c;
  ws.on("pong", () => { c.alive = true; });
  ws.on("message", (raw) => {
    const now = Date.now();
    if (now - c.tick >= 1000) { c.tick = now; c.budget = MAX_MSGS_PER_SEC; }
    if (--c.budget < 0) return;
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m && typeof m === "object") {
      try { handle(c, m); } catch (e) { console.error("handler error", e); }
    }
  });
  ws.on("close", () => cleanup(c));
  ws.on("error", () => cleanup(c));
});

// Обірвані з'єднання (вимкнули мережу, закрили ноутбук) відсікаємо за ping/pong
setInterval(() => {
  for (const ws of wss.clients) {
    const c = ws._c;
    if (c && !c.alive) { ws.terminate(); continue; }
    if (c) c.alive = false;
    try { ws.ping(); } catch {}
  }
  const old = Date.now() - 10 * 60 * 1000;
  for (const [k, t] of pending) if (t < old) pending.delete(k);
}, 20000);

server.listen(PORT, () => console.log("wave-server listening on", PORT));
