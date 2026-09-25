'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateBest, compareScores, createDeck, describeHand } = require('../server/cards');

const best = (s) => evaluateBest(s.split(' '));
const cmp = (a, b) => Math.sign(compareScores(best(a).score, best(b).score));

test('deck has 52 unique cards', () => {
  assert.strictEqual(new Set(createDeck()).size, 52);
});

test('recognizes every hand category', () => {
  assert.strictEqual(best('As Ks Qs Js Ts 2d 3c').name, '皇家同花顺');
  assert.strictEqual(best('9h 8h 7h 6h 5h Ad Ac').name, '同花顺');
  assert.strictEqual(best('7c 7d 7h 7s Kd 2c 3c').name, '四条');
  assert.strictEqual(best('Kc Kd Kh 2s 2d 9c 3c').name, '葫芦');
  assert.strictEqual(best('Ah 9h 7h 4h 2h Kd Kc').name, '同花');
  assert.strictEqual(best('9c 8d 7h 6s 5d 2c 2h').name, '顺子');
  assert.strictEqual(best('Qc Qd Qh 9s 5d 2c 3h').name, '三条');
  assert.strictEqual(best('Jc Jd 4h 4s Ad 2c 3h').name, '两对');
  assert.strictEqual(best('Tc Td 8h 6s Ad 2c 3h').name, '一对');
  assert.strictEqual(best('Ac Qd 9h 7s 5d 3c 2h').name, '高牌');
});

test('wheel straight A-2-3-4-5 ranks below 6-high straight', () => {
  assert.strictEqual(best('Ac 2d 3h 4s 5d Kc Kh').name, '顺子');
  assert.strictEqual(cmp('Ac 2d 3h 4s 5d Kc Qh', '2c 3d 4h 5s 6d Kc Qh'), -1);
});

test('kickers decide ties', () => {
  assert.strictEqual(cmp('As Ad Kc 9h 7s 3d 2c', 'Ah Ac Qc 9h 7s 3d 2c'), 1);
  assert.strictEqual(cmp('Ks Kd 5c 5h 9s 3d 2c', 'Kh Kc 5s 5d 8s 3d 2c'), 1);
  // 公共牌就是最好的牌时平分
  assert.strictEqual(cmp('2c 3d As Ks Qs Js Ts', '4c 5d As Ks Qs Js Ts'), 0);
});

test('picks the best five of seven', () => {
  // 两对 + 三条的组合其实是葫芦
  assert.strictEqual(best('Ac Ad Ah Kc Kd Qc Qd').name, '葫芦');
  // 同花中取最大的五张
  const r = best('Ah Kh 2h 3h 4h 9h Tc');
  assert.strictEqual(r.name, '同花');
  assert.deepStrictEqual(r.score, [5, 14, 13, 9, 4, 3]);
});

test('describeHand gives a readable hint and detects when the board plays', () => {
  const h = (hole, board) => describeHand(hole.split(' '), board ? board.split(' ') : []);
  assert.deepStrictEqual(
    [h('Qc Qd').text, h('As 7d').text],
    ['一对 Q', '高牌 A']
  );
  const board = h('4h 3c', '6h Ts Tc 9c 6c');
  assert.strictEqual(board.text, '两对 10 和 6');
  assert.strictEqual(board.boardPlays, true);
  const mine = h('Th 2c', '6h Ts Tc 9c 6c');
  assert.strictEqual(mine.text, '葫芦（10 带 6）');
  assert.strictEqual(mine.boardPlays, false);
  assert.strictEqual(h('Ah Kh', 'Qh Jh Th 2c 3d').text, '皇家同花顺');
  assert.strictEqual(h('5c 4d', 'Ah 2s 3c 9d Kc').text, '顺子（5 高）');
});
