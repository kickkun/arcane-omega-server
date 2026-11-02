// アーケインサモンΩ（対人版）最小サーバー ― サーバー権威型
// 段階2: ローカルで「2つの接続で1戦できる」状態を作る。
// 段階3: 再接続（同じ guestId で席に復帰）、リマッチ、部屋の後片付けを追加。
//
// 起動: node server.js  （ポートは環境変数 PORT、デフォルト 8930）
// HTTP: / → test-client.html、/cards.js → カードデータ（テストクライアントの表示用）
//
// プロトコル（JSON）
//   C→S: {type:"hello", guestId?, name?}        仮IDの申告（無ければサーバーが発行。席が残っていれば自動で復帰）
//        {type:"create"}                        部屋を作る
//        {type:"join", code}                    ルームコードで参加
//        {type:"submit", deck, summoner, name?} デッキと召喚士を提出（両者揃うと開始）
//        {type:"action", action:{...}}          エンジンのアクションそのまま
//        {type:"rematch"}                       対戦終了後にリマッチを希望する
//        {type:"leave"}                         部屋から退出する（席の予約も解除）
//   S→C: {type:"welcome", guestId}
//        {type:"roomCreated", code, seat} / {type:"joined", code, seat}
//        {type:"rejoined", code, seat}          再接続で席に復帰した
//        {type:"opponentJoined"} / {type:"opponentSubmitted"}
//        {type:"opponentReconnected"}          相手が再接続した
//        {type:"opponentDisconnected"}         相手が切断した（席は保持され、再接続できる）
//        {type:"opponentRematch"}              相手がリマッチを希望した
//        {type:"rematchRequested", waiting}    自分のリマッチ希望を受け付けた（waiting=true は相手待ち）
//        {type:"left"} / {type:"opponentLeft"} 退出した／相手が退出した
//        {type:"view", ...}                     その人専用のビュー（相手の手札は枚数だけ）
//        {type:"error", message}
//
// 保持・後片付けの実装値:
//   - 切断した席は RECONNECT_GRACE_MS（デフォルト30分）保持し、その間は同じ guestId で復帰できる。
//   - 両席とも空席で、両席とも保持上限を超えた部屋は掃除（SWEEP_MS 間隔、デフォルト5秒）で破棄する。
//   - 両者が leave した部屋は即時破棄する。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createGame, applyAction, legalActions, defOf, effAtk, effMaxHp, effHp, hasKw } from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8930);
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 30 * 60 * 1000);
const SWEEP_MS = Number(process.env.SWEEP_MS || 5000);

// ---------- HTTP ----------

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let file = null;
  let ctype = "text/plain; charset=utf-8";
  if (url.pathname === "/" || url.pathname === "/test-client.html") {
    file = path.join(__dirname, "test-client.html");
    ctype = "text/html; charset=utf-8";
  } else if (url.pathname === "/cards.js") {
    file = path.join(__dirname, "cards.js");
    ctype = "text/javascript; charset=utf-8";
  }
  if (!file) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end("read error");
      return;
    }
    res.writeHead(200, { "Content-Type": ctype });
    res.end(data);
  });
});

// ---------- 部屋管理 ----------

const rooms = new Map(); // code -> room
const sessions = new Map(); // guestId -> { room, seat }（席の予約。再接続の手がかり）
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newCode() {
  for (;;) {
    let code = "";
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

function newGuestId() {
  return "g-" + Math.random().toString(36).slice(2, 10);
}

// room = {
//   code,
//   seats: [client|null, client|null],        現在つながっている接続
//   seatGuests: [guestId|null, guestId|null],  席の持ち主（切断中も保持）
//   seatNames: [string, string],
//   subs: [{deck,summoner}|null, {...}|null],
//   state,                                     エンジンの対戦状態（未開始は null）
//   rematch: [bool, bool],                     リマッチ希望
//   disconnectedSince: [ts|null, ts|null],     その席が空席になった時刻（接続中は null）
// }

function send(client, obj) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(obj));
}

function sendError(client, message) {
  send(client, { type: "error", message });
}

function destroyRoom(room) {
  for (let s = 0; s < 2; s++) {
    const g = room.seatGuests[s];
    if (g) {
      const sess = sessions.get(g);
      if (sess && sess.room === room) sessions.delete(g);
    }
    const c = room.seats[s];
    if (c && c.room === room) {
      c.room = null;
      c.seat = null;
    }
  }
  rooms.delete(room.code);
}

// 両席とも空席で保持上限を超えた部屋を破棄する
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    let destroy = true;
    for (let s = 0; s < 2; s++) {
      if (room.seats[s]) {
        destroy = false;
        break;
      }
      const since = room.disconnectedSince[s];
      if (since === null || now - since < RECONNECT_GRACE_MS) {
        destroy = false;
        break;
      }
    }
    if (destroy) destroyRoom(room);
  }
}, SWEEP_MS);

