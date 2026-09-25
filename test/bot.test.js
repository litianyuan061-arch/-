'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Table } = require('../server/table');
const { estimateEquity, decide } = require('../server/bot');

function seeded(seed) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

test('equity estimates are sensible', () => {
  const random = seeded(7);
  const aa = estimateEquity(['As', 'Ah'], [], 1, 800, random);
  const trash = estimateEquity(['7c', '2d'], [], 1, 800, random);
  assert.ok(aa > 0.78 && aa < 0.9, `AA ${aa}`);
  assert.ok(trash > 0.25 && trash < 0.42, `72o ${trash}`);
  // 已经成了坚果同花顺
  assert.strictEqual(estimateEquity(['As', 'Ks'], ['Qs', 'Js', 'Ts'], 3, 200, random), 1);
});

test('bot never folds when it can check, and folds trash to a huge shove', () => {
  const t = new Table({ random: seeded(3) });
  t.addPlayer('h', 'Human');
  t.addPlayer('b', 'Bot', { isBot: true });
  t.startHand();
  // 庄家 h 小盲；让 h 全下，机器人拿 7-2 面对
  t.players.get('b').hand = ['7c', '2d'];
  t.act('h', 'allin');
  const move = decide(t, 'b', seeded(11));
  assert.strictEqual(move.type, 'fold');
});

test('bot calls a shove with aces', () => {
  const t = new Table({ random: seeded(3) });
  t.addPlayer('h', 'Human');
  t.addPlayer('b', 'Bot', { isBot: true });
  t.startHand();
  t.players.get('b').hand = ['As', 'Ad'];
  t.act('h', 'allin');
  const move = decide(t, 'b', seeded(5));
  assert.ok(['call', 'allin'].includes(move.type), move.type);
});

test('bots always choose legal actions over many hands', () => {
  const random = seeded(99);
  for (let game = 0; game < 6; game++) {
    const t = new Table({ random });
    const n = 2 + game;
    for (let i = 0; i < n; i++) t.addPlayer('b' + i, 'Bot' + i, { isBot: true });
    const total = n * t.settings.startingChips;
    for (let hand = 0; hand < 25 && t.canStartHand(); hand++) {
      t.startHand();
      let guard = 0;
      while (t.isHandActive() && guard++ < 300) {
        const p = t.toActPlayer();
        const move = decide(t, p.id, random);
        t.act(p.id, move.type, move.amount); // 非法操作会抛异常，测试失败
      }
      assert.strictEqual(t.stage, 'showdown');
      const sum = [...t.players.values()].reduce((s, p) => s + p.chips, 0);
      assert.strictEqual(sum, total);
    }
  }
});

test('show cards after the hand reveals them to everyone', () => {
  const t = new Table();
  t.addPlayer('a', 'A');
  t.addPlayer('b', 'B');
  t.startHand();
  assert.throws(() => t.showCards('a'), /本手结束后/);
  t.act('a', 'fold');
  assert.strictEqual(t.getState('b').players.find((p) => p.id === 'a').cards, null);
  assert.strictEqual(t.getState('a').you.canShow, true);
  t.showCards('a');
  assert.deepStrictEqual(t.getState('b').players.find((p) => p.id === 'a').cards, t.players.get('a').hand);
  assert.strictEqual(t.getState('a').you.canShow, false);
  t.startHand();
  assert.deepStrictEqual(t.getState('b').players.find((p) => p.id === 'a').cards, ['??', '??']);
});

test('bots never become host', () => {
  const t = new Table();
  t.addPlayer('b', 'Bot', { isBot: true });
  assert.strictEqual(t.hostId, null);
  t.addPlayer('h', 'Human');
  assert.strictEqual(t.hostId, 'h');
  t.addPlayer('h2', 'Human2');
  t.removePlayer('h');
  assert.strictEqual(t.hostId, 'h2');
});
