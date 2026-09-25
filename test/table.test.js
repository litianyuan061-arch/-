'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Table, buildPots } = require('../server/table');

// 让 table 使用指定的牌堆：deck.pop() 从数组末尾取牌，所以把期望的发牌顺序反过来
function rig(table, order) {
  const orig = table.startHand.bind(table);
  table.startHand = () => {
    orig();
    // 重新发牌：先收回，再按 order 发
    const inHand = [...table.players.values()].filter((p) => p.inHand);
    let seat = table.dealerSeat;
    const dealOrder = [];
    for (let i = 0; i < inHand.length; i++) {
      seat = table._nextSeat(seat, (p) => p.inHand);
      dealOrder.push(table._atSeat(seat));
    }
    const cards = [...order];
    for (const p of dealOrder) p.hand = [];
    for (let r = 0; r < 2; r++) for (const p of dealOrder) p.hand.push(cards.shift());
    table.deck = cards.reverse();
  };
}

function setup(n, opts = {}) {
  const t = new Table({ smallBlind: 10, bigBlind: 20, startingChips: 1000, ...opts });
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push('p' + i);
    t.addPlayer('p' + i, 'P' + i);
  }
  return { t, ids };
}

const toAct = (t) => t.toActPlayer().id;
const chips = (t, id) => t.players.get(id).chips;

test('blinds and first to act with 3 players', () => {
  const { t } = setup(3);
  t.startHand();
  // 庄家 p0，小盲 p1，大盲 p2，翻牌前 p0 先行动
  assert.strictEqual(t.dealerSeat, 0);
  assert.strictEqual(t.players.get('p1').bet, 10);
  assert.strictEqual(t.players.get('p2').bet, 20);
  assert.strictEqual(toAct(t), 'p0');
  for (const p of t.players.values()) assert.strictEqual(p.hand.length, 2);
});

test('heads-up: dealer posts small blind and acts first preflop, last postflop', () => {
  const { t } = setup(2);
  t.startHand();
  assert.strictEqual(t.dealerSeat, 0);
  assert.strictEqual(t.players.get('p0').bet, 10);
  assert.strictEqual(toAct(t), 'p0');
  t.act('p0', 'call');
  assert.strictEqual(toAct(t), 'p1'); // 大盲有权选择
  t.act('p1', 'check');
  assert.strictEqual(t.stage, 'flop');
  assert.strictEqual(t.board.length, 3);
  assert.strictEqual(toAct(t), 'p1');
});

test('everyone folds to big blind', () => {
  const { t } = setup(3);
  t.startHand();
  t.act('p0', 'fold');
  t.act('p1', 'fold');
  assert.strictEqual(t.stage, 'showdown');
  assert.strictEqual(chips(t, 'p2'), 1010);
  assert.strictEqual(chips(t, 'p1'), 990);
  assert.ok(t.lastResult.uncontested);
  assert.deepStrictEqual(t.lastResult.shown, []);
});

test('min raise enforcement and re-opening action', () => {
  const { t } = setup(3);
  t.startHand();
  assert.throws(() => t.act('p0', 'raise', 30), /最少/);
  t.act('p0', 'raise', 60); // 加 40
  assert.throws(() => t.act('p1', 'raise', 90), /最少/); // 至少到 100
  t.act('p1', 'raise', 100);
  t.act('p2', 'call');
  assert.strictEqual(toAct(t), 'p0'); // p0 要再次行动
  assert.throws(() => t.act('p0', 'check'), /跟注/);
  t.act('p0', 'call');
  assert.strictEqual(t.stage, 'flop');
});

