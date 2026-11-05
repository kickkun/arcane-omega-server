// アーケインサモンΩ 新神話3種（052〜054＋形態900/901）の自己テスト
// 実行: node new-mythics.test.js （全PASSで終了コード0）
// 既存スイート（engine.test.js 等）とは独立に、新メカニクスだけを検証する。
import assert from "node:assert";
import {
  createGame,
  applyAction,
  legalActions,
  spawnUnit,
  defOf,
  effAtk,
  effMaxHp,
  effHp,
  findUnit,
  hasKw,
} from "./engine.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  NG - ${name}: ${e.message}`);
  }
}

const FILLER = [
  19, 19, 19, 8, 8, 8, 3, 3, 3, 27, 27, 27, 20, 20, 20, 21, 21, 21, 17, 17,
];

function game(opts = {}) {
  return createGame({
    deckA: opts.deckA || FILLER,
    deckB: opts.deckB || FILLER,
    summonerA: opts.summonerA || "mia",
    summonerB: opts.summonerB || "mia",
    first: opts.first ?? 0,
  });
}

function place(g, p, cardId, opts = {}) {
  const u = spawnUnit(g, cardId, p);
  Object.assign(u, opts);
  g.players[p].field.push(u);
  return u;
}

function rich(g) {
  for (const pl of g.players) {
    pl.mana = 10;
    pl.manaMax = 10;
  }
  return g;
}

console.log("[デッキ検証：形態と新神話]");
test("形態900/901はデッキに入れられない", () => {
  const d1 = [...FILLER];
  d1[0] = 900;
  assert.throws(() => game({ deckA: d1 }), /形態カードはデッキに入れられません/);
  const d2 = [...FILLER];
  d2[0] = 901;
  assert.throws(() => game({ deckA: d2 }), /形態カードはデッキに入れられません/);
});
test("新神話は1種まで（52×3はOK、52と53の混在は例外）", () => {
  const ok = [...FILLER];
  ok[0] = ok[1] = ok[2] = 52;
  assert.doesNotThrow(() => game({ deckA: ok }));
  const ok54 = [...FILLER];
  ok54[0] = ok54[1] = ok54[2] = 54;
  assert.doesNotThrow(() => game({ deckA: ok54 }));
  const ng = [...FILLER];
  ng[0] = 52;
  ng[3] = 53;
  assert.throws(() => game({ deckA: ng }), /神話は1種類のみ/);
});

console.log("[合体とEX-キャリバー]");
test("手札の欠片3枚で合体でき、EXが手札に生まれる。2枚では不可", () => {
  const g = rich(game());
  g.players[0].hand = [52, 52];
  assert.strictEqual(legalActions(g, 0).some((a) => a.type === "fuse"), false);
  assert.throws(() => applyAction(g, 0, { type: "fuse" }), /3枚必要/);
  g.players[0].hand = [52, 52, 52, 19];
  assert.strictEqual(legalActions(g, 0).some((a) => a.type === "fuse"), true);
  applyAction(g, 0, { type: "fuse" });
  assert.deepStrictEqual(g.players[0].hand, [19, 900]);
});
test("EX登場時：両場と両手札を破壊し、破壊数ぶん+1/+1。卵は残り数えない", () => {
  const g = rich(game());
  const ally = place(g, 0, 19); // 自場ユニット（破壊される）
  const foe = place(g, 1, 19); // 敵場ユニット（破壊される）
  const egg = place(g, 1, 53); // 敵場の卵（破壊されず、数えない）
  g.players[0].hand = [900];
  g.players[1].hand = [19, 8]; // 敵手札2枚（破壊される）
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  const ex = g.players[0].field.find((u) => u.cardId === 900);
  assert.ok(ex, "EXが場にいる");
  assert.strictEqual(findUnit(g, ally.uid), null, "自場ユニットは破壊された");
  assert.strictEqual(findUnit(g, foe.uid), null, "敵場ユニットは破壊された");
  assert.ok(findUnit(g, egg.uid), "卵は場に残る");
  assert.strictEqual(g.players[0].hand.length, 0, "自手札は空（EXは既に出ている）");
  assert.strictEqual(g.players[1].hand.length, 0, "敵手札は全て破壊された");
  // 破壊数 = 場2 + 手札2 = 4 → 1/1 + 4 = 5/5
  assert.strictEqual(effAtk(ex), 5);
  assert.strictEqual(effMaxHp(ex), 5);
});

