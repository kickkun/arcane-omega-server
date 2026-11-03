// アーケインサモンΩ（対人版）ルールエンジン ― サーバー権威型
// 状態とルール判定はすべてここが正。クライアントは「意図」だけを送る。
// カードデータの正は ~/workspace/game-cards/cards.md、本ファイルは cards.js を import して使う。
//
// state の形:
// {
//   players: [{ summoner, life, deck:[cardId], hand:[cardId], field:[unit],
//               manaMax, mana, turnCount, coin }],
//   turn, first, turnSeq, pending, winner, nextUid, log
// }
// unit の形:
// { uid, cardId|null, token|null, owner, atkBase, atkMod, hpBase, hpMod, damage,
//   grantedWall, grantedCounter, grantedHaste, grantedArmor, enteredSeq, attacksLeft,
//   bonusAttackUsed }
//   実効攻撃力 = max(0, atkBase + atkMod) / 実効最大HP = hpBase + hpMod / 残HP = 最大HP - damage
//   卵（cardId 53）は孵化で cardId が 901（黒のアギト）に変わり、スタッツと damage を引き継ぐ。
//   bonusAttackUsed はロンギヌスの「倒したら追加攻撃1回まで」の消費フラグ（自ターン開始時にリセット）。
//
// pending の形:
//   { type:"effectTarget", player, effect, sourceUid, queue } … 登場時効果の対象選択待ち
//   { type:"blancWall", player } … ブランの鉄壁付与の対象選択待ち
// pending 中は、その player の chooseTarget（と投了）以外をすべて拒否する。

import { CARDS, TOKENS } from "./cards.js";

const CARD_MAP = new Map(CARDS.map((c) => [c.id, c]));
export const SUMMONERS = ["chloe", "garen", "blanc", "mia", "olga"];

const MAX_LIFE = 20;
const FIELD_MAX = 5;
const MANA_CAP = 10;
const DECK_SIZE = 20;
const MAX_COPIES = 3;

