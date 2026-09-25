'use strict';

const socket = io();
const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'holdem-session';
const NAME_KEY = 'holdem-name';
const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };

let state = null;
let session = null; // { code, playerId }
let lastLogT = 0;

// ---------- 工具 ----------

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}
function saveSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
}

function toast(text, ms = 2200) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

function emit(event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => {
      if (res && res.error) toast(res.error);
      resolve(res || {});
    });
  });
}

function fmt(n) {
  return Number(n).toLocaleString('zh-CN');
}

function cardEl(card, extra = '') {
  const el = document.createElement('div');
  if (card === '??') {
    el.className = 'card back ' + extra;
    return el;
  }
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  el.className = `card ${suit === 'h' || suit === 'd' ? 'red' : ''} ${extra}`;
  el.innerHTML = `<span class="r">${rank}</span><span class="s">${SUIT_SYMBOL[suit]}</span>`;
  return el;
}

function inviteLink() {
  return `${location.origin}${location.pathname}?room=${state.roomCode}`;
}

// ---------- 大厅 ----------

const params = new URLSearchParams(location.search);
const roomParam = (params.get('room') || '').toUpperCase();
$('nameInput').value = localStorage.getItem(NAME_KEY) || '';
if (roomParam) {
  $('codeInput').value = roomParam;
  $('lobby').querySelector('.subtitle').textContent = `好友邀请你加入房间 ${roomParam}`;
}

function getName() {
  const name = $('nameInput').value.trim();
  if (!name) {
    $('lobbyError').textContent = '请先输入昵称';
    $('nameInput').focus();
    return null;
  }
  localStorage.setItem(NAME_KEY, name);
  return name;
}

$('createBtn').onclick = async () => {
  const name = getName();
  if (!name) return;
  const res = await emit('createRoom', {
    name,
    settings: {
      bigBlind: $('bbInput').value,
      startingChips: $('chipsInput').value,
      maxSeats: $('seatsInput').value,
    },
  });
  if (res.ok) enterRoom(res);
};

$('joinBtn').onclick = async () => {
  const name = getName();
  if (!name) return;
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return ($('lobbyError').textContent = '请输入房间号');
  const prev = loadSession();
  const res = await emit('joinRoom', {
    code,
    name,
    playerId: prev && prev.code === code ? prev.playerId : undefined,
  });
  if (res.ok) enterRoom(res);
  else $('lobbyError').textContent = res.error || '';
};
$('codeInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('joinBtn').click());

function enterRoom({ code, playerId }) {
  saveSession({ code, playerId });
  history.replaceState(null, '', `?room=${code}`);
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('lobbyError').textContent = '';
}

function backToLobby() {
  saveSession(null);
  state = null;
  history.replaceState(null, '', location.pathname);
  $('game').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  $('chatLog').innerHTML = '';
  lastLogT = 0;
}

// 断线/刷新后自动回到之前的房间
socket.on('connect', async () => {
  const prev = loadSession();
  if (!prev) return;
  if (roomParam && roomParam !== prev.code && !session) return; // 点了别人的邀请链接
  const res = await new Promise((r) =>
    socket.emit('joinRoom', { code: prev.code, playerId: prev.playerId, name: localStorage.getItem(NAME_KEY) }, r)
  );
  if (res && res.ok) enterRoom(res);
  else saveSession(null);
});

// ---------- 牌桌 ----------

$('leaveBtn').onclick = async () => {
  if (state && state.stage !== 'waiting' && state.stage !== 'showdown') {
    const me = state.players.find((p) => p.id === state.you?.id);
    if (me && me.inHand && !me.folded && !confirm('牌局进行中，离开将自动弃牌，确定离开吗？')) return;
  }
  await emit('leaveRoom');
  backToLobby();
};

// 邀请弹窗：直接显示链接并提供复制按钮，不依赖系统分享面板（Windows 上经常打不开）
function inviteText() {
  return `来和我打德州扑克！房间号 ${state.roomCode}，点链接加入：${inviteLink()}`;
}

$('inviteBtn').onclick = () => {
  $('inviteCode').textContent = state.roomCode;
  $('inviteLink').value = inviteLink();
  // 只有手机上才显示"更多分享方式"，桌面系统的分享面板不可靠
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  $('shareBtn').classList.toggle('hidden', !(navigator.share && mobile));
  $('inviteModal').classList.remove('hidden');
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 兼容不支持 clipboard API 的浏览器
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }
}