console.log("[黒竜の卵と黒のアギト]");
test("卵は攻撃できず、攻撃・単体効果・全体効果ダメージの対象にならない", () => {
  const g = rich(game());
  g.players[0].hand = [53];
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  const egg = g.players[0].field[0];
  assert.strictEqual(
    legalActions(g, 0).some((a) => a.type === "attack" && a.attackerUid === egg.uid),
    false,
    "卵の攻撃は合法手に出ない",
  );
  assert.throws(
    () => applyAction(g, 0, { type: "attack", attackerUid: egg.uid, targetUid: "leader" }),
    /攻撃できません/,
  );
  // 敵ターン：卵は攻撃対象に選べず、顔は素通りできる
  applyAction(g, 0, { type: "endTurn" });
  const misha = place(g, 1, 2, { enteredSeq: g.turnSeq - 1, attacksLeft: 1 });
  assert.throws(
    () => applyAction(g, 1, { type: "attack", attackerUid: misha.uid, targetUid: egg.uid }),
    /その対象は攻撃できません/,
  );
  applyAction(g, 1, { type: "attack", attackerUid: misha.uid, targetUid: "leader" });
  assert.strictEqual(g.players[0].life, 17, "卵を素通りして召喚士を攻撃できる");
  // 単体効果（ルミナの2ダメージ）の対象候補に卵が入らない
  g.players[1].hand = [1];
  applyAction(g, 1, { type: "playCard", handIndex: 0 });
  assert.strictEqual(g.pending, null, "対象がいないので登場時効果は不発（pendingなし）");
  // 全体効果ダメージ（どかんと大爆発）を受けない
  g.players[1].hand = [16];
  applyAction(g, 1, { type: "playCard", handIndex: 0 });
  assert.strictEqual(effHp(egg), 7, "卵は全体ダメージを受けない");
});
test("卵はターン開始時に攻撃+3/体力+1成長し、孵化でアギトになりスタッツを引き継ぐ", () => {
  const g = rich(game());
  g.players[0].hand = [53];
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  const egg = g.players[0].field[0];
  assert.strictEqual(effAtk(egg), 0);
  assert.strictEqual(effMaxHp(egg), 7);
  applyAction(g, 0, { type: "endTurn" });
  applyAction(g, 1, { type: "endTurn" }); // 自ターン開始 → 成長
  assert.strictEqual(effAtk(egg), 3);
  assert.strictEqual(effMaxHp(egg), 8);
  // 合計11 < 15：能力なしで孵化。前ターンに出ているので攻撃はできる
  assert.strictEqual(legalActions(g, 0).some((a) => a.type === "hatch" && a.uid === egg.uid), true);
  applyAction(g, 0, { type: "hatch", uid: egg.uid });
  assert.strictEqual(egg.cardId, 901);
  assert.strictEqual(defOf(egg).name, "黒のアギト");
  assert.strictEqual(hasKw(egg, "haste"), false);
  assert.strictEqual(hasKw(egg, "pierce"), true, "アギトは貫通を常時持つ");
  applyAction(g, 0, { type: "attack", attackerUid: egg.uid, targetUid: "leader" });
  assert.strictEqual(g.players[1].life, 17, "アギトの攻撃3点が入る");
});
test("孵化時の合計27以上で速攻・装甲・反撃をすべて得る。出たターンの孵化でも速攻で攻撃できる", () => {
  const g = rich(game());
  g.players[0].hand = [53];
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  const egg = g.players[0].field[0];
  egg.atkMod += 10;
  egg.hpMod += 10; // 10/17、合計27をシナリオ構築で再現
  applyAction(g, 0, { type: "hatch", uid: egg.uid });
  assert.strictEqual(hasKw(egg, "haste"), true);
  assert.strictEqual(hasKw(egg, "armor"), true);
  assert.strictEqual(hasKw(egg, "counter"), true);
  applyAction(g, 0, { type: "attack", attackerUid: egg.uid, targetUid: "leader" });
  assert.strictEqual(g.players[1].life, 10, "速攻で出たターンに10点");
});
test("合計15未満で出たターンに孵化すると、そのターンは攻撃できない", () => {
  const g = rich(game());
  g.players[0].hand = [53];
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  const egg = g.players[0].field[0];
  applyAction(g, 0, { type: "hatch", uid: egg.uid }); // 0/7、合計7
  assert.throws(
    () => applyAction(g, 0, { type: "attack", attackerUid: egg.uid, targetUid: "leader" }),
    /もう攻撃できません/,
  );
});
test("バウンスされたアギトは手札で卵（53）に戻る／卵はバウンスと奪取を受ける", () => {
  const g = rich(game());
  const egg = place(g, 1, 53);
  egg.cardId = 901; // アギト状態を再現
  assert.strictEqual(
    legalActions(g, 0).some((a) => a.type === "playCard"),
    true,
  );
  g.players[0].hand = [15]; // 浄化の大波（バウンス＋1ドロー）
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  applyAction(g, 0, { type: "chooseTarget", uid: egg.uid });
  assert.strictEqual(findUnit(g, egg.uid), null, "アギトは場を離れる");
  assert.ok(g.players[1].hand.includes(53), "持ち主の手札に卵として戻る");
  assert.strictEqual(g.players[1].hand.includes(901), false);
});