function fail(msg) {
  throw new Error(msg);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- ユニットの基本情報 ----------

export function defOf(unit) {
  if (unit.token) {
    const t = TOKENS[unit.token];
    return { id: 0, name: t.name, cost: 0, type: "unit", keywords: [], onPlay: [] };
  }
  return CARD_MAP.get(unit.cardId);
}

export function effAtk(u) {
  return Math.max(0, u.atkBase + u.atkMod);
}
export function effMaxHp(u) {
  return u.hpBase + u.hpMod;
}
export function effHp(u) {
  return effMaxHp(u) - u.damage;
}

export function hasKw(u, kw) {
  const d = defOf(u);
  if (kw === "wall") return d.keywords.includes("wall") || u.grantedWall;
  if (kw === "counter") return d.keywords.includes("counter") || u.grantedCounter;
  if (kw === "haste") return d.keywords.includes("haste") || u.grantedHaste;
  if (kw === "armor") return d.keywords.includes("armor") || u.grantedArmor;
  return d.keywords.includes(kw);
}

// 黒竜の卵（未孵化）かどうか。孵化すると cardId が 901 になり、def から egg が外れる。
function isEgg(u) {
  return !!defOf(u).egg;
}

function maxAttacks(u) {
  const d = defOf(u);
  return d.passive && d.passive.multiAttack ? d.passive.multiAttack : 1;
}

export function findUnit(state, uid) {
  for (let p = 0; p < 2; p++) {
    const u = state.players[p].field.find((x) => x.uid === uid);
    if (u) return { unit: u, player: p };
  }
  return null;
}

// ダーククイーンの守り：自場に他のユニットがいる限り、相手の対象に選べない
function isProtected(state, unit, fieldPlayer) {
  const d = defOf(unit);
  if (!d.passive || !d.passive.protection) return false;
  return state.players[fieldPlayer].field.some((x) => x.uid !== unit.uid);
}

export function spawnUnit(state, cardIdOrToken, owner) {
  let cardId = null;
  let token = null;
  let base;
  if (typeof cardIdOrToken === "string") {
    token = cardIdOrToken;
    base = TOKENS[token];
    if (!base) fail(`存在しないトークン: ${token}`);
  } else {
    cardId = cardIdOrToken;
    base = CARD_MAP.get(cardId);
    if (!base) fail(`存在しないカードID: ${cardId}`);
  }
  return {
    uid: state.nextUid++,
    cardId,
    token,
    owner,
    atkBase: base.atk,
    atkMod: 0,
    hpBase: base.hp,
    hpMod: 0,
    damage: 0,
    grantedWall: false,
    grantedCounter: false,
    grantedHaste: false,
    grantedArmor: false,
    enteredSeq: state.turnSeq,
    attacksLeft: 0,
    bonusAttackUsed: false,
  };
}

// ---------- デッキ検証 ----------

export function validateDeck(deck) {
  if (!Array.isArray(deck) || deck.length !== DECK_SIZE) {
    fail(`デッキは${DECK_SIZE}枚ちょうど必要です`);
  }
  const counts = new Map();
  const mythics = new Set();
  for (const id of deck) {
    const c = CARD_MAP.get(id);
    if (!c) fail(`存在しないカードID: ${id}`);
    if (c.form) fail(`形態カードはデッキに入れられません: ${c.name}`);
    counts.set(id, (counts.get(id) || 0) + 1);
    if (counts.get(id) > MAX_COPIES) fail(`同名カードは${MAX_COPIES}枚までです: ${c.name}`);
    if (c.mythic) mythics.add(id);
  }
  if (mythics.size > 1) fail("神話は1種類のみしか入れられません");
}

// ---------- ライフ・ドロー ----------

function damageLeader(state, p, amount) {
  state.players[p].life -= amount;
}
function healLeader(state, p, amount) {
  state.players[p].life = Math.min(MAX_LIFE, state.players[p].life + amount);
}

// 山札切れは自召喚士へ1ダメージ
function drawCards(state, p, n) {
  const pl = state.players[p];
  for (let i = 0; i < n; i++) {
    if (pl.deck.length === 0) damageLeader(state, p, 1);
    else pl.hand.push(pl.deck.pop());
  }
}

// 同時敗北は「その行動・効果を起こした側（actor）」の負け（暫定裁定）
function checkWin(state, actor) {
  if (state.winner != null) return;
  const d0 = state.players[0].life <= 0;
  const d1 = state.players[1].life <= 0;
  if (d0 && d1) state.winner = 1 - actor;
  else if (d0) state.winner = 1;
  else if (d1) state.winner = 0;
  if (state.winner != null) state.log.push(`勝敗決定: winner=${state.winner}`);
}

// ---------- ダメージ・破壊・死亡時効果 ----------

// ユニットへのダメージ。装甲で1軽減。opts.sourceUid はダメージ源のユニット（反撃判定用）、
// opts.isCounter のときは反撃ダメージ（連鎖しない）。
function dealUnitDamage(state, uid, amount, opts = {}) {
  const loc = findUnit(state, uid);
  if (!loc) return 0;
  const u = loc.unit;
  if (isEgg(u)) return 0; // 卵は効果ダメージを受けない（戦闘では対象に選べない）
  let amt = amount;
  if (hasKw(u, "armor")) amt = Math.max(0, amt - 1);
  u.damage += amt;
  // 反撃：ユニットから1以上のダメージを受けたら発生源へ1（倒されても発動＝除去前に処理する）
  if (amt >= 1 && hasKw(u, "counter") && opts.sourceUid && !opts.isCounter) {
    dealUnitDamage(state, opts.sourceUid, 1, { sourceUid: u.uid, isCounter: true });
  }
  return amt;
}

function runOnDeath(state, unit, controller) {
  const d = defOf(unit);
  if (!d.onDeath) return;
  for (const eff of d.onDeath) {
    if (eff.kind === "draw") drawCards(state, controller, eff.amount);
    else if (eff.kind === "damageLeader") damageLeader(state, 1 - controller, eff.amount);
  }
}

// 破壊効果（装甲・反撃を無視して場から取り除く）。卵は効果で破壊されない。
function destroyUnit(state, uid) {
  const loc = findUnit(state, uid);
  if (!loc) return;
  if (isEgg(loc.unit)) return;
  state.players[loc.player].field = state.players[loc.player].field.filter((x) => x.uid !== uid);
  runOnDeath(state, loc.unit, loc.player);
}

// HPが0以下になったユニットを除去し、死亡時効果を解決する（連鎖が止まるまで繰り返す）
function cleanupDeaths(state) {
  for (;;) {
    const dead = [];
    for (let p = 0; p < 2; p++) {
      for (const u of state.players[p].field) {
        if (effHp(u) <= 0) dead.push({ u, p });
      }
    }
    if (dead.length === 0) return;
    for (const { u, p } of dead) {
      state.players[p].field = state.players[p].field.filter((x) => x.uid !== u.uid);
    }
    for (const { u, p } of dead) runOnDeath(state, u, p);
  }
}

// ---------- 効果解決 ----------

const TARGETED_KINDS = new Set([
  "damageUnit",
  "destroyUnit",
  "destroyUnitIfHpLE",
  "destroyDamagedUnit",
  "bounceUnit",
  "debuffUnit",
  "buffUnit",
  "grantCounter",
  "stealUnit",
]);

// 効果の合法対象（uid一覧）。守り状態のダーククイーンは敵対象から除外する。
// 卵は敵効果の対象に選べない。例外はバウンスと奪取のみ（SPEC裁定）。
function fxTargets(state, controller, eff) {
  const enemy = 1 - controller;
  const eField = state.players[enemy].field;
  const targetableEnemy = eField.filter((u) => !isProtected(state, u, enemy));
  const hittableEnemy = targetableEnemy.filter((u) => !isEgg(u));
  switch (eff.kind) {
    case "damageUnit":
    case "destroyUnit":
    case "debuffUnit":
      return hittableEnemy.map((u) => u.uid);
    case "bounceUnit":
    case "stealUnit":
      return targetableEnemy.map((u) => u.uid);
    case "destroyUnitIfHpLE":
      return hittableEnemy.filter((u) => effHp(u) <= eff.value).map((u) => u.uid);
    case "destroyDamagedUnit":
      return hittableEnemy.filter((u) => u.damage > 0).map((u) => u.uid);
    case "buffUnit":
    case "grantCounter":
      return state.players[controller].field.map((u) => u.uid);
    default:
      return [];
  }
}

function applyTargetEffect(state, controller, eff, uid, sourceUid) {
  switch (eff.kind) {
    case "damageUnit":
      dealUnitDamage(state, uid, eff.amount, { sourceUid });
      break;
    case "destroyUnit":
    case "destroyUnitIfHpLE":
    case "destroyDamagedUnit":
      destroyUnit(state, uid);
      break;
    case "bounceUnit": {
      const loc = findUnit(state, uid);
      if (!loc) break;
      state.players[loc.player].field = state.players[loc.player].field.filter((x) => x.uid !== uid);
      // 手札に戻るのはカードの持ち主。トークンは手札に戻らず消滅する（暫定裁定）
      // バウンスされた黒のアギトは、手札では卵（53）に戻る（SPEC裁定）
      if (!loc.unit.token) {
        const backId = loc.unit.cardId === 901 ? 53 : loc.unit.cardId;
        state.players[loc.unit.owner].hand.push(backId);
      }
      break;
    }
    case "debuffUnit": {
      const loc = findUnit(state, uid);
      if (loc) loc.unit.atkMod += eff.atk; // 実効値は effAtk で最低0に丸める
      break;
    }
    case "buffUnit": {
      const loc = findUnit(state, uid);
      if (loc) {
        loc.unit.atkMod += eff.atk;
        loc.unit.hpMod += eff.hp;
      }
      break;
    }
    case "grantCounter": {
      const loc = findUnit(state, uid);
      if (loc) loc.unit.grantedCounter = true;
      break;
    }
    case "stealUnit": {
      const loc = findUnit(state, uid);
      if (!loc) break;
      if (state.players[controller].field.length >= FIELD_MAX) break;
      state.players[loc.player].field = state.players[loc.player].field.filter((x) => x.uid !== uid);
      const u = loc.unit;
      // 奪ったユニットは、場に出たターンでなければそのターンから攻撃できる（現行版の裁定を踏襲）
      u.attacksLeft = u.enteredSeq < state.turnSeq ? maxAttacks(u) : 0;
      state.players[controller].field.push(u);
      break;
    }
  }
}

function applyAutoEffect(state, controller, eff, sourceUid) {
  const enemy = 1 - controller;
  switch (eff.kind) {
    case "damageLeader":
      damageLeader(state, enemy, eff.amount);
      break;
    case "healLeader":
      healLeader(state, controller, eff.amount);
      break;
    case "draw":
      drawCards(state, controller, eff.amount);
      break;
    case "damageAllEnemy":
      for (const uid of state.players[enemy].field.map((u) => u.uid)) {
        dealUnitDamage(state, uid, eff.amount, { sourceUid });
      }
      break;
    case "damageAllOther":
      for (let p = 0; p < 2; p++) {
        for (const uid of state.players[p].field.map((u) => u.uid)) {
          if (uid !== sourceUid) dealUnitDamage(state, uid, eff.amount, { sourceUid });
        }
      }
      break;
    case "destroyAllCostLE":
      for (let p = 0; p < 2; p++) {
        for (const uid of state.players[p].field.map((u) => u.uid)) {
          const loc = findUnit(state, uid);
          if (loc && uid !== sourceUid && defOf(loc.unit).cost <= eff.value) destroyUnit(state, uid);
        }
      }
      break;
    case "destroyAllAndHands": {
      // EX-キャリバー登場時：(a) 自分以外の両場ユニットを破壊（死亡時効果は通常処理、
      // 卵は破壊されず数えない）→ (b) その時点の両手札をすべて破壊
      // → (c) 破壊総数ぶん EX の攻/体を+1（上限なし）
      let count = 0;
      for (let p = 0; p < 2; p++) {
        for (const uid of state.players[p].field.map((u) => u.uid)) {
          if (uid === sourceUid) continue;
          const loc = findUnit(state, uid);
          if (!loc || isEgg(loc.unit)) continue;
          destroyUnit(state, uid);
          count++;
        }
      }
      for (let p = 0; p < 2; p++) {
        count += state.players[p].hand.length;
        state.players[p].hand = [];
      }
      const self = sourceUid != null ? findUnit(state, sourceUid) : null;
      if (self) {
        self.unit.atkMod += count;
        self.unit.hpMod += count;
      }
      break;
    }
    case "summonToken":
      if (state.players[controller].field.length < FIELD_MAX) {
        state.players[controller].field.push(spawnUnit(state, eff.token, controller));
      }
      break;
    case "buffAllAllies":
      for (const u of state.players[controller].field) {
        if (u.uid === sourceUid) continue; // 自身は除く
        u.atkMod += eff.atk;
        u.hpMod += eff.hp;
      }
      break;
  }
}

// 効果キューの解決。対象選択が要る効果に当たったら pending を立てて止まる。
// queue = { effects, i, controller, sourceUid }
function runFx(state, queue) {
  while (queue.i < queue.effects.length) {
    if (state.winner != null) return;
    const eff = queue.effects[queue.i];
    if (TARGETED_KINDS.has(eff.kind)) {
      // 奪取は自場に空きがある時だけ成立する
      if (eff.kind === "stealUnit" && state.players[queue.controller].field.length >= FIELD_MAX) {
        queue.i++;
        continue;
      }
      const targets = fxTargets(state, queue.controller, eff);
      if (targets.length === 0) {
        queue.i++; // 対象がいなければ不発（他の効果は独立に処理する）
        continue;
      }
      state.pending = {
        type: "effectTarget",
        player: queue.controller,
        effect: eff,
        sourceUid: queue.sourceUid,
        queue: { effects: queue.effects, i: queue.i + 1, controller: queue.controller, sourceUid: queue.sourceUid },
      };
      return;
    }
    applyAutoEffect(state, queue.controller, eff, queue.sourceUid);
    queue.i++;
    cleanupDeaths(state);
  }
}

// ---------- ターン開始処理 ----------

function beginTurn(state, p, opts = {}) {
  state.turn = p;
  state.turnSeq++;
  const pl = state.players[p];
  pl.turnCount++;
  pl.manaMax = Math.min(MANA_CAP, pl.manaMax + 1);
  pl.mana = pl.manaMax;
  // クロエ：自分の偶数ターン開始時、そのターンのみ魔力+1
  if (pl.summoner === "chloe" && pl.turnCount % 2 === 0) pl.mana += 1;
  if (!opts.skipDraw) drawCards(state, p, 1);
  checkWin(state, p);
  if (state.winner != null) return;

  // リーリャの守護の儀：場に出たターンを除く。デッキにセレスティアがあれば自壊して呼ぶ
  const riryas = pl.field.filter((u) => u.cardId === 40 && u.enteredSeq < state.turnSeq);
  for (const r of riryas) {
    if (state.winner != null) return;
    if (!findUnit(state, r.uid)) continue;
    const idx = pl.deck.indexOf(39);
    if (idx === -1) continue; // セレスティアがなければ何も起きず残る
    pl.deck.splice(idx, 1);
    pl.field = pl.field.filter((x) => x.uid !== r.uid); // 自壊（死亡時効果なし）
    const cel = spawnUnit(state, 39, p);
    pl.field.push(cel);
    runFx(state, { effects: defOf(cel).onPlay, i: 0, controller: p, sourceUid: cel.uid });
    cleanupDeaths(state);
    checkWin(state, p);
    if (state.winner != null) return;
  }

  // 攻撃回数の回復と成長（場に出たターンを除く）
  // ミラージュ：攻撃+1。黒竜の卵：+2/+2（孵化で止まる。def の egg が外れるため）。
  for (const u of pl.field) {
    u.bonusAttackUsed = false; // ロンギヌスの追加攻撃は、そのユニットのターン毎に1回まで
    if (u.enteredSeq < state.turnSeq) {
      u.attacksLeft = maxAttacks(u);
      const d = defOf(u);
      if (d.passive && d.passive.growthAtk) u.atkMod += d.passive.growthAtk;
      if (d.egg) {
        u.atkMod += 2;
        u.hpMod += 2;
      }
    } else {
      u.attacksLeft = 0;
    }
  }

  // オルガ：自分のターン数が3の倍数なら1ドロー
  if (pl.summoner === "olga" && pl.turnCount % 3 === 0) {
    drawCards(state, p, 1);
    checkWin(state, p);
    if (state.winner != null) return;
  }

  // ブラン：自分のターン開始時、味方1体に鉄壁を付与（対象選択待ち）
  if (pl.summoner === "blanc" && pl.field.length > 0) {
    state.pending = { type: "blancWall", player: p };
  }
}

function doEndTurn(state, p) {
  const pl = state.players[p];
  const enemy = 1 - p;
  // ソレイユ：自分のターン終了時、自召喚士を回復（複数いれば累積）
  for (const u of pl.field) {
    const d = defOf(u);
    if (d.passive && d.passive.endTurnHeal) healLeader(state, p, d.passive.endTurnHeal);
  }
  if (pl.summoner === "garen") damageLeader(state, enemy, 1);
  if (pl.summoner === "mia") healLeader(state, p, 1);
  checkWin(state, p);
  if (state.winner != null) return;
  beginTurn(state, enemy, {});
}

// ---------- ゲーム生成 ----------

export function createGame({ deckA, deckB, summonerA, summonerB, first }) {
  validateDeck(deckA);
  validateDeck(deckB);
  if (!SUMMONERS.includes(summonerA) || !SUMMONERS.includes(summonerB)) fail("召喚士が不正です");
  if (first !== 0 && first !== 1) fail("first は 0 か 1 で指定してください");
  const mkPlayer = (deck, summoner) => ({
    summoner,
    life: MAX_LIFE,
    deck: shuffle([...deck]),
    hand: [],
    field: [],
    manaMax: 0,
    mana: 0,
    turnCount: 0,
    coin: false,
  });
  const state = {
    players: [mkPlayer(deckA, summonerA), mkPlayer(deckB, summonerB)],
    turn: first,
    first,
    turnSeq: 0,
    pending: null,
    winner: null,
    nextUid: 1,
    log: [],
  };
  const second = 1 - first;
  for (let i = 0; i < 4; i++) state.players[first].hand.push(state.players[first].deck.pop());
  for (let i = 0; i < 5; i++) state.players[second].hand.push(state.players[second].deck.pop());
  state.players[second].coin = true; // 後攻補償：追い上げコイン
  state.log.push(`対戦開始 first=${first}`);
  beginTurn(state, first, { skipDraw: true }); // 先行の1ターン目だけドローなし
  return state;
}

// ---------- アクション ----------

function doPlayCard(state, p, handIndex) {
  const pl = state.players[p];
  if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= pl.hand.length) {
    fail("手札の指定が不正です");
  }
  const cardId = pl.hand[handIndex];
  const card = CARD_MAP.get(cardId);
  if (card.cost > pl.mana) fail("魔力が足りません");
  if (card.type === "unit") {
    if (pl.field.length >= FIELD_MAX) fail("場が満杯です");
    // セレスティアの結界：両者はコスト3以下のユニットを手札から出せない
    for (let q = 0; q < 2; q++) {
      for (const u of state.players[q].field) {
        const d = defOf(u);
        if (d.passive && d.passive.barrier && card.cost <= d.passive.barrier) {
          fail("結界により、そのユニットは出せません");
        }
      }
    }
  } else {
    // 対象必須のスペルは、合法対象がいなければ使えない（暫定裁定）
    for (const eff of card.onPlay) {
      if (TARGETED_KINDS.has(eff.kind) && fxTargets(state, p, eff).length === 0) {
        fail("対象がいません");
      }
    }
  }
  pl.mana -= card.cost;
  pl.hand.splice(handIndex, 1);
  if (card.type === "spell") {
    runFx(state, { effects: card.onPlay, i: 0, controller: p, sourceUid: null });
  } else {
    const u = spawnUnit(state, cardId, p);
    // 召喚酔い。速攻は即攻撃可。突破（ロンギヌス）も場に出たターンから攻撃できるが、
    // 敵召喚士への攻撃だけが doAttack 側で禁止される。
    u.attacksLeft = hasKw(u, "haste") || hasKw(u, "rush") ? maxAttacks(u) : 0;
    pl.field.push(u);
    runFx(state, { effects: card.onPlay, i: 0, controller: p, sourceUid: u.uid });
  }
  cleanupDeaths(state);
}