test('full hand to showdown awards pot to best hand', () => {
  const { t } = setup(2);
  // p1 先拿牌（庄家左手边），然后 p0；公共牌: 烧 + 3 + 烧 + 1 + 烧 + 1
  rig(t, ['Ah', '2c', 'Ad', '7s', 'x', 'Ac', 'Kd', '9h', 'x', '3s', 'x', '4d']);
  t.startHand();
  assert.deepStrictEqual(t.players.get('p1').hand, ['Ah', 'Ad']);
  t.act('p0', 'call');
  t.act('p1', 'check');
  for (let i = 0; i < 3; i++) {
    t.act(toAct(t), 'check');
    t.act(toAct(t), 'check');
  }
  assert.strictEqual(t.stage, 'showdown');
  assert.strictEqual(chips(t, 'p1'), 1020);
  assert.strictEqual(chips(t, 'p0'), 980);
  assert.strictEqual(t.lastResult.pots[0].handName, '三条');
  assert.deepStrictEqual(t.lastResult.shown.sort(), ['p0', 'p1']);
});

test('all-in runs out the board automatically', () => {
  const { t } = setup(2);
  t.startHand();
  t.act('p0', 'allin');
  t.act('p1', 'call');
  assert.strictEqual(t.stage, 'showdown');
  assert.strictEqual(t.board.length, 5);
  assert.strictEqual(chips(t, 'p0') + chips(t, 'p1'), 2000);
});

test('side pots with short all-in', () => {
  const { t } = setup(3);
  t.players.get('p0').chips = 100; // 短码
  // 发牌顺序：p1, p2, p0 各一张，再一轮
  rig(t, ['Kc', 'Qc', 'Ac', 'Kd', 'Qd', 'Ad', 'x', '2s', '7h', '9d', 'x', '3c', 'x', '4h']);
  t.startHand();
  t.act('p0', 'allin'); // 100
  t.act('p1', 'raise', 300);
  t.act('p2', 'call');
  // 翻牌后 p1、p2 继续
  t.act('p1', 'raise', 200);
  t.act('p2', 'call');
  t.act('p1', 'check');
  t.act('p2', 'check');
  t.act('p1', 'check');
  t.act('p2', 'check');
  assert.strictEqual(t.stage, 'showdown');
  // p0 AA 赢主池 300；p1 KK 赢边池 800
  assert.strictEqual(chips(t, 'p0'), 300);
  assert.strictEqual(chips(t, 'p1'), 1000 - 500 + 800);
  assert.strictEqual(chips(t, 'p2'), 500);
  assert.strictEqual(t.lastResult.pots.length, 2);
});

test('uncalled bet is returned', () => {
  const { t } = setup(2);
  t.players.get('p1').chips = 50;
  t.startHand();
  t.act('p0', 'raise', 500);
  t.act('p1', 'call'); // p1 只有 50，全下
  assert.strictEqual(t.stage, 'showdown');
  assert.strictEqual(chips(t, 'p0') + chips(t, 'p1'), 1050);
  assert.ok(chips(t, 'p0') >= 950);
});

test('split pot divides evenly', () => {
  const { t } = setup(2);
  rig(t, ['2c', '3d', '2h', '3s', 'x', 'As', 'Ks', 'Qs', 'x', 'Js', 'x', 'Ts']);
  t.startHand();
  t.act('p0', 'call');
  t.act('p1', 'check');
  for (let i = 0; i < 3; i++) {
    t.act(toAct(t), 'check');
    t.act(toAct(t), 'check');
  }
  assert.strictEqual(chips(t, 'p0'), 1000);
  assert.strictEqual(chips(t, 'p1'), 1000);
  assert.strictEqual(t.lastResult.pots[0].winners.length, 2);
});

test('incomplete all-in raise does not reopen betting', () => {
  const { t } = setup(3);
  t.players.get('p2').chips = 130; // 大盲 20 + 110
  t.startHand();
  t.act('p0', 'raise', 100);
  t.act('p1', 'fold');
  t.act('p2', 'allin'); // 到 130，只多了 30，不足最小加注 80
  assert.strictEqual(toAct(t), 'p0');
  const state = t.getState('p0');
  assert.strictEqual(state.actions.canRaise, false);
  assert.throws(() => t.act('p0', 'raise', 400), /只能跟注或弃牌/);
  t.act('p0', 'call');
  assert.strictEqual(t.stage, 'showdown');
});