console.log("[絶槍ロンギヌス：突破・撃墜・再攻撃]");
test("突破：出たターンはユニットにだけ攻撃でき、召喚士は攻撃できない", () => {
  const g = rich(game());
  const foe = place(g, 1, 19); // 3/3
  g.players[0].hand = [54];
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  const lon = g.players[0].field[0];
  assert.strictEqual(
    legalActions(g, 0).some(
      (a) => a.type === "attack" && a.attackerUid === lon.uid && a.targetUid === "leader",
    ),
    false,
    "出たターンの顔攻撃は合法手に出ない",
  );
  assert.throws(
    () => applyAction(g, 0, { type: "attack", attackerUid: lon.uid, targetUid: "leader" }),
    /突破/,
  );
  applyAction(g, 0, { type: "attack", attackerUid: lon.uid, targetUid: foe.uid });
  assert.strictEqual(findUnit(g, foe.uid), null, "3/3を戦闘で倒す");
  assert.strictEqual(effHp(lon), 1, "反撃側の戦闘ダメージ3を受けた");
});
test("撃墜：鉄壁持ちをダメージ計算前に破壊し、反撃も受けない。倒したので追加攻撃が1回できる", () => {
  const g = rich(game());
  const epine = place(g, 1, 41); // エピーヌ（鉄壁・反撃、1/4）
  const foe = place(g, 1, 19);
  g.players[0].hand = [54];
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  const lon = g.players[0].field[0];
  applyAction(g, 0, { type: "attack", attackerUid: lon.uid, targetUid: epine.uid });
  assert.strictEqual(findUnit(g, epine.uid), null, "撃墜で破壊された");
  assert.strictEqual(effHp(lon), 4, "戦闘ダメージも反撃も受けていない");
  assert.strictEqual(lon.attacksLeft, 1, "追加攻撃が1回付いた");
  // 出たターンなので追加攻撃もユニットのみ
  assert.throws(
    () => applyAction(g, 0, { type: "attack", attackerUid: lon.uid, targetUid: "leader" }),
    /突破/,
  );
  applyAction(g, 0, { type: "attack", attackerUid: lon.uid, targetUid: foe.uid });
  assert.strictEqual(findUnit(g, foe.uid), null);
  assert.throws(
    () => applyAction(g, 0, { type: "attack", attackerUid: lon.uid, targetUid: "leader" }),
    /もう攻撃できません|突破/,
    "追加攻撃は1回まで（連鎖しない）",
  );
});
test("翌ターン以降は召喚士も攻撃でき、撃破後の追加攻撃で顔を殴れる", () => {
  const g = rich(game());
  const foe = place(g, 1, 19);
  const lon = place(g, 0, 54, { enteredSeq: g.turnSeq - 1, attacksLeft: 1 });
  applyAction(g, 0, { type: "attack", attackerUid: lon.uid, targetUid: foe.uid });
  assert.strictEqual(findUnit(g, foe.uid), null);
  assert.strictEqual(lon.attacksLeft, 1, "追加攻撃が付いた");
  applyAction(g, 0, { type: "attack", attackerUid: lon.uid, targetUid: "leader" });
  assert.strictEqual(g.players[1].life, 16, "追加攻撃で召喚士へ4点");
});
test("撃墜は攻撃された側では発動しない（鉄壁持ちとして殴られると通常戦闘）", () => {
  const g = rich(game({ first: 1 }));
  const lon = place(g, 0, 54); // 相手場のロンギヌス
  const epine = place(g, 1, 41, { enteredSeq: g.turnSeq - 1, attacksLeft: 1 }); // 自分のエピーヌ（鉄壁）
  applyAction(g, 1, { type: "attack", attackerUid: epine.uid, targetUid: lon.uid });
  // 撃墜が守備側で発動していれば、エピーヌはダメージを受ける前に破壊され、
  // ロンギヌスは無傷のはず。実際は通常戦闘として解決される：
  // ロンギヌスは戦闘ダメージ1＋エピーヌの反撃1を受け、エピーヌは戦闘ダメージ4で倒れる。
  assert.ok(findUnit(g, lon.uid), "ロンギヌスは撃墜で守られない");
  assert.strictEqual(effHp(lon), 2, "戦闘ダメージ1と反撃1を受けた");
  assert.strictEqual(findUnit(g, epine.uid), null, "エピーヌは通常戦闘のダメージで倒れた");
});
test("倒せなかった攻撃では追加攻撃は付かない", () => {
  const g = rich(game());
  const filia = place(g, 1, 3); // フィリア（2/5、非鉄壁）
  g.players[0].hand = [54];
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  const lon = g.players[0].field[0];
  applyAction(g, 0, { type: "attack", attackerUid: lon.uid, targetUid: filia.uid });
  assert.ok(findUnit(g, filia.uid), "倒せていない（残り体力1）");
  assert.strictEqual(effHp(lon), 2, "相手の戦闘ダメージ2を受けた");
  assert.strictEqual(lon.attacksLeft, 0, "追加攻撃は付かない");
});
test("卵はダーククイーンに奪取でき、奪った側のターン開始時に成長する", () => {
  const g = rich(game());
  const egg = place(g, 1, 53);
  g.players[0].hand = [48];
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  assert.strictEqual(g.pending?.effect?.kind, "stealUnit");
  const targets = legalActions(g, 0)
    .filter((a) => a.type === "chooseTarget")
    .map((a) => a.uid);
  assert.ok(targets.includes(egg.uid), "卵も奪取の対象に選べる");
  applyAction(g, 0, { type: "chooseTarget", uid: egg.uid });
  assert.ok(g.players[0].field.some((u) => u.uid === egg.uid), "卵が自分の場へ移った");
  applyAction(g, 0, { type: "endTurn" });
  applyAction(g, 1, { type: "endTurn" }); // 自ターン開始 → 成長は現在のコントローラー側で進む
  assert.strictEqual(effAtk(egg), 3);
  assert.strictEqual(effMaxHp(egg), 8);
});