// 攻撃可能な対象。鉄壁がいる間は鉄壁のみ（守り状態のユニットは対象から外れる。
// 鉄壁が全て守り状態なら、他の対象が解禁される ― 暫定裁定）。
// 黒竜の卵は攻撃の対象に選べない（壁でもないので、顔への攻撃は素通りする）。
function attackTargets(state, p) {
  const enemy = 1 - p;
  const eField = state.players[enemy].field;
  const walls = eField.filter((u) => hasKw(u, "wall") && !isProtected(state, u, enemy));
  if (walls.length > 0) return { leader: false, units: walls.map((u) => u.uid) };
  return {
    leader: true,
    units: eField.filter((u) => !isProtected(state, u, enemy) && !isEgg(u)).map((u) => u.uid),
  };
}

function doAttack(state, p, attackerUid, target) {
  const pl = state.players[p];
  const atk = pl.field.find((u) => u.uid === attackerUid);
  if (!atk) fail("攻撃ユニットが自分の場にいません");
  const ad = defOf(atk);
  if (ad.egg) fail("黒竜の卵は攻撃できません");
  if (atk.attacksLeft <= 0) fail("そのユニットはもう攻撃できません");
  const entryTurn = atk.enteredSeq === state.turnSeq;
  const legal = attackTargets(state, p);
  if (target === "leader") {
    if (!legal.leader) fail("鉄壁ユニットがいるため、召喚士を攻撃できません");
    // 突破：場に出たターンは敵召喚士に攻撃できない（追加攻撃も同じ）
    if (entryTurn && ad.keywords.includes("rush")) {
      fail("突破：場に出たターンは召喚士を攻撃できません");
    }
    atk.attacksLeft--;
    damageLeader(state, 1 - p, effAtk(atk));
    return;
  }
  if (!legal.units.includes(target)) fail("その対象は攻撃できません");
  const def = findUnit(state, target).unit;
  atk.attacksLeft--;
  let killed = false;
  if (ad.keywords.includes("shootdown") && hasKw(def, "wall")) {
    // 撃墜：ダメージ計算の前に鉄壁持ちを破壊する。戦闘ダメージも反撃も発生しない。
    destroyUnit(state, def.uid);
    killed = !findUnit(state, def.uid);
  } else {
    // 攻撃側 → 守備側（反撃は dealUnitDamage 内で処理される）
    dealUnitDamage(state, def.uid, effAtk(atk), { sourceUid: atk.uid });
    // 守備側 → 攻撃側の戦闘ダメージ（倒れても与える）。ミラージュは自分の攻撃では受けない
    if (!(ad.passive && ad.passive.noDamageOnAttack)) {
      dealUnitDamage(state, atk.uid, effAtk(def), { sourceUid: def.uid });
    }
    cleanupDeaths(state);
    killed = !findUnit(state, def.uid);
  }
  // ロンギヌスの再攻撃：この攻撃で敵ユニットを破壊し、自分が生き残っていれば追加で1回だけ
  if (
    killed &&
    ad.passive &&
    ad.passive.reattackOnKill &&
    !atk.bonusAttackUsed &&
    findUnit(state, atk.uid)
  ) {
    atk.bonusAttackUsed = true;
    atk.attacksLeft += 1;
  }
  cleanupDeaths(state);
}

