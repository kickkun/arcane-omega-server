// アーケインサモンΩ 対人サーバーの「セッション／部屋コア」
// Node版 server.js の部屋管理・プロトコル処理を、トランスポート非依存に切り出したもの。
// プロトコル（JSONメッセージの種類と形）は Node版と完全に同一。
//
// ソケットの最小インターフェース（ws / Cloudflare WebSocket / テスト用フェイク共通）:
//   sock.readyState  … 1 のときだけ送信する（Node版の send ガードと同一）
//   sock.send(text)  … 文字列を送る
//   sock.close()     … 閉じる（古い接続の押し出し時に使用）
//
// 使い方:
//   const core = createCore({ onMutate: () => persist(core.snapshot()) });
//   const conn = core.attach(sock);
//   core.handleMessage(conn, rawText);   // 受信時
//   core.handleClose(conn);              // 切断時
//   core.sweep();                        // 定期実行（ホストがスケジュールする）
//   core.restore(snapshot);              // 起動・復帰時（DOのストレージ等から）
//   core.restoreConnection(sock, info);  // ハイバネーション復帰時の接続再登録（DO用）

import { createGame, applyAction, legalActions, defOf, effAtk, effMaxHp, effHp } from "../engine.js";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const DEFAULT_GRACE_MS = 30 * 60 * 1000;

