'use strict';

// 牌用两个字符表示：点数 + 花色，例如 "As"（黑桃A）、"Td"（方块10）
const RANKS = '23456789TJQKA';
const SUITS = 'shdc'; // spades 黑桃, hearts 红心, diamonds 方块, clubs 梅花

const HAND_NAMES = [
  '高牌',
  '一对',
  '两对',
  '三条',
  '顺子',
  '同花',
  '葫芦',
  '四条',
  '同花顺',
];

function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2;
}

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

function shuffle(deck, random = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// 评估恰好 5 张牌，返回 [牌型, 比较用的点数...]，数组越大越强
function evaluate5(cards) {
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);

  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  // 按张数、再按点数排序
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let straightHigh = 0;
  if (counts.size === 5) {
    if (values[0] - values[4] === 4) straightHigh = values[0];
    else if (values[0] === 14 && values[1] === 5) straightHigh = 5; // A-2-3-4-5
  }

  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...values];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    return [2, groups[0][0], groups[1][0], groups[2][0]];
  }
  if (groups[0][1] === 2) return [1, groups[0][0], groups[1][0], groups[2][0], groups[3][0]];
  return [0, ...values];
}

function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// 从 5~7 张牌中找出最好的 5 张
function evaluateBest(cards) {
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const hand = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = evaluate5(hand);
            if (!best || compareScores(score, best.score) > 0) best = { score, cards: hand };
          }
  best.name = handName(best.score);
  return best;
}

function handName(score) {
  if (score[0] === 8 && score[1] === 14) return '皇家同花顺';
  return HAND_NAMES[score[0]];
}

module.exports = {
  RANKS,
  SUITS,
  createDeck,
  shuffle,
  evaluate5,
  evaluateBest,
  compareScores,
  handName,
};