test('dealer button rotates and busted players are skipped', () => {
  const { t } = setup(3);
  t.startHand();
  t.act('p0', 'fold');
  t.act('p1', 'fold');
  t.startHand();
  assert.strictEqual(t.dealerSeat, 1);
  t.act(toAct(t), 'fold');
  t.act(toAct(t), 'fold');
  t.players.get('p2').chips = 0;
  t.startHand();
  assert.strictEqual(t.players.get('p2').inHand, false);
  assert.strictEqual(t.dealerSeat, 0);
});

test('player leaving mid-hand folds and is removed after the hand', () => {
  const { t } = setup(3);
  t.startHand();
  t.removePlayer('p2'); // 大盲，未轮到他
  assert.ok(t.players.has('p2'));
  t.act('p0', 'fold');
  assert.strictEqual(t.stage, 'showdown');
  assert.strictEqual(chips(t, 'p1'), 1020); // 拿到了 p2 的大盲
  t.startHand();
  assert.ok(!t.players.has('p2'));
});

test('host leaving passes host to another player', () => {
  const { t } = setup(2);
  t.removePlayer('p0');
  assert.strictEqual(t.hostId, 'p1');
});

test('rebuy only when busted', () => {
  const { t } = setup(2);
  assert.throws(() => t.rebuy('p0'), /还有筹码/);
  t.players.get('p0').chips = 0;
  t.rebuy('p0');
  assert.strictEqual(chips(t, 'p0'), 1000);
  assert.strictEqual(t.players.get('p0').buyIns, 2);
});

test('state hides other players hole cards until showdown', () => {
  const { t } = setup(2);
  t.startHand();
  const s = t.getState('p0');
  const me = s.players.find((p) => p.id === 'p0');
  const other = s.players.find((p) => p.id === 'p1');
  assert.strictEqual(me.cards.length, 2);
  assert.notStrictEqual(me.cards[0], '??');
  assert.deepStrictEqual(other.cards, ['??', '??']);
  assert.ok(!JSON.stringify(s).includes(t.players.get('p1').hand[0] + '"]'));
});

test('buildPots merges levels with the same eligible players', () => {
  const pots = buildPots([
    { id: 'a', totalBet: 50, folded: false },
    { id: 'b', totalBet: 100, folded: true },
    { id: 'c', totalBet: 200, folded: false },
    { id: 'd', totalBet: 200, folded: false },
  ]);
  assert.deepStrictEqual(pots, [
    { amount: 200, eligible: ['a', 'c', 'd'] },
    { amount: 350, eligible: ['c', 'd'] },
  ]);
});

test('random play never creates or destroys chips', () => {
  let seed = 42;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let game = 0; game < 30; game++) {
    const { t } = setup(2 + (game % 7), { random });
    const expected = [...t.players.values()].reduce((s, p) => s + p.chips, 0);
    for (let hand = 0; hand < 40 && t.canStartHand(); hand++) {
      t.startHand();
      let guard = 0;
      while (t.isHandActive() && guard++ < 500) {
        const p = t.toActPlayer();
        const st = t.getState(p.id).actions;
        const r = random();
        if (r < 0.15) t.act(p.id, 'fold');
        else if (r < 0.3 && st.canRaise) t.act(p.id, 'raise', st.minRaiseTo + Math.floor(random() * 200));
        else if (r < 0.35) t.act(p.id, 'allin');
        else t.act(p.id, st.canCheck ? 'check' : 'call');
      }
      assert.strictEqual(t.stage, 'showdown');
      const sum = [...t.players.values()].reduce((s, p) => s + p.chips, 0);
      assert.strictEqual(sum, expected, `chips leaked in game ${game} hand ${hand}`);
    }
  }
});