// 合体：手札の聖剣の欠片3枚を消費し、手札にEX-キャリバー（900）を加える。コスト無し。
function doFuse(state, p) {
  const pl = state.players[p];
  const idxs = [];
  pl.hand.forEach((id, i) => {
    if (id === 52) idxs.push(i);
  });
  if (idxs.length < 3) fail("合体には手札の聖剣の欠片が3枚必要です");
  const remove = new Set(idxs.slice(0, 3));
  pl.hand = pl.hand.filter((_, i) => !remove.has(i));
  pl.hand.push(900);
}

// 孵化：場の卵がその場で黒のアギト（901）に変身する。コスト無し。
// スタッツ（成長込みの現在値）と damage・enteredSeq を引き継ぎ、
// 孵化時の攻+体合計で 速攻（15+）／装甲（21+）／反撃（27+）を累積で得る。
function doHatch(state, p, uid) {
  const pl = state.players[p];
  const u = pl.field.find((x) => x.uid === uid);
  if (!u) fail("孵化させるユニットが自分の場にいません");
  if (!isEgg(u)) fail("そのユニットは孵化できません");
  const total = effAtk(u) + effMaxHp(u);
  u.cardId = 901;
  if (total >= 15) u.grantedHaste = true;
  if (total >= 21) u.grantedArmor = true;
  if (total >= 27) u.grantedCounter = true;
  // 攻撃可否は「場に出たターン」が基準。出たターンに孵化した場合は速攻がある時だけ攻撃できる。
  // 過去のターンに出ていた場合は beginTurn で回復済みの attacksLeft をそのまま使う。
  if (u.enteredSeq === state.turnSeq) {
    u.attacksLeft = u.grantedHaste ? maxAttacks(u) : 0;
  }
}

