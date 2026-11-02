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
  async fetch(request) {
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