$('copyLinkBtn').onclick = async () => {
  if (await copyText(inviteText())) {
    toast('已复制，粘贴到微信/QQ 发给好友吧');
    $('inviteModal').classList.add('hidden');
  } else {
    $('inviteLink').select();
    toast('复制失败，请手动选中链接复制');
  }
};
$('shareBtn').onclick = async () => {
  try {
    await navigator.share({ title: '德州扑克邀请', text: inviteText() });
    $('inviteModal').classList.add('hidden');
  } catch {}
};
$('inviteLink').onfocus = (e) => e.target.select();
$('inviteClose').onclick = () => $('inviteModal').classList.add('hidden');
$('inviteModal').onclick = (e) => {
  if (e.target.id === 'inviteModal') $('inviteModal').classList.add('hidden');
};

$('startBtn').onclick = () => emit('startGame');
$('rebuyBtn').onclick = () => emit('rebuy');
$('foldBtn').onclick = () => emit('action', { type: 'fold' });
$('callBtn').onclick = () => {
  const a = state.actions;
  emit('action', { type: a.canCheck ? 'check' : 'call' });
};
$('raiseBtn').onclick = () => {
  const panel = $('raisePanel');
  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
    $('raiseBtn').textContent = '确认 ' + fmt($('raiseAmount').value);
  } else {
    const amount = Number($('raiseAmount').value);
    emit('action', { type: amount >= state.actions.maxRaiseTo ? 'allin' : 'raise', amount });
  }
};
$('raiseSlider').oninput = (e) => setRaise(Number(e.target.value));
$('raiseAmount').oninput = (e) => setRaise(Number(e.target.value), false);
document.querySelectorAll('.presets button').forEach((btn) => {
  btn.onclick = () => {
    const a = state.actions;
    if (btn.dataset.frac === 'all') return setRaise(a.maxRaiseTo);
    const me = myPlayer();
    const toCall = state.currentBet - me.bet;
    // 按底池比例加注：跟注后再加上 (底池 + 跟注额) × 比例
    setRaise(Math.round(state.currentBet + (state.pot + toCall) * Number(btn.dataset.frac)));
  };
});

function setRaise(v, syncInput = true) {
  const a = state && state.actions;
  if (!a || !a.canRaise) return;
  const clamped = Math.max(a.minRaiseTo, Math.min(a.maxRaiseTo, Math.round(v) || 0));
  $('raiseSlider').value = clamped;
  if (syncInput) $('raiseAmount').value = clamped;
  const allIn = clamped >= a.maxRaiseTo;
  if (!$('raisePanel').classList.contains('hidden')) {
    $('raiseBtn').textContent = allIn ? `全下 ${fmt(clamped)}` : `确认 ${fmt(clamped)}`;
  }
}

function myPlayer() {
  return state && state.players.find((p) => p.id === state.you?.id);
}

socket.on('state', (s) => {
  const prevTurn = state && state.actions;
  const now = Date.now();
  s.turnDeadline = s.turnMsLeft != null ? now + s.turnMsLeft : null;
  s.nextHandAt = s.nextHandMsLeft != null ? now + s.nextHandMsLeft : null;
  state = s;
  render();
  if (s.actions && !prevTurn && navigator.vibrate) navigator.vibrate(80);
});

