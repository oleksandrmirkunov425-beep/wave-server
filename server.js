// Relay-сервер лобі на 2 гравців.
// Сервер НЕ рахує гру: він лише створює кімнати за кодом і пересилає повідомлення між двома гравцями.
//
// Протокол (JSON, одне повідомлення = один JSON-об'єкт):
//   клієнт -> сервер:  {"t":"create"}                  створити кімнату
//                      {"t":"join","code":"ABCD"}      приєднатися за кодом
//                      {"t":"relay","data":{...}}      переслати дані другому гравцеві
//                      {"t":"leave"}                   вийти з кімнати
//   сервер -> клієнт:  {"t":"created","code":"ABCD"}   кімнату створено (ти — хост)
//                      {"t":"joined","role":"host"|"guest","code":"ABCD"}   в кімнаті двоє, можна починати
//                      {"t":"relay","data":{...}}      дані від другого гравця
//                      {"t":"peer_left"}               другий гравець вийшов
//                      {"t":"error","msg":"..."}       помилка (немає кімнати, вона повна тощо)

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_MSG_BYTES = 64 * 1024;       // захист від надто великих повідомлень
const MAX_ROOMS = 500;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";  // без схожих символів (0/O, 1/I)

const rooms = new Map();               // code -> { host: ws, guest: ws|null }

const server = http.createServer((req, res) => {
  // Render і браузер перевіряють, що сервіс живий
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Wave Game server OK. Rooms: " + rooms.size);
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

function makeCode() {
  for (let tries = 0; tries < 50; tries++) {
    let code = "";
    for (let i = 0; i < 4; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function other(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  return room.host === ws ? room.guest : room.host;
}

function leaveRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  ws.roomCode = null;
  if (!room) return;
  const peer = room.host === ws ? room.guest : room.host;
  if (peer) {
    send(peer, { t: "peer_left" });
    peer.roomCode = null;      // кімната розпадається, коли хтось вийшов
  }
  rooms.delete(code);
}

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { t: "error", msg: "Некоректне повідомлення" }); }
    if (!msg || typeof msg.t !== "string") return;

    switch (msg.t) {
      case "create": {
        if (ws.roomCode) leaveRoom(ws);
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: "error", msg: "Сервер зайнятий, спробуй пізніше" });
        const code = makeCode();
        if (!code) return send(ws, { t: "error", msg: "Не вдалося створити кімнату" });
        rooms.set(code, { host: ws, guest: null });
        ws.roomCode = code;
        send(ws, { t: "created", code });
        break;
      }
      case "join": {
        const code = String(msg.code || "").toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return send(ws, { t: "error", msg: "Кімнату не знайдено" });
        if (room.guest) return send(ws, { t: "error", msg: "Кімната вже заповнена" });
        if (ws.roomCode) leaveRoom(ws);
        room.guest = ws;
        ws.roomCode = code;
        send(room.host, { t: "joined", role: "host", code });
        send(ws, { t: "joined", role: "guest", code });
        break;
      }
      case "relay": {
        const peer = other(ws);
        if (peer) send(peer, { t: "relay", data: msg.data });
        break;
      }
      case "leave":
        leaveRoom(ws);
        break;
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => {});
});

// Пінг кожні 25 с: прибирає "мертві" з'єднання і не дає Render розірвати тихе з'єднання
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log("Wave Game server listening on port " + PORT));