console.log("[黒のアギト：貫通]");
test("貫通：小さいユニットを攻撃すると、体力を超えた分が敵召喚士に入る", () => {
  const g = rich(game());
  // アギト 6/9（基礎0/7に補正で再現）を前ターンから場に置く
  const agito = place(g, 0, 901, { atkMod: 6, hpMod: 2, enteredSeq: g.turnSeq - 1, attacksLeft: 1 });
  const foe = place(g, 1, 19); // シャハラ 3/3
  applyAction(g, 0, { type: "attack", attackerUid: agito.uid, targetUid: foe.uid });
  assert.strictEqual(findUnit(g, foe.uid), null, "対象は倒れる");
  // 実ダメージ6 − 対象の体力3 = 超過3点が召喚士へ
  assert.strictEqual(g.players[1].life, 17, "超過分3点が召喚士に入る");
  assert.strictEqual(effHp(agito), 6, "守備側の戦闘ダメージ3は通常どおり受ける");
});
test("貫通：装甲持ちを攻撃した場合は、軽減後の実ダメージで超過を計算する", () => {
  const g = rich(game());
  const agito = place(g, 0, 901, { atkMod: 8, hpMod: 2, enteredSeq: g.turnSeq - 1, attacksLeft: 1 }); // 8/9
  const gracia = place(g, 1, 9); // グラシア 5/5・装甲
  applyAction(g, 0, { type: "attack", attackerUid: agito.uid, targetUid: gracia.uid });
  assert.strictEqual(findUnit(g, gracia.uid), null, "グラシアは倒れる");
  // 実ダメージは装甲で8→7。超過 = 7 − 体力5 = 2点（軽減前なら3点になる）
  assert.strictEqual(g.players[1].life, 18, "軽減後の実ダメージで超過2点が入る");
});
test("貫通：アギトが攻撃された側では発動しない（守備時の戦闘ダメージは超過しない）", () => {
  const g = rich(game({ first: 1 }));
  const agito = place(g, 0, 901, { atkMod: 9, hpMod: 2, enteredSeq: g.turnSeq - 1 }); // 9/9（守備側）
  const misha = place(g, 1, 2, { enteredSeq: g.turnSeq - 1, attacksLeft: 1 }); // ミーシャ 3/2
  applyAction(g, 1, { type: "attack", attackerUid: misha.uid, targetUid: agito.uid });
  assert.strictEqual(findUnit(g, misha.uid), null, "ミーシャはアギトの戦闘ダメージ9で倒れる");
  // 守備側のアギトのダメージ9がミーシャの体力2を超えても、貫通は発動しない
  assert.strictEqual(g.players[1].life, 20, "攻撃側（ミーシャ側）の召喚士に超過分は入らない");
  assert.strictEqual(effHp(agito), 6, "アギトはミーシャの戦闘ダメージ3を受ける");
});