// ---------- ビュー（個人別。相手の手札は枚数だけ） ----------

function unitView(u) {
  const d = defOf(u);
  const keywords = [...d.keywords];
  if (u.grantedWall && !keywords.includes("wall")) keywords.push("wall");
  if (u.grantedCounter && !keywords.includes("counter")) keywords.push("counter");
  return {
    uid: u.uid,
    cardId: u.cardId,
    token: u.token,
    name: d.name,
    cost: d.cost,
    atk: effAtk(u),
    maxHp: effMaxHp(u),
    hp: effHp(u),
    keywords,
    attacksLeft: u.attacksLeft,
  };
}

function playerPublic(room, seat) {
  const st = room.state;
  const pl = st.players[seat];
  const client = room.seats[seat];
  return {
    seat,
    name: (client ? client.name : room.seatNames[seat]) || "",
    summoner: pl.summoner,
    life: pl.life,
    mana: pl.mana,
    manaMax: pl.manaMax,
    turnCount: pl.turnCount,
    coin: pl.coin,
    deckCount: pl.deck.length,
    field: pl.field.map(unitView),
  };
}

function buildView(room, seat) {
  const st = room.state;
  const me = playerPublic(room, seat);
  const op = playerPublic(room, 1 - seat);
  me.hand = [...st.players[seat].hand]; // 自分の手札だけ中身を見せる
  op.handCount = st.players[1 - seat].hand.length; // 相手は枚数だけ
  let pending = null;
  if (st.pending) {
    pending = {
      type: st.pending.type,
      player: st.pending.player,
      effectKind: st.pending.effect ? st.pending.effect.kind : null,
    };
  }
  return {
    type: "view",
    code: room.code,
    you: seat,
    turn: st.turn,
    first: st.first,
    turnSeq: st.turnSeq,
    winner: st.winner,
    pending,
    rematch: [...room.rematch],
    me,
    opponent: op,
    legalActions: legalActions(st, seat),
    log: st.log.slice(-8),
  };
}

function broadcastViews(room) {
  for (let seat = 0; seat < 2; seat++) {
    if (room.seats[seat]) send(room.seats[seat], buildView(room, seat));
  }
}

// ---------- 対戦開始（初回・リマッチ共通） ----------

function startGame(room) {
  room.state = createGame({
    deckA: room.subs[0].deck,
    deckB: room.subs[1].deck,
    summonerA: room.subs[0].summoner,
    summonerB: room.subs[1].summoner,
    first: Math.random() < 0.5 ? 0 : 1, // 先攻はランダム（リマッチでも再抽選）
  });
  room.rematch = [false, false];
  broadcastViews(room);
}

// ---------- 再接続 ----------

// hello の guestId に席の予約があれば、その席に接続を戻す
function tryReattach(client) {
  if (client.room) return;
  const sess = sessions.get(client.guestId);
  if (!sess) return;
  const room = sess.room;
  if (rooms.get(room.code) !== room || room.seatGuests[sess.seat] !== client.guestId) {
    sessions.delete(client.guestId); // 予約が失効していたら掃除する
    return;
  }
  const seat = sess.seat;
  const old = room.seats[seat];
  if (old && old !== client) {
    // 同じ席に古い接続が残っていたら新しい接続を優先する
    old.room = null;
    old.seat = null;
    try {
      old.ws.close();
    } catch {}
  }
  room.seats[seat] = client;
  room.disconnectedSince[seat] = null;
  if (client.name) room.seatNames[seat] = client.name;
  client.room = room;
  client.seat = seat;
  send(client, { type: "rejoined", code: room.code, seat });
  const other = room.seats[1 - seat];
  if (other) send(other, { type: "opponentReconnected" });
  if (room.state) send(client, buildView(room, seat)); // 対戦中なら現在のビューで復帰
}

// ---------- 接続処理 ----------

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const client = { ws, guestId: newGuestId(), name: "", room: null, seat: null };
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendError(client, "JSONとして解釈できません");
      return;
    }
    try {
      handleMessage(client, msg);
    } catch (e) {
      sendError(client, e.message || String(e));
    }
  });
  ws.on("close", () => handleDisconnect(client));
});