export function createCore(options = {}) {
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const graceMs = options.reconnectGraceMs ?? DEFAULT_GRACE_MS;
  const onMutate = typeof options.onMutate === "function" ? options.onMutate : null;

  const rooms = new Map(); // code -> room
  const sessions = new Map(); // guestId -> { room, seat }

  // room = {
  //   code,
  //   seats: [conn|null, conn|null],          現在つながっている接続（実行時のみ・保存対象外）
  //   seatGuests: [guestId|null, guestId|null],
  //   seatNames: [string, string],
  //   subs: [{deck,summoner}|null, {...}|null],
  //   state,                                   エンジンの対戦状態（未開始は null）
  //   rematch: [bool, bool],
  //   disconnectedSince: [ts|null, ts|null],
  // }
  // conn = { sock, guestId, name, room, seat }

  function notify() {
    if (onMutate) {
      try {
        onMutate();
      } catch {
        // 永続化側の失敗で対戦処理自体は止めない
      }
    }
  }

  function newCode() {
    for (;;) {
      let code = "";
      for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(random() * CODE_CHARS.length)];
      if (!rooms.has(code)) return code;
    }
  }

  function newGuestId() {
    return "g-" + Math.random().toString(36).slice(2, 10);
  }

  function send(conn, obj) {
    if (!conn || !conn.sock) return; // Node版は空席への送信が到達しない作り。ここでは安全側に倒す
    if (conn.sock.readyState === 1) conn.sock.send(JSON.stringify(obj));
  }

  function sendError(conn, message) {
    send(conn, { type: "error", message });
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
  function sweep(t = now()) {
    let changed = false;
    for (const room of [...rooms.values()]) {
      let destroy = true;
      for (let s = 0; s < 2; s++) {
        if (room.seats[s]) {
          destroy = false;
          break;
        }
        const since = room.disconnectedSince[s];
        if (since === null || t - since < graceMs) {
          destroy = false;
          break;
        }
      }
      if (destroy) {
        destroyRoom(room);
        changed = true;
      }
    }
    if (changed) notify();
    return changed;
  }

  // 次に掃除が必要になり得る最も早い時刻（DO の alarm スケジュール用）。
  // 該当がなければ null。
  function nextSweepTime() {
    let best = null;
    for (const room of rooms.values()) {
      if (room.seats[0] || room.seats[1]) continue; // 接続中の席がある部屋は破棄されない
      let latest = null;
      for (let s = 0; s < 2; s++) {
        const since = room.disconnectedSince[s];
        if (since === null) {
          latest = null;
          break;
        }
        latest = latest === null ? since : Math.max(latest, since);
      }
      if (latest !== null) {
        const at = latest + graceMs;
        if (best === null || at < best) best = at;
      }
    }
    return best;
  }

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
    const conn = room.seats[seat];
    return {
      seat,
      name: (conn && conn.name) || room.seatNames[seat] || "",
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
      first: random() < 0.5 ? 0 : 1, // 先攻はランダム（リマッチでも再抽選）
    });
    room.rematch = [false, false];
    broadcastViews(room);
  }

  // ---------- 接続の登録・再接続 ----------

  function attach(sock) {
    return { sock, guestId: newGuestId(), name: "", room: null, seat: null };
  }

  // hello の guestId に席の予約があれば、その席に接続を戻す
  function tryReattach(conn) {
    if (conn.room) return;
    const sess = sessions.get(conn.guestId);
    if (!sess) return;
    const room = sess.room;
    if (rooms.get(room.code) !== room || room.seatGuests[sess.seat] !== conn.guestId) {
      sessions.delete(conn.guestId); // 予約が失効していたら掃除する
      return;
    }
    const seat = sess.seat;
    const old = room.seats[seat];
    if (old && old !== conn) {
      // 同じ席に古い接続が残っていたら新しい接続を優先する
      old.room = null;
      old.seat = null;
      try {
        old.sock.close();
      } catch {}
    }
    room.seats[seat] = conn;
    room.disconnectedSince[seat] = null;
    if (conn.name) room.seatNames[seat] = conn.name;
    conn.room = room;
    conn.seat = seat;
    send(conn, { type: "rejoined", code: room.code, seat });
    const other = room.seats[1 - seat];
    if (other) send(other, { type: "opponentReconnected" });
    if (room.state) send(conn, buildView(room, seat)); // 対戦中なら現在のビューで復帰
  }

  // ハイバネーション復帰用：生きているソケットを、保存済みのセッション情報で
  // コアに再登録する。メッセージは送らない（クライアントからは無断絶に見えない）。
  function restoreConnection(sock, info) {
    const conn = {
      sock,
      guestId: typeof info?.guestId === "string" && info.guestId ? info.guestId : newGuestId(),
      name: typeof info?.name === "string" ? info.name : "",
      room: null,
      seat: null,
    };
    const room = info ? rooms.get(info.roomCode) : undefined;
    const seat = info ? info.seat : null;
    if (room && (seat === 0 || seat === 1) && room.seatGuests[seat] === conn.guestId && !room.seats[seat]) {
      room.seats[seat] = conn;
      room.disconnectedSince[seat] = null;
      conn.room = room;
      conn.seat = seat;
      sessions.set(conn.guestId, { room, seat });
    }
    return conn;
  }

  // ---------- メッセージ処理 ----------

  function handleMessage(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      sendError(conn, "JSONとして解釈できません");
      return;
    }
    try {
      dispatch(conn, msg);
    } catch (e) {
      sendError(conn, e.message || String(e));
    }
    notify();
  }

  function dispatch(conn, msg) {
    switch (msg.type) {
      case "hello": {
        if (typeof msg.guestId === "string" && msg.guestId.length > 0 && msg.guestId.length <= 64) {
          conn.guestId = msg.guestId;
        }
        if (typeof msg.name === "string") conn.name = msg.name.slice(0, 32);
        send(conn, { type: "welcome", guestId: conn.guestId });
        tryReattach(conn);
        return;
      }
      case "create": {
        if (conn.room) throw new Error("すでに部屋に入っています");
        const code = newCode();
        const room = {
          code,
          seats: [conn, null],
          seatGuests: [conn.guestId, null],
          seatNames: [conn.name || "", ""],
          subs: [null, null],
          state: null,
          rematch: [false, false],
          disconnectedSince: [null, now()],
        };
        rooms.set(code, room);
        sessions.set(conn.guestId, { room, seat: 0 });
        conn.room = room;
        conn.seat = 0;
        send(conn, { type: "roomCreated", code, seat: 0 });
        return;
      }
      case "join": {
        if (conn.room) throw new Error("すでに部屋に入っています");
        const room = rooms.get(String(msg.code || "").toUpperCase());
        if (!room) throw new Error("そのルームコードの部屋はありません");
        if (room.seatGuests[0] && room.seatGuests[1]) throw new Error("その部屋は満員です");
        const seat = room.seatGuests[0] ? 1 : 0;
        room.seats[seat] = conn;
        room.seatGuests[seat] = conn.guestId;
        room.seatNames[seat] = conn.name || "";
        room.disconnectedSince[seat] = null;
        sessions.set(conn.guestId, { room, seat });
        conn.room = room;
        conn.seat = seat;
        send(conn, { type: "joined", code: room.code, seat });
        const other = room.seats[1 - seat];
        if (other) send(other, { type: "opponentJoined" });
        return;
      }
      case "submit": {
        const room = conn.room;
        if (!room) throw new Error("部屋に入っていません");
        if (room.state) throw new Error("対戦はすでに始まっています");
        if (typeof msg.name === "string") conn.name = msg.name.slice(0, 32);
        room.seatNames[conn.seat] = conn.name || "";
        room.subs[conn.seat] = { deck: msg.deck, summoner: msg.summoner };
        const other = room.seats[1 - conn.seat];
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
        const room = conn.room;
        if (!room || !room.state) throw new Error("対戦中ではありません");
        try {
          applyAction(room.state, conn.seat, msg.action);
        } catch (e) {
          sendError(conn, e.message || String(e)); // 違法な行動は送り主にだけ返す
          return;
        }
        broadcastViews(room);
        return;
      }
      case "rematch": {
        const room = conn.room;
        if (!room || !room.state) throw new Error("対戦中ではありません");
        if (room.state.winner === null) throw new Error("対戦がまだ終わっていません");
        if (!room.rematch[conn.seat]) {
          room.rematch[conn.seat] = true;
          const other = room.seats[1 - conn.seat];
          if (other) send(other, { type: "opponentRematch" });
        }
        const both = room.rematch[0] && room.rematch[1];
        send(conn, { type: "rematchRequested", waiting: !both });
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
        const room = conn.room;
        if (!room) throw new Error("部屋に入っていません");
        const seat = conn.seat;
        sessions.delete(conn.guestId);
        room.seatGuests[seat] = null;
        room.seatNames[seat] = "";
        if (room.seats[seat] === conn) room.seats[seat] = null;
        room.disconnectedSince[seat] = now();
        room.rematch[seat] = false;
        conn.room = null;
        conn.seat = null;
        send(conn, { type: "left", code: room.code });
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
  function handleClose(conn) {
    const room = conn.room;
    const seat = conn.seat;
    conn.room = null;
    conn.seat = null;
    if (!room || seat === null) {
      notify();
      return;
    }
    if (room.seats[seat] === conn) {
      room.seats[seat] = null;
      room.disconnectedSince[seat] = now();
    }
    const other = room.seats[1 - seat];
    if (other) {
      send(other, { type: "opponentDisconnected" });
    }
    notify();
  }

  // ---------- 永続化（DO のストレージ向けスナップショット） ----------

  // 接続（seats）は実行時オブジェクトなので保存しない。
  // sessions は seatGuests から再構築できるため保存しない。
  function snapshot() {
    const data = {
      v: 1,
      rooms: [...rooms.values()].map((room) => ({
        code: room.code,
        seatGuests: [...room.seatGuests],
        seatNames: [...room.seatNames],
        subs: room.subs,
        state: room.state,
        rematch: [...room.rematch],
        disconnectedSince: [...room.disconnectedSince],
      })),
    };
    // JSON化できること（＝DOストレージに保存できること）を保証する
    return JSON.parse(JSON.stringify(data));
  }

  function restore(snap) {
    rooms.clear();
    sessions.clear();
    if (!snap || !Array.isArray(snap.rooms)) return;
    for (const r of snap.rooms) {
      const room = {
        code: r.code,
        seats: [null, null],
        seatGuests: [r.seatGuests?.[0] ?? null, r.seatGuests?.[1] ?? null],
        seatNames: [r.seatNames?.[0] ?? "", r.seatNames?.[1] ?? ""],
        subs: [r.subs?.[0] ?? null, r.subs?.[1] ?? null],
        state: r.state ?? null,
        rematch: [!!r.rematch?.[0], !!r.rematch?.[1]],
        disconnectedSince: [r.disconnectedSince?.[0] ?? null, r.disconnectedSince?.[1] ?? null],
      };
      rooms.set(room.code, room);
      for (let s = 0; s < 2; s++) {
        if (room.seatGuests[s]) sessions.set(room.seatGuests[s], { room, seat: s });
      }
    }
  }

  return {
    attach,
    restoreConnection,
    handleMessage,
    handleClose,
    sweep,
    nextSweepTime,
    snapshot,
    restore,
    roomCount: () => rooms.size,
  };
}