console.log("[卵と鉄壁付与の裁定（2026-11-05）]");
test("卵に鉄壁を付与しても壁として数えず、召喚士への攻撃は素通りする", () => {
  const g = rich(game({ summonerA: "blanc" }));
  g.players[0].hand = [53];
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  const egg = g.players[0].field[0];
  applyAction(g, 0, { type: "endTurn" });
  applyAction(g, 1, { type: "endTurn" }); // Aのターン開始：成長＋ブランの付与待ち
  assert.strictEqual(g.pending?.type, "blancWall");
  applyAction(g, 0, { type: "chooseTarget", uid: egg.uid });
  assert.strictEqual(hasKw(egg, "wall"), true, "付与自体は成立する");
  applyAction(g, 0, { type: "endTurn" });
  const misha = place(g, 1, 2, { enteredSeq: g.turnSeq - 1, attacksLeft: 1 });
  assert.strictEqual(
    legalActions(g, 1).some((a) => a.type === "attack" && a.targetUid === "leader"),
    true,
    "卵の鉄壁は壁として数えないので顔への攻撃が合法手に出る",
  );
  applyAction(g, 1, { type: "attack", attackerUid: misha.uid, targetUid: "leader" });
  assert.strictEqual(g.players[0].life, 17, "卵を素通りして召喚士を攻撃できる");
  const misha2 = place(g, 1, 2, { enteredSeq: g.turnSeq - 1, attacksLeft: 1 });
  assert.throws(
    () => applyAction(g, 1, { type: "attack", attackerUid: misha2.uid, targetUid: egg.uid }),
    /その対象は攻撃できません/,
    "卵自体は相変わらず攻撃対象に選べない",
  );
});
test("卵に付与された鉄壁は、孵化してアギトになると通常どおり機能する", () => {
  const g = rich(game({ summonerA: "blanc" }));
  g.players[0].hand = [53];
  applyAction(g, 0, { type: "playCard", handIndex: 0 });
  const egg = g.players[0].field[0];
  applyAction(g, 0, { type: "endTurn" });
  applyAction(g, 1, { type: "endTurn" });
  assert.strictEqual(g.pending?.type, "blancWall");
  applyAction(g, 0, { type: "chooseTarget", uid: egg.uid });
  applyAction(g, 0, { type: "hatch", uid: egg.uid });
  assert.strictEqual(egg.cardId, 901);
  assert.strictEqual(hasKw(egg, "wall"), true, "付与された鉄壁は孵化後も残る");
  applyAction(g, 0, { type: "endTurn" });
  const misha = place(g, 1, 2, { enteredSeq: g.turnSeq - 1, attacksLeft: 1 });
  assert.throws(
    () => applyAction(g, 1, { type: "attack", attackerUid: misha.uid, targetUid: "leader" }),
    /鉄壁/,
    "アギトが壁として機能するので顔は殴れない",
  );
  applyAction(g, 1, { type: "attack", attackerUid: misha.uid, targetUid: egg.uid });
  assert.strictEqual(g.players[0].life, 20, "攻撃はアギトに向かい、召喚士は無傷");
});

console.log("");
if (failures.length > 0) {
  console.log(`結果: ${passed} PASS / ${failures.length} FAIL`);
  for (const f of failures) console.log(`  FAIL: ${f.name} -> ${f.error.message}`);
  process.exit(1);
}
console.log(`結果: 全 ${passed} 件 PASS`);
