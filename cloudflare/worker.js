// アーケインサモンΩ 対人サーバー ― Cloudflare Workers + Durable Objects 版
// 薄いトランスポート層。対戦・部屋管理の実体は core.js（トランスポート非依存）。
//
// 構成:
//   Worker（このファイルの default export）
//     - GET / , /test-client.html … 既存のテストクライアントを返す
//     - GET /cards.js             … テストクライアント表示用にカードデータを返す（Node版と同じ役割）
//     - WebSocket アップグレード   … GameServerDO（単一インスタンス "main"）へ中継
//   GameServerDO
//     - 全ての部屋を1つの DO が保持する（想定規模では十分）
//     - WebSocket Hibernation API（acceptWebSocket）で接続を保持し、
//       ソケット毎のセッション情報は serializeAttachment に載せる
//     - 部屋のスナップショットを DO の SQLite ストレージへ毎回保存し、
//       起動・ハイバネーション復帰時に core.restore + restoreConnection で再構築する
//     - 部屋の掃除は alarm（core.nextSweepTime が示す最速の失効時刻）で駆動する
//
// プロトコルは Node版と同一（core.js が処理する）。
//
// 勝ち抜きランキング API（2026-11-06 追加）:
//   POST /api/streak       … 連勝を登録（端末の guestId 単位、自己ベストのみ保持）
//   GET  /api/leaderboard  … 上位20件＋（pid 指定時）自分の順位
//   実体は GameServerDO の SQLite（テーブル lb）に置き、Worker が中継する。
//   v1 は自己申告方式（CPU戦はクライアント側で実行されるため）。

import { createCore } from "./core.js";
import { CARDS, TOKENS } from "../cards.js";
import testClientHtml from "../test-client.html";

const cardsModuleText =
  `export const CARDS = ${JSON.stringify(CARDS)};\n` +
  `export const TOKENS = ${JSON.stringify(TOKENS)};\n`;