socket.on('chat', ({ name, text }) => {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<b></b> `;
  div.querySelector('b').textContent = name + '：';
  div.append(text);
  addToLog(div);
  if ($('chatPanel').classList.contains('hidden')) {
    $('chatBadge').classList.remove('hidden');
    toast(`${name}：${text}`);
  }
});

function addToLog(el) {
  const log = $('chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(el);
  while (log.children.length > 200) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

$('chatToggle').onclick = () => {
  $('chatPanel').classList.remove('hidden');
  $('chatBadge').classList.add('hidden');
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
};
$('chatClose').onclick = () => $('chatPanel').classList.add('hidden');
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (text) emit('chat', { text });
  $('chatInput').value = '';
};

// ---------- 渲染 ----------

function seatPosition(seat, maxSeats, mySeat, radius) {
  // 自己固定在正下方，其他人按顺时针排开
  const offset = mySeat == null ? 0 : seat - mySeat;
  const angle = Math.PI / 2 + (offset * 2 * Math.PI) / maxSeats;
  return { x: 50 + radius.x * Math.cos(angle), y: 50 + radius.y * Math.sin(angle) };
}

function render() {
  const s = state;
  const me = myPlayer();
  const handActive = ['preflop', 'flop', 'turn', 'river'].includes(s.stage);
  const winners = new Set();
  const winCards = new Set();
  if (s.lastResult) {
    for (const pot of s.lastResult.pots) {
      pot.winners.forEach((id) => winners.add(id));
      (pot.bestCards || []).forEach((c) => winCards.add(c));
    }
  }

  $('roomCode').textContent = s.roomCode;
  $('blindsInfo').textContent = `盲注 ${s.settings.smallBlind}/${s.settings.bigBlind}`;

  // 底池和公共牌
  $('pot').textContent = s.pot ? `底池 ${fmt(s.pot)}` : '';
  const board = $('board');
  const boardKey = s.board.join(',') + '|' + [...winCards].join(',');
  if (board.dataset.key !== boardKey) {
    board.dataset.key = boardKey;
    board.innerHTML = '';
    for (const c of s.board) board.append(cardEl(c, winCards.size ? (winCards.has(c) ? 'win' : 'dim') : ''));
  }

  // 中间提示
  let center = '';
  if (s.stage === 'waiting') {
    const n = s.players.length;
    center = n < 2 ? '等待好友加入…点右上角「邀请好友」' : `${n} 位玩家已就座`;
  }
  $('centerMsg').textContent = center;

  // 座位
  const wide = window.innerWidth > 600;
  const radius = wide ? { x: 46, y: 44 } : { x: 42, y: 45 };
  const betRadius = wide ? { x: 30, y: 26 } : { x: 26, y: 30 };
  const seatsEl = $('seats');
  seatsEl.innerHTML = '';
  const bySeat = new Map(s.players.map((p) => [p.seat, p]));
  const mySeat = me ? me.seat : null;

  for (let seat = 0; seat < s.settings.maxSeats; seat++) {
    const pos = seatPosition(seat, s.settings.maxSeats, mySeat, radius);
    const p = bySeat.get(seat);
    if (!p) {
      const empty = document.createElement('div');
      empty.className = 'empty-seat';
      empty.style.left = pos.x + '%';
      empty.style.top = pos.y + '%';
      empty.textContent = '空位';
      seatsEl.append(empty);
      continue;
    }

    const el = document.createElement('div');
    el.className = 'seat';
    if (p.id === s.you?.id) el.classList.add('me');
    if (handActive && s.toActSeat === seat) el.classList.add('turn');
    if (p.folded || (!p.inHand && s.stage !== 'waiting')) el.classList.add('folded');
    if (!p.connected) el.classList.add('offline');
    if (winners.has(p.id)) el.classList.add('winner');
    el.style.left = pos.x + '%';
    el.style.top = pos.y + '%';

    const hole = document.createElement('div');
    hole.className = 'hole';
    if (p.cards) {
      for (const c of p.cards) {
        const cls = winCards.size && c !== '??' ? (winCards.has(c) ? 'win' : 'dim') : '';
        hole.append(cardEl(c, cls));
      }
    }
    el.append(hole);

    const plate = document.createElement('div');
    plate.className = 'plate';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = (p.id === s.hostId ? '👑 ' : '') + p.name;
    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.textContent = p.chips > 0 ? fmt(p.chips) : p.inHand ? '全下' : '没有筹码';
    plate.append(name, chips);

    if (handActive && s.toActSeat === seat && s.turnDeadline) {
      const timer = document.createElement('div');
      timer.className = 'timer';
      timer.dataset.deadline = s.turnDeadline;
      plate.append(timer);
    }
    if (s.dealerSeat === seat && s.stage !== 'waiting') {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = 'D';
      plate.append(tag);
    }
    el.append(plate);

    let label = p.lastAction;
    if (s.lastResult && s.lastResult.hands && s.lastResult.hands[p.id]) label = s.lastResult.hands[p.id].name;
    if (s.lastResult && s.lastResult.winnings[p.id]) label = `赢 ${fmt(s.lastResult.winnings[p.id])}`;
    if (label) {
      const la = document.createElement('div');
      la.className = 'last-action';
      la.textContent = label;
      el.append(la);
    }
    seatsEl.append(el);

    if (p.bet > 0) {
      const bpos = seatPosition(seat, s.settings.maxSeats, mySeat, betRadius);
      const chip = document.createElement('div');
      chip.className = 'bet-chip';
      chip.style.left = bpos.x + '%';
      chip.style.top = bpos.y + '%';
      chip.textContent = fmt(p.bet);
      seatsEl.append(chip);
    }
  }

  renderResult();
  renderControls(me, handActive);
  renderLog();
  tickTimers();
}

function renderResult() {
  const s = state;
  const banner = $('resultBanner');
  if (!s.lastResult) return banner.classList.add('hidden');
  const nameOf = (id) => s.players.find((p) => p.id === id)?.name || '已离开';
  const lines = s.lastResult.pots.map((pot, i) => {
    const who = pot.winners.map(nameOf).join('、');
    const potName = s.lastResult.pots.length > 1 ? (i === 0 ? '主池' : `边池${i}`) : '底池';
    const how = pot.handName ? `（${pot.handName}）` : '';
    return `<b></b> 赢得${potName} ${fmt(pot.amount)}${how}`.replace('<b></b>', `<b>${escapeHtml(who)}</b>`);
  });
  banner.innerHTML = lines.join('<br>') + '<div class="muted" id="nextHandMsg"></div>';
  banner.classList.remove('hidden');
}

function renderControls(me, handActive) {
  const s = state;
  const a = s.actions;
  const isHost = s.you && s.hostId === s.you.id;
  const canStart = s.players.filter((p) => p.chips > 0).length >= 2;

  $('hostControls').classList.toggle('hidden', !(isHost && !s.started && !handActive));
  $('startBtn').disabled = !canStart;
  $('startBtn').textContent = canStart ? (s.handNumber ? '继续游戏' : '开始游戏') : '至少需要 2 名玩家';

  const busted = me && me.chips === 0 && !(handActive && me.inHand);
  $('rebuyControls').classList.toggle('hidden', !busted);
  $('rebuyBtn').textContent = `补充筹码（${fmt(s.settings.startingChips)}）`;

  $('actionControls').classList.toggle('hidden', !a);
  if (a) {
    $('callBtn').textContent = a.canCheck ? '过牌' : `跟注 ${fmt(a.callAmount)}`;
    $('raiseBtn').disabled = !a.canRaise;
    const slider = $('raiseSlider');
    const turnKey = `${s.handNumber}-${s.stage}-${s.currentBet}`;
    if (slider.dataset.turn !== turnKey) {
      slider.dataset.turn = turnKey;
      $('raisePanel').classList.add('hidden');
      slider.min = a.minRaiseTo;
      slider.max = a.maxRaiseTo;
      slider.step = 1;
      $('raiseAmount').min = a.minRaiseTo;
      $('raiseAmount').max = a.maxRaiseTo;
      setRaise(a.minRaiseTo);
      $('raiseBtn').textContent = a.canRaise ? (a.isBet ? '下注' : '加注') : '加注';
    }
  } else {
    $('raiseSlider').dataset.turn = '';
    $('raisePanel').classList.add('hidden');
  }

  let wait = '';
  if (!a) {
    if (s.stage === 'waiting' && !isHost) wait = '等待房主开始游戏…';
    else if (handActive && me && !me.inHand) wait = '下一手开始时加入';
    else if (handActive && me && me.folded) wait = '已弃牌，等待本手结束';
    else if (handActive) {
      const actor = s.players.find((p) => p.seat === s.toActSeat);
      if (actor) wait = `等待 ${actor.name} 行动…`;
    } else if (s.stage === 'showdown' && !s.started && !isHost) wait = '等待房主继续游戏…';
  }
  $('waitMsg').textContent = wait;
}

function renderLog() {
  const newest = state.log.filter((e) => e.t > lastLogT);
  for (const e of newest) {
    const div = document.createElement('div');
    div.className = 'sys';
    div.textContent = e.text;
    addToLog(div);
  }
  if (newest.length) lastLogT = newest[newest.length - 1].t;
}

function tickTimers() {
  const now = Date.now();
  document.querySelectorAll('.timer').forEach((el) => {
    const left = Math.max(0, Number(el.dataset.deadline) - now);
    const totalMs = (state && state.turnMsTotal) || 30000;
    el.style.width = Math.min(100, (left / totalMs) * 100) + '%';
    el.style.background = left < Math.min(8000, totalMs / 3) ? 'var(--red)' : '';
  });
  const nh = $('nextHandMsg');
  if (nh && state) {
    nh.textContent = state.nextHandAt
      ? `${Math.max(0, Math.ceil((state.nextHandAt - now) / 1000))} 秒后开始下一手`
      : '';
  }
}
setInterval(tickTimers, 250);
window.addEventListener('resize', () => state && render());

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