function doChooseTarget(state, p, uid) {
  const pend = state.pending;
  if (pend.type === "blancWall") {
    const u = state.players[p].field.find((x) => x.uid === uid);
    if (!u) fail("対象が不正です");
    u.grantedWall = true; // 場を離れるまで永続
    state.pending = null;
    return;
  }
  const targets = fxTargets(state, pend.player, pend.effect);
  if (!targets.includes(uid)) fail("その対象は選べません");
  state.pending = null;
  applyTargetEffect(state, pend.player, pend.effect, uid, pend.sourceUid);
  cleanupDeaths(state);
  if (state.winner != null) return;
  runFx(state, pend.queue);
  cleanupDeaths(state);
}

export function applyAction(state, playerIdx, action) {
  if (state.winner != null) fail("対戦は終了しています");
  if (!action || typeof action.type !== "string") fail("アクションが不正です");
  if (action.type === "surrender") {
    if (playerIdx !== 0 && playerIdx !== 1) fail("プレイヤー指定が不正です");
    state.winner = 1 - playerIdx;
    state.pending = null;
    state.log.push(`投了: loser=${playerIdx}`);
    return state;
  }
  if (state.pending) {
    if (playerIdx !== state.pending.player) fail("対象選択の解決待ちです");
    if (action.type !== "chooseTarget") fail("先に対象を選択してください");
    doChooseTarget(state, playerIdx, action.uid);
    checkWin(state, playerIdx);
    return state;
  }
  if (playerIdx !== state.turn) fail("相手のターンです");
  switch (action.type) {
    case "playCard":
      doPlayCard(state, playerIdx, action.handIndex);
      break;
    case "attack":
      doAttack(state, playerIdx, action.attackerUid, action.targetUid);
      break;
    case "fuse":
      doFuse(state, playerIdx);
      break;
    case "hatch":
      doHatch(state, playerIdx, action.uid);
      break;
    case "useCoin": {
      const pl = state.players[playerIdx];
      if (!pl.coin) fail("追い上げコインは使えません");
      pl.coin = false; // ゲーム中1回だけ
      pl.mana += 1; // そのターンだけ魔力+1（毎ターン回復で自然に消える）
      break;
    }
    case "endTurn":
      doEndTurn(state, playerIdx);
      return state;
    default:
      fail(`不明なアクション: ${action.type}`);
  }
  cleanupDeaths(state);
  checkWin(state, playerIdx);
  return state;
}