export class GameServerDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.core = createCore();
    this.conns = new Map(); // WebSocket -> conn

    ctx.blockConcurrencyWhile(async () => {
      // スナップショット保存用テーブル（SQLite バックエンドの DO 前提）
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
      );
      // 勝ち抜きランキング用テーブル
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS lb (guestId TEXT PRIMARY KEY, name TEXT NOT NULL, streak INTEGER NOT NULL, summoner TEXT, updated INTEGER NOT NULL)"
      );
      const rows = this.ctx.storage.sql
        .exec("SELECT v FROM kv WHERE k = 'rooms'")
        .toArray();
      if (rows.length > 0) {
        try {
          this.core.restore(JSON.parse(rows[0].v));
        } catch {
          // 壊れたスナップショットで起動不能にしない（部屋は失われるが新規対戦は可能）
        }
      }
      // ハイバネーションから生き残ったソケットを、attachment の情報で席へ再登録する
      for (const ws of this.ctx.getWebSockets()) {
        let info = null;
        try {
          info = ws.deserializeAttachment();
        } catch {}
        const conn = this.core.restoreConnection(ws, info || {});
        this.conns.set(ws, conn);
      }
      await this.scheduleAlarm();
    });
  }

  // WebSocket アップグレードの受け口（Worker から中継される）
  // 勝ち抜きランキング API もここで処理する
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/streak" && request.method === "POST") {
      return this.apiPostStreak(request);
    }
    if (url.pathname === "/api/leaderboard" && request.method === "GET") {
      return this.apiGetLeaderboard(url);
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const conn = this.core.attach(server);
    this.conns.set(server, conn);
    this.saveAttachment(server, conn);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- 勝ち抜きランキング API ----

  lbRankOf(streak) {
    const rows = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS c FROM lb WHERE streak > ?", streak)
      .toArray();
    return (rows.length ? rows[0].c : 0) + 1;
  }

  async apiPostStreak(request) {
    let body = null;
    try {
      body = await request.json();
    } catch {}
    const guestId = body && typeof body.guestId === "string" ? body.guestId : "";
    const streak = body ? Math.floor(Number(body.streak)) : NaN;
    if (guestId.length < 8 || guestId.length > 64 || !Number.isFinite(streak) || streak < 1 || streak > 999) {
      return new Response(JSON.stringify({ ok: false, error: "invalid" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    let name = body && typeof body.name === "string" ? body.name.trim() : "";
    name = name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 20);
    if (!name) name = "名無し";
    const SUMMONERS = ["chloe", "garen", "bran", "mia", "olga"];
    const summoner = SUMMONERS.includes(body.summoner) ? body.summoner : null;
    const sql = this.ctx.storage.sql;
    const existing = sql
      .exec("SELECT streak FROM lb WHERE guestId = ?", guestId)
      .toArray();
    const best = existing.length ? Math.max(existing[0].streak, streak) : streak;
    if (!existing.length || streak >= existing[0].streak) {
      sql.exec(
        "INSERT INTO lb (guestId, name, streak, summoner, updated) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(guestId) DO UPDATE SET name = excluded.name, streak = excluded.streak, summoner = excluded.summoner, updated = excluded.updated",
        guestId, name, streak, summoner, Date.now()
      );
    }
    return new Response(
      JSON.stringify({ ok: true, best, rank: this.lbRankOf(best) }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  apiGetLeaderboard(url) {
    const sql = this.ctx.storage.sql;
    const top = sql
      .exec("SELECT name, streak, summoner FROM lb ORDER BY streak DESC, updated ASC LIMIT 20")
      .toArray();
    let me = null;
    const pid = url.searchParams.get("pid");
    if (pid && pid.length >= 8 && pid.length <= 64) {
      const rows = sql
        .exec("SELECT name, streak, summoner FROM lb WHERE guestId = ?", pid)
        .toArray();
      if (rows.length) {
        me = {
          name: rows[0].name,
          streak: rows[0].streak,
          summoner: rows[0].summoner,
          rank: this.lbRankOf(rows[0].streak),
        };
      }
    }
    return new Response(JSON.stringify({ ok: true, top, me }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  webSocketMessage(ws, message) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    this.core.handleMessage(conn, raw);
    this.saveAttachment(ws, conn); // guestId / 部屋 / 席 は hello や create/join で変わるため毎回更新
    this.afterEvent();
  }

  webSocketClose(ws) {
    const conn = this.conns.get(ws);
    this.conns.delete(ws);
    if (conn) this.core.handleClose(conn);
    this.afterEvent();
  }

  webSocketError(ws) {
    const conn = this.conns.get(ws);
    this.conns.delete(ws);
    if (conn) this.core.handleClose(conn);
    this.afterEvent();
  }

  async alarm() {
    this.core.sweep(Date.now());
    await this.persist();
    await this.scheduleAlarm();
  }

  // ソケット毎のセッション情報（復帰時に restoreConnection へ渡す）
  saveAttachment(ws, conn) {
    try {
      ws.serializeAttachment({
        v: 1,
        guestId: conn.guestId,
        name: conn.name,
        roomCode: conn.room ? conn.room.code : null,
        seat: conn.seat,
      });
    } catch {}
  }

  afterEvent() {
    this.ctx.waitUntil(
      (async () => {
        await this.persist();
        await this.scheduleAlarm();
      })()
    );
  }

  async persist() {
    const snap = this.core.snapshot();
    this.ctx.storage.sql.exec(
      "INSERT INTO kv (k, v) VALUES ('rooms', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      JSON.stringify(snap)
    );
  }

  // 次に掃除が必要になる時刻に alarm を合わせる（不要なら解除）
  async scheduleAlarm() {
    const next = this.core.nextSweepTime();
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      const stub = env.GAME_SERVER.get(env.GAME_SERVER.idFromName("main"));
      return stub.fetch(request);
    }
    if (url.pathname === "/api/streak" || url.pathname === "/api/leaderboard") {
      const stub = env.GAME_SERVER.get(env.GAME_SERVER.idFromName("main"));
      return stub.fetch(request);
    }
    if (url.pathname === "/" || url.pathname === "/test-client.html") {
      return new Response(testClientHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/cards.js") {
      return new Response(cardsModuleText, {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
};
