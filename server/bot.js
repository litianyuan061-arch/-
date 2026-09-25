'use strict';

const { createDeck, evaluateBest, compareScores } = require('./cards');

const BOT_NAMES = ['小智', '阿狸', '老K', '豆豆', '牌神', '大熊', '喵喵', '阿飞', '小鱼', '石头'];

/**
 * 蒙特卡洛估算胜率：随机补齐对手底牌和剩余公共牌，统计能赢（平分按比例）的比例。
 */
function estimateEquity(hole, board, opponents, iterations = 300, random = Math.random) {
  if (opponents <= 0) return 1;
  const known = new Set([...hole, ...board]);
  const rest = createDeck().filter((c) => !known.has(c));
  const need = opponents * 2 + (5 - board.length);
  let won = 0;

  for (let it = 0; it < iterations; it++) {
    // 只洗前 need 张
    for (let j = 0; j < need; j++) {
      const k = j + Math.floor(random() * (rest.length - j));
      [rest[j], rest[k]] = [rest[k], rest[j]];
    }
    const fullBoard = [...board, ...rest.slice(opponents * 2, need)];
    const mine = evaluateBest([...hole, ...fullBoard]).score;
    let ties = 1;
    let lost = false;
    for (let o = 0; o < opponents; o++) {
      const theirs = evaluateBest([rest[o * 2], rest[o * 2 + 1], ...fullBoard]).score;
      const cmp = compareScores(theirs, mine);
      if (cmp > 0) {
        lost = true;
        break;
      }
      if (cmp === 0) ties++;
    }
    if (!lost) won += 1 / ties;
  }
  return won / iterations;
}

/**
 * 机器人决策。返回 { type, amount }，保证是当前合法的操作。
 */
function decide(table, botId, random = Math.random) {
  const state = table.getState(botId);
  const a = state.actions;
  if (!a) return null;
  const me = table.players.get(botId);
  const opponents = state.players.filter((p) => p.inHand && !p.folded && p.id !== botId).length;
  // 对手多时减少模拟次数，保证响应速度
  const iterations = opponents > 4 ? 150 : 250;
  const equity = estimateEquity(me.hand, table.board, opponents, iterations, random);

  const pot = state.pot;
  const toCall = a.callAmount;
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const avg = 1 / (opponents + 1);
  const strong = equity > avg + (1 - avg) * 0.45;
  const good = equity > avg + (1 - avg) * 0.2;
  const r = random();

  const check = () => (a.canCheck ? { type: 'check' } : { type: 'fold' });
  const call = () => (a.canCheck ? { type: 'check' } : { type: 'call' });
  const raise = (fraction) => {
    if (!a.canRaise) return call();
    let target = Math.round(table.currentBet + (pot + toCall) * fraction);
    target = Math.max(a.minRaiseTo, Math.min(a.maxRaiseTo, target));
    // 剩下的筹码不多了就直接全下
    if (target >= a.maxRaiseTo * 0.8) return { type: 'allin' };
    return { type: 'raise', amount: target };
  };
  const raiseWar = table.raisesThisStreet >= 3;

  if (strong) {
    if (r < 0.2) return call(); // 偶尔慢打
    if (raiseWar && r < 0.6) return call();
    return raise(0.6 + random() * 0.5);
  }
  if (good) {
    if (a.canCheck) return r < 0.55 ? raise(0.4 + random() * 0.3) : check();
    if (equity >= potOdds) {
      if (!raiseWar && r < 0.12 && toCall <= pot / 2) return raise(0.6);
      return call();
    }
    return check();
  }
  // 牌弱：偶尔诈唬，有合适赔率时跟注抽牌，否则过牌/弃牌
  if (a.canCheck) return r < 0.1 && !raiseWar ? raise(0.5) : check();
  if (equity >= potOdds + 0.05) return call();
  return { type: 'fold' };
}

function pickBotName(table) {
  const used = new Set([...table.players.values()].map((p) => p.name));
  const free = BOT_NAMES.filter((n) => !used.has('🤖' + n));
  const base = free.length ? free[Math.floor(Math.random() * free.length)] : '机器人' + (used.size + 1);
  return '🤖' + base;
}

module.exports = { estimateEquity, decide, pickBotName, BOT_NAMES };
