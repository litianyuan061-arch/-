'use strict';

const { createDeck, shuffle, evaluateBest, compareScores, describeHand } = require('./cards');

const BETTING_STAGES = ['preflop', 'flop', 'turn', 'river'];
const NEXT_STAGE = { preflop: 'flop', flop: 'turn', turn: 'river' };

class GameError extends Error {}

/**
 * 一张德州扑克牌桌的完整规则引擎（不含网络、计时器）。
 * stage: waiting（未开始）→ preflop → flop → turn → river → showdown（本手结束，展示结果）
 */
class Table {
  constructor(options = {}) {
    this.settings = {
      smallBlind: options.smallBlind ?? 10,
      bigBlind: options.bigBlind ?? 20,
      startingChips: options.startingChips ?? 1000,
      maxSeats: options.maxSeats ?? 9,
    };
    this.random = options.random || Math.random;
    this.players = new Map(); // id -> player
    this.seats = new Array(this.settings.maxSeats).fill(null); // seat -> id
    this.hostId = null;
    this.stage = 'waiting';
    this.handNumber = 0;
    this.dealerSeat = -1;
    this.sbSeat = -1;
    this.bbSeat = -1;
    this.toActSeat = -1;
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = 0;
    this.lastResult = null;
    this.seq = 0; // 每次状态变化 +1，服务器用来判断计时器是否过期
    this.log = [];
  }

  // ---------- 玩家管理 ----------

  addPlayer(id, name) {
    if (this.players.has(id)) throw new GameError('玩家已在桌上');
    const seat = this.seats.indexOf(null);
    if (seat === -1) throw new GameError('座位已满');
    const player = {
      id,
      name,
      seat,
      chips: this.settings.startingChips,
      buyIns: 1,
      hand: [],
      bet: 0,
      totalBet: 0,
      inHand: false,
      folded: false,
      allIn: false,
      acted: false,
      raiseLocked: false,
      connected: true,
      leaving: false,
      lastAction: null,
    };
    this.players.set(id, player);
    this.seats[seat] = id;
    if (!this.hostId) this.hostId = id;
    this._log(`${name} 加入了牌桌`);
    this.seq++;
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this._log(`${p.name} 离开了牌桌`);
    if (this.isHandActive() && p.inHand && !p.folded) {
      p.leaving = true;
      if (this.toActSeat === p.seat) {
        this.act(id, 'fold');
      } else {
        p.folded = true;
        p.lastAction = '弃牌';
        this.seq++;
        if (this._live().length === 1) this._finishHand();
      }
    }
    // 本手结束后（或者没在牌局中）直接移除
    if (this.isHandActive() && p.inHand) {
      p.leaving = true;
      if (this.hostId === id) {
        const next = [...this.players.values()].find((x) => !x.leaving);
        this.hostId = next ? next.id : null;
      }
    } else {
      this._deletePlayer(id);
    }
    this.seq++;
  }