// ---------- 合法手の列挙 ----------

export function legalActions(state, playerIdx) {
  if (state.winner != null) return [];
  const acts = [];
  if (state.pending) {
    if (playerIdx !== state.pending.player) return [];
    if (state.pending.type === "blancWall") {
      for (const u of state.players[playerIdx].field) acts.push({ type: "chooseTarget", uid: u.uid });
    } else {
      for (const uid of fxTargets(state, playerIdx, state.pending.effect)) {
        acts.push({ type: "chooseTarget", uid });
      }
    }
    acts.push({ type: "surrender" });
    return acts;
  }
  if (playerIdx !== state.turn) return [];
  const pl = state.players[playerIdx];
  pl.hand.forEach((cardId, i) => {
    const card = CARD_MAP.get(cardId);
    if (card.cost > pl.mana) return;
    if (card.type === "unit") {
      if (pl.field.length >= FIELD_MAX) return;
      for (let q = 0; q < 2; q++) {
        for (const u of state.players[q].field) {
          const d = defOf(u);
          if (d.passive && d.passive.barrier && card.cost <= d.passive.barrier) return;
        }
      }
    } else {
      for (const eff of card.onPlay) {
        if (TARGETED_KINDS.has(eff.kind) && fxTargets(state, playerIdx, eff).length === 0) return;
      }
    }
    acts.push({ type: "playCard", handIndex: i });
  });
  // 合体：手札に欠片が3枚あれば宣言できる
  if (pl.hand.filter((id) => id === 52).length >= 3) acts.push({ type: "fuse" });
  // 孵化：自分の場の卵はすべて孵化できる
  for (const u of pl.field) {
    if (isEgg(u)) acts.push({ type: "hatch", uid: u.uid });
  }
  const legal = attackTargets(state, playerIdx);
  for (const u of pl.field) {
    if (u.attacksLeft <= 0) continue;
    if (isEgg(u)) continue; // 卵は攻撃できない（attacksLeft が回復していても列挙しない）
    for (const t of legal.units) acts.push({ type: "attack", attackerUid: u.uid, targetUid: t });
    // 突破：場に出たターンは召喚士への攻撃を合法手に出さない
    const rushEntry =
      u.enteredSeq === state.turnSeq && defOf(u).keywords.includes("rush");
    if (legal.leader && !rushEntry) {
      acts.push({ type: "attack", attackerUid: u.uid, targetUid: "leader" });
    }
  }
  if (pl.coin) acts.push({ type: "useCoin" });
  acts.push({ type: "endTurn" });
  acts.push({ type: "surrender" });
  return acts;
}