function handleMessage(client, msg) {
  switch (msg.type) {
    case "hello": {
      if (typeof msg.guestId === "string" && msg.guestId.length > 0 && msg.guestId.length <= 64) {
        client.guestId = msg.guestId;
      }
      if (typeof msg.name === "string") client.name = msg.name.slice(0, 32);
      send(client, { type: "welcome", guestId: client.guestId });
      tryReattach(client);
      return;
    }
    case "create": {
      if (client.room) throw new Error("すでに部屋に入っています");
      const code = newCode();
      const room = {
        code,
        seats: [client, null],
        seatGuests: [client.guestId, null],
        seatNames: [client.name || "", ""],
        subs: [null, null],
        state: null,
        rematch: [false, false],
        disconnectedSince: [null, Date.now()],
      };
      rooms.set(code, room);
      sessions.set(client.guestId, { room, seat: 0 });
      client.room = room;
      client.seat = 0;
      send(client, { type: "roomCreated", code, seat: 0 });
      return;
    }
    case "join": {
      if (client.room) throw new Error("すでに部屋に入っています");
      const room = rooms.get(String(msg.code || "").toUpperCase());
      if (!room) throw new Error("そのルームコードの部屋はありません");
      if (room.seatGuests[0] && room.seatGuests[1]) throw new Error("その部屋は満員です");
      const seat = room.seatGuests[0] ? 1 : 0;
      room.seats[seat] = client;
      room.seatGuests[seat] = client.guestId;
      room.seatNames[seat] = client.name || "";
      room.disconnectedSince[seat] = null;
      sessions.set(client.guestId, { room, seat });
      client.room = room;
      client.seat = seat;
      send(client, { type: "joined", code: room.code, seat });
      const other = room.seats[1 - seat];
      if (other) send(other, { type: "opponentJoined" });
      return;
    }
    case "submit": {
      const room = client.room;
      if (!room) throw new Error("部屋に入っていません");
      if (room.state) throw new Error("対戦はすでに始まっています");
      if (typeof msg.name === "string") client.name = msg.name.slice(0, 32);
      room.seatNames[client.seat] = client.name || "";
      room.subs[client.seat] = { deck: msg.deck, summoner: msg.summoner };
      const other = room.seats[1 - client.seat];
      if (other) send(other, { type: "opponentSubmitted" });
      if (room.subs[0] && room.subs[1]) {
        try {
          startGame(room);
        } catch (e) {
          room.subs = [null, null]; // 検証に落ちたら提出をやり直させる
          send(room.seats[0], { type: "error", message: `対戦を開始できません: ${e.message}` });
          send(room.seats[1], { type: "error", message: `対戦を開始できません: ${e.message}` });
          return;
        }
      }
      return;
    }
    case "action": {
      const room = client.room;
      if (!room || !room.state) throw new Error("対戦中ではありません");
      try {
        applyAction(room.state, client.seat, msg.action);
      } catch (e) {
        sendError(client, e.message || String(e)); // 違法な行動は送り主にだけ返す
        return;
      }
      broadcastViews(room);
      return;
    }
    case "rematch": {
      const room = client.room;
      if (!room || !room.state) throw new Error("対戦中ではありません");
      if (room.state.winner === null) throw new Error("対戦がまだ終わっていません");
      if (!room.rematch[client.seat]) {
        room.rematch[client.seat] = true;
        const other = room.seats[1 - client.seat];
        if (other) send(other, { type: "opponentRematch" });
      }
      const both = room.rematch[0] && room.rematch[1];
      send(client, { type: "rematchRequested", waiting: !both });
      if (both) {
        try {
          startGame(room); // デッキ・召喚士は前回の提出を引き継ぎ、先攻は再抽選
        } catch (e) {
          room.rematch = [false, false];
          for (let s = 0; s < 2; s++) {
            if (room.seats[s]) send(room.seats[s], { type: "error", message: `リマッチを開始できません: ${e.message}` });
          }
        }
      }
      return;
    }
    case "leave": {
      const room = client.room;
      if (!room) throw new Error("部屋に入っていません");
      const seat = client.seat;
      sessions.delete(client.guestId);
      room.seatGuests[seat] = null;
      room.seatNames[seat] = "";
      if (room.seats[seat] === client) room.seats[seat] = null;
      room.disconnectedSince[seat] = Date.now();
      room.rematch[seat] = false;
      client.room = null;
      client.seat = null;
      send(client, { type: "left", code: room.code });
      const other = room.seats[1 - seat];
      if (other) send(other, { type: "opponentLeft" });
      if (!room.seatGuests[0] && !room.seatGuests[1]) destroyRoom(room); // 両者退出で即片付け
      return;
    }
    default:
      throw new Error(`不明なメッセージ: ${msg.type}`);
  }
}

// 切断：席と対戦状態は保持し、相手へ通知するだけ。再接続は tryReattach が担う。
// 部屋の破棄は sweep（両席とも空席のまま保持上限を超過）が行う。
function handleDisconnect(client) {
  const room = client.room;
  const seat = client.seat;
  client.room = null;
  client.seat = null;
  if (!room || seat === null) return;
  if (room.seats[seat] === client) {
    room.seats[seat] = null;
    room.disconnectedSince[seat] = Date.now();
  }
  const other = room.seats[1 - seat];
  if (other) {
    send(other, { type: "opponentDisconnected" });
  }
}

httpServer.listen(PORT, () => {
  console.log(`arcane-pvp server listening on http://localhost:${PORT}`);
});