  _deletePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.seats[p.seat] = null;
    this.players.delete(id);
    if (this.hostId === id) {
      const next = [...this.players.values()].find((x) => !x.leaving);
      this.hostId = next ? next.id : null;
    }
  }

  rebuy(id) {
    const p = this._get(id);
    if (this.isHandActive() && p.inHand) throw new GameError('本手结束后才能补码');
    if (p.chips > 0) throw new GameError('还有筹码时不能补码');
    p.chips = this.settings.startingChips;
    p.buyIns++;
    this._log(`${p.name} 补充了 ${this.settings.startingChips} 筹码`);
    this.seq++;
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (p) {
      p.connected = connected;
      this.seq++;
    }
  }

  // ---------- 牌局流程 ----------

  isHandActive() {
    return BETTING_STAGES.includes(this.stage);
  }

  canStartHand() {
    return !this.isHandActive() && this._eligible().length >= 2;
  }

  startHand() {
    if (this.isHandActive()) throw new GameError('当前牌局还没结束');
    for (const p of [...this.players.values()]) if (p.leaving) this._deletePlayer(p.id);
    const eligible = this._eligible();
    if (eligible.length < 2) throw new GameError('至少需要 2 名有筹码的玩家');

    this.handNumber++;
    this.board = [];
    this.lastResult = null;
    this.deck = shuffle(createDeck(), this.random);
    for (const p of this.players.values()) {
      Object.assign(p, {
        hand: [],
        bet: 0,
        totalBet: 0,
        inHand: eligible.includes(p),
        folded: false,
        allIn: false,
        acted: false,
        raiseLocked: false,
        lastAction: null,
      });
    }

    const inHand = (p) => p.inHand;
    this.dealerSeat = this._nextSeat(this.dealerSeat, inHand);
    const headsUp = eligible.length === 2;
    this.sbSeat = headsUp ? this.dealerSeat : this._nextSeat(this.dealerSeat, inHand);
    this.bbSeat = this._nextSeat(this.sbSeat, inHand);

    const { smallBlind, bigBlind } = this.settings;
    this._pay(this._atSeat(this.sbSeat), smallBlind);
    this._atSeat(this.sbSeat).lastAction = `小盲 ${this._atSeat(this.sbSeat).bet}`;
    this._pay(this._atSeat(this.bbSeat), bigBlind);
    this._atSeat(this.bbSeat).lastAction = `大盲 ${this._atSeat(this.bbSeat).bet}`;
    this.currentBet = bigBlind;
    this.minRaise = bigBlind;

    // 从庄家左手边开始，每人发两张
    for (let round = 0; round < 2; round++) {
      let seat = this.dealerSeat;
      for (let i = 0; i < eligible.length; i++) {
        seat = this._nextSeat(seat, inHand);
        this._atSeat(seat).hand.push(this.deck.pop());
      }
    }

    this.stage = 'preflop';
    this._log(`第 ${this.handNumber} 手开始`);
    this.toActSeat = -1;
    this._progress(this.bbSeat);
  }

  /**
   * type: fold | check | call | raise | allin
   * raise 的 amount 表示"加注到"的总额（本轮下注总数）
   */
  act(id, type, amount) {
    const p = this._get(id);
    if (!this.isHandActive()) throw new GameError('现在不在下注阶段');
    if (this.toActSeat !== p.seat) throw new GameError('还没轮到你');

    const toCall = this.currentBet - p.bet;
    const maxTotal = p.bet + p.chips;

    if (type === 'allin') {
      if (maxTotal > this.currentBet && !p.raiseLocked) {
        type = 'raise';
        amount = maxTotal;
      } else {
        type = 'call';
      }
    }

    switch (type) {
      case 'fold':
        p.folded = true;
        p.lastAction = '弃牌';
        break;
      case 'check':
        if (toCall > 0) throw new GameError('需要跟注，不能过牌');
        p.lastAction = '过牌';
        break;
      case 'call': {
        if (toCall <= 0) throw new GameError('没有需要跟的注');
        this._pay(p, toCall);
        p.lastAction = p.allIn ? `全下 ${p.bet}` : `跟注 ${p.bet}`;
        break;
      }
      case 'raise': {
        if (p.raiseLocked) throw new GameError('对方的全下不足一个完整加注，你只能跟注或弃牌');
        amount = Math.floor(Number(amount));
        if (!Number.isFinite(amount)) throw new GameError('无效的金额');
        if (amount > maxTotal) amount = maxTotal;
        if (amount <= this.currentBet) throw new GameError('加注额必须大于当前注额');
        const raiseSize = amount - this.currentBet;
        const isAllIn = amount === maxTotal;
        if (raiseSize < this.minRaise && !isAllIn) {
          throw new GameError(`最少要加注到 ${this.currentBet + this.minRaise}`);
        }
        const wasBet = this.currentBet === 0;
        this._pay(p, amount - p.bet);
        const fullRaise = raiseSize >= this.minRaise;
        for (const o of this._live()) {
          if (o === p || o.allIn) continue;
          // 完整加注：所有人重新获得行动权；不完整的全下：已行动过的人只能跟或弃
          if (fullRaise) o.raiseLocked = false;
          else if (o.acted) o.raiseLocked = true;
          o.acted = false;
        }
        if (fullRaise) this.minRaise = raiseSize;
        this.currentBet = amount;
        p.lastAction = isAllIn ? `全下 ${amount}` : `${wasBet ? '下注' : '加注到'} ${amount}`;
        break;
      }
      default:
        throw new GameError('未知操作');
    }

    p.acted = true;
    this._log(`${p.name} ${p.lastAction}`);
    this._progress(p.seat);
  }

  // 超时自动操作：能过牌就过牌，否则弃牌
  autoAct(id) {
    const p = this._get(id);
    this.act(id, p.bet >= this.currentBet ? 'check' : 'fold');
  }

  // 找下一个需要行动的玩家；如果本轮下注结束则进入下一条街
  _progress(fromSeat) {
    this.seq++;
    const live = this._live();
    if (live.length === 1) return this._finishHand();

    const canAct = live.filter((p) => !p.allIn);
    const pending = canAct.filter((p) => !p.acted || p.bet < this.currentBet);
    const onlyOneLeft = canAct.length <= 1 && canAct.every((p) => p.bet >= this.currentBet);

    if (pending.length > 0 && !onlyOneLeft) {
      this.toActSeat = this._nextSeat(fromSeat, (p) => pending.includes(p));
      return;
    }
    this._nextStreet();
  }

  _nextStreet() {
    for (const p of this.players.values()) {
      p.bet = 0;
      p.acted = false;
      p.raiseLocked = false;
    }
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;
    this.toActSeat = -1;

    if (this.stage === 'river') return this._finishHand();

    this.deck.pop(); // 烧一张牌
    const count = this.stage === 'preflop' ? 3 : 1;
    for (let i = 0; i < count; i++) this.board.push(this.deck.pop());
    this.stage = NEXT_STAGE[this.stage];
    for (const p of this._live()) if (!p.allIn) p.lastAction = null;
    this._progress(this.dealerSeat);
  }

  _finishHand() {
    const inHand = [...this.players.values()].filter((p) => p.inHand);
    const live = this._live();

    // 退还没有人跟的那部分下注（弃牌者投入的筹码留在底池里）
    const sorted = [...inHand].sort((a, b) => b.totalBet - a.totalBet);
    if (sorted.length > 1 && !sorted[0].folded && sorted[0].totalBet > sorted[1].totalBet) {
      const refund = sorted[0].totalBet - sorted[1].totalBet;
      sorted[0].totalBet -= refund;
      sorted[0].chips += refund;
    }

    const pots = buildPots(inHand);
    const winnings = new Map();
    const shown = [];
    const result = { handNumber: this.handNumber, pots: [], board: [...this.board] };

    if (live.length === 1) {
      const winner = live[0];
      const total = pots.reduce((s, pot) => s + pot.amount, 0);
      winnings.set(winner.id, total);
      result.pots.push({ amount: total, winners: [winner.id], handName: null });
      result.uncontested = true;
    } else {
      const evals = new Map();
      for (const p of live) {
        evals.set(p.id, evaluateBest([...p.hand, ...this.board]));
        shown.push(p.id);
      }
      for (const pot of pots) {
        let best = null;
        let winners = [];
        for (const id of pot.eligible) {
          const e = evals.get(id);
          const cmp = best ? compareScores(e.score, best.score) : 1;
          if (cmp > 0) {
            best = e;
            winners = [id];
          } else if (cmp === 0) {
            winners.push(id);
          }
        }
        // 多余的零头给庄家左手边最近的赢家
        winners.sort(
          (a, b) => this._distFromDealer(this.players.get(a).seat) - this._distFromDealer(this.players.get(b).seat)
        );
        const share = Math.floor(pot.amount / winners.length);
        let remainder = pot.amount - share * winners.length;
        for (const id of winners) {
          const amt = share + (remainder > 0 ? 1 : 0);
          if (remainder > 0) remainder--;
          winnings.set(id, (winnings.get(id) || 0) + amt);
        }
        result.pots.push({ amount: pot.amount, winners, handName: best.name, bestCards: best.cards });
      }
      result.hands = Object.fromEntries(
        [...evals].map(([id, e]) => [id, { name: e.name, cards: e.cards }])
      );
    }

    for (const [id, amt] of winnings) this.players.get(id).chips += amt;
    result.winnings = Object.fromEntries(winnings);
    result.shown = shown;
    for (const [id, amt] of winnings) this._log(`${this.players.get(id).name} 赢得 ${amt}`);

    this.lastResult = result;
    this.stage = 'showdown';
    this.toActSeat = -1;
    this.seq++;
  }

  // ---------- 状态输出 ----------

  getState(viewerId) {
    const viewer = this.players.get(viewerId);
    const shown = new Set(this.lastResult?.shown || []);
    const players = [...this.players.values()].map((p) => {
      let cards = null;
      if (p.id === viewerId || (this.stage === 'showdown' && shown.has(p.id))) cards = p.hand;
      else if (p.inHand && !p.folded && p.hand.length) cards = ['??', '??'];
      return {
        id: p.id,
        name: p.name,
        seat: p.seat,
        chips: p.chips,
        buyIns: p.buyIns,
        bet: p.bet,
        totalBet: p.totalBet,
        inHand: p.inHand,
        folded: p.folded,
        allIn: p.allIn,
        connected: p.connected,
        lastAction: p.lastAction,
        cards,
      };
    });

    let actions = null;
    if (viewer && this.isHandActive() && this.toActSeat === viewer.seat) {
      const toCall = this.currentBet - viewer.bet;
      const maxTotal = viewer.bet + viewer.chips;
      const canRaise = !viewer.raiseLocked && maxTotal > this.currentBet;
      actions = {
        canCheck: toCall <= 0,
        callAmount: Math.min(toCall, viewer.chips),
        canRaise,
        minRaiseTo: canRaise ? Math.min(this.currentBet + this.minRaise, maxTotal) : 0,
        maxRaiseTo: canRaise ? maxTotal : 0,
        isBet: this.currentBet === 0,
      };
    }

    const pot = this.isHandActive()
      ? [...this.players.values()].reduce((s, p) => s + (p.inHand ? p.totalBet : 0), 0)
      : 0;

    return {
      stage: this.stage,
      handNumber: this.handNumber,
      settings: this.settings,
      hostId: this.hostId,
      board: this.board,
      pot,
      currentBet: this.currentBet,
      dealerSeat: this.dealerSeat,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      toActSeat: this.toActSeat,
      players,
      you: viewer
        ? {
            id: viewer.id,
            seat: viewer.seat,
            // 只在自己还拿着牌时给出牌型提示
            hand:
              viewer.inHand && !viewer.folded && viewer.hand.length && this.stage !== 'waiting'
                ? describeHand(viewer.hand, this.board)
                : null,
          }
        : null,
      actions,
      lastResult: this.stage === 'showdown' ? this.lastResult : null,
      log: this.log.slice(-30),
    };
  }

  toActPlayer() {
    return this.toActSeat >= 0 ? this._atSeat(this.toActSeat) : null;
  }

  // ---------- 工具函数 ----------

  _get(id) {
    const p = this.players.get(id);
    if (!p) throw new GameError('你不在这张牌桌上');
    return p;
  }

  _atSeat(seat) {
    return this.players.get(this.seats[seat]);
  }

  _eligible() {
    return [...this.players.values()].filter((p) => p.chips > 0 && !p.leaving);
  }

  _live() {
    return [...this.players.values()].filter((p) => p.inHand && !p.folded);
  }

  _nextSeat(from, predicate) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const seat = (((from + i) % n) + n) % n;
      const p = this._atSeat(seat);
      if (p && predicate(p)) return seat;
    }
    return -1;
  }

  _distFromDealer(seat) {
    const n = this.seats.length;
    return (seat - this.dealerSeat - 1 + n) % n;
  }

  _pay(p, amount) {
    const amt = Math.min(amount, p.chips);
    p.chips -= amt;
    p.bet += amt;
    p.totalBet += amt;
    if (p.chips === 0) p.allIn = true;
  }

  _log(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 100) this.log.shift();
  }
}

// 按每个人投入的筹码切分主池和边池
function buildPots(inHand) {
  const live = inHand.filter((p) => !p.folded);
  const levels = [...new Set(live.map((p) => p.totalBet))].filter((x) => x > 0).sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of inHand) amount += Math.max(0, Math.min(p.totalBet, level) - prev);
    const eligible = live.filter((p) => p.totalBet >= level).map((p) => p.id);
    const last = pots[pots.length - 1];
    if (last && last.eligible.length === eligible.length) last.amount += amount;
    else if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  // 理论上不会出现：弃牌玩家投入比所有存活玩家都多的部分，并入最后一个池
  const leftover = inHand.reduce((s, p) => s + Math.max(0, p.totalBet - prev), 0);
  if (leftover > 0 && pots.length) pots[pots.length - 1].amount += leftover;
  return pots;
}

module.exports = { Table, GameError, buildPots };
