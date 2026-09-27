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
  leaveVoice(false);
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
$('showBtn').onclick = () => emit('showCards');
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
    const host = s.you && s.hostId === s.you.id;
    center = n < 2 ? '等待好友加入…点右上角「邀请好友」' : `${n} 位玩家已就座`;
    if (host && n < s.settings.maxSeats) center += '\n点空位可以添加机器人 🤖';
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
      if (s.you && s.hostId === s.you.id) {
        empty.classList.add('can-add');
        empty.textContent = '+🤖';
        empty.title = '添加机器人';
        empty.onclick = () => emit('addBot', { seat });
      }
      seatsEl.append(empty);
      continue;
    }

    const el = document.createElement('div');
    el.className = 'seat';
    el.dataset.pid = p.id;
    if (voiceSpeaking.has(p.id)) el.classList.add('speaking');
    if (p.id === s.you?.id) el.classList.add('me');
    if (handActive && s.toActSeat === seat) el.classList.add('turn');
    const showedCards = s.lastResult && s.lastResult.shown.includes(p.id);
    if ((p.folded && !showedCards) || (!p.inHand && s.stage !== 'waiting')) el.classList.add('folded');
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
    const v = (s.voice || []).find((x) => x.playerId === p.id);
    name.textContent = (v ? (v.muted ? '🔇' : '🎙') : '') + (p.id === s.hostId ? '👑 ' : '') + p.name;
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
    if (p.isBot && s.you && s.hostId === s.you.id) {
      const kick = document.createElement('button');
      kick.className = 'kick';
      kick.textContent = '×';
      kick.title = '移除机器人';
      kick.onclick = () => emit('removeBot', { id: p.id });
      plate.append(kick);
    }
    el.append(plate);

    let label = p.lastAction;
    if (s.lastResult && s.lastResult.shown.includes(p.id)) label = '亮牌';
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
  renderHandHint();
  renderControls(me, handActive);
  renderLog();
  tickTimers();
}

function renderHandHint() {
  const hint = $('handHint');
  const h = state.you && state.you.hand;
  if (!h || state.stage === 'showdown') return hint.classList.add('hidden');
  hint.innerHTML = `你当前的牌型：<b></b>`;
  hint.querySelector('b').textContent = h.text;
  if (h.boardPlays) {
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = '⚠ 这 5 张全部来自公共牌，对手至少也有这手牌，最好只能平分';
    hint.append(warn);
  }
  hint.classList.remove('hidden');
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
  $('showControls').classList.toggle('hidden', !(s.you && s.you.canShow));
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
    const totalMs = (state && state.turnMsTotal) || 60000;
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

// ---------- 规则说明 ----------

const HAND_RANKS = [
  ['皇家同花顺', '同花色的 10-J-Q-K-A', 'Ts Js Qs Ks As'],
  ['同花顺', '同花色的五张连续牌', '5h 6h 7h 8h 9h'],
  ['四条', '四张同点数', 'Kc Kd Kh Ks 3d'],
  ['葫芦', '三条 + 一对', 'Qc Qd Qh 7s 7d'],
  ['同花', '五张同花色', '2d 6d 9d Jd Ad'],
  ['顺子', '五张连续点数', '6c 7d 8h 9s Tc'],
  ['三条', '三张同点数', '8c 8d 8h Ks 4d'],
  ['两对', '两个对子', 'Jc Jd 4h 4s Ad'],
  ['一对', '两张同点数', 'Ac Ad 9h 6s 2d'],
  ['高牌', '什么都没有，比最大的牌', 'Ac Jd 8h 5s 3c'],
];

function buildRankList() {
  const list = $('rankList');
  for (const [name, desc, cards] of HAND_RANKS) {
    const row = document.createElement('div');
    row.className = 'rank-row';
    const label = document.createElement('div');
    label.className = 'rank-name';
    label.innerHTML = `${name}<small>${desc}</small>`;
    const cardsEl = document.createElement('div');
    cardsEl.className = 'cards';
    for (const c of cards.split(' ')) cardsEl.append(cardEl(c));
    row.append(label, cardsEl);
    list.append(row);
  }
}
buildRankList();

document.querySelectorAll('.rules-open').forEach((btn) => {
  btn.onclick = () => $('rulesModal').classList.remove('hidden');
});
$('rulesClose').onclick = () => $('rulesModal').classList.add('hidden');
$('rulesModal').onclick = (e) => {
  if (e.target.id === 'rulesModal') $('rulesModal').classList.add('hidden');
};

// ---------- 语音聊天（WebRTC，服务器只转发信令；配置了 TURN 时无法直连会自动走中转） ----------

const FALLBACK_ICE = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
  { urls: 'stun:stun.miwifi.com:3478' },
];
const EFFECT_KEY = 'holdem-voice-effect';

// 变声预设：pitch 是音高倍数，eq 是 [类型, 频率, 增益dB, Q]
const VOICE_EFFECTS = {
  none: { name: '原声', desc: '不做任何处理，音质最好' },
  yujie: {
    name: '御姐音',
    desc: '成熟、有气场的女声',
    pitch: 1.22,
    eq: [['highpass', 120], ['lowshelf', 300, 2], ['peaking', 1800, 2, 1], ['highshelf', 6000, 2]],
  },
  sweet: {
    name: '可爱甜美音',
    desc: '软萌甜美的少女声',
    pitch: 1.45,
    eq: [['highpass', 200], ['peaking', 3000, 4, 1], ['highshelf', 7000, 3]],
  },
  fry: {
    name: '男性气泡音',
    desc: '低沉、带颗粒感的"气泡"声',
    pitch: 0.78,
    eq: [['lowshelf', 180, 4], ['lowpass', 5000]],
    tremolo: { rate: 34, depth: 0.6 },
  },
  magnetic: {
    name: '磁性嗓音',
    desc: '浑厚低沉、带一点混响',
    pitch: 0.87,
    eq: [['lowshelf', 160, 6], ['peaking', 3200, -2, 1], ['highshelf', 8000, -3]],
    reverb: 0.15,
  },
  shota: {
    name: '正太音',
    desc: '清亮的小男孩声',
    pitch: 1.3,
    eq: [['highpass', 160], ['peaking', 2200, 3, 1.2]],
  },
};

const voice = {
  joined: false,
  raw: null, // 麦克风原始流
  sendTrack: null, // 发给别人的音轨（可能经过变声处理）
  sendStream: null,
  muted: false,
  peers: new Map(),
  ctx: null,
  worklet: false,
  chain: [], // 当前变声处理链的节点
  chainOut: null, // 处理链的最终输出（试听用）
  monitor: false,
  effect: 'none',
  iceServers: FALLBACK_ICE,
  relay: false,
  analyser: null,
  speaking: false,
  lastLoud: 0,
};
try {
  const saved = localStorage.getItem(EFFECT_KEY);
  if (saved && VOICE_EFFECTS[saved]) voice.effect = saved;
} catch {}
const voiceSpeaking = new Set();

function voiceSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
}

// 打开麦克风和音频处理（加入语音或试听变声时调用）
async function prepareAudio() {
  if (voice.raw) return true;
  if (!voiceSupported()) {
    toast('当前浏览器不支持语音，请用手机自带浏览器（Safari / Chrome）打开网址', 4000);
    return false;
  }
  try {
    voice.raw = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch {
    toast('没有拿到麦克风权限，请在浏览器设置里允许使用麦克风', 4000);
    return false;
  }
  try {
    voice.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await voice.ctx.resume();
    const src = voice.ctx.createMediaStreamSource(voice.raw);
    voice.analyser = voice.ctx.createAnalyser();
    voice.analyser.fftSize = 512;
    src.connect(voice.analyser);
    voice.analyserData = new Uint8Array(voice.analyser.fftSize);
    if (voice.ctx.audioWorklet) {
      await voice.ctx.audioWorklet.addModule('pitch-worklet.js');
      voice.worklet = true;
    }
  } catch (e) {
    console.warn('audio setup', e);
  }
  applyMute();
  buildSendTrack();
  return true;
}

function releaseAudio() {
  teardownChain();
  if (voice.raw) voice.raw.getTracks().forEach((t) => t.stop());
  if (voice.sendTrack) voice.sendTrack.stop();
  if (voice.ctx) voice.ctx.close().catch(() => {});
  Object.assign(voice, { raw: null, sendTrack: null, sendStream: null, ctx: null, worklet: false, analyser: null, monitor: false });
  setSpeaking(false);
}

function teardownChain() {
  for (const node of voice.chain) {
    try {
      node.disconnect();
      if (node.stop) node.stop();
    } catch {}
  }
  voice.chain = [];
  voice.chainOut = null;
}

function makeImpulse(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  return buf;
}

// 根据当前变声效果生成要发送的音轨
function buildSendTrack() {
  const { ctx } = voice;
  const fx = VOICE_EFFECTS[voice.effect] || VOICE_EFFECTS.none;
  const oldTrack = voice.sendTrack;
  teardownChain();

  let track;
  if (!ctx || !fx.pitch || !voice.worklet) {
    // 原声：直接发送麦克风（克隆一份，静音时不影响本地试听和说话检测）
    track = voice.raw.getAudioTracks()[0].clone();
    if (ctx) {
      const src = ctx.createMediaStreamSource(voice.raw);
      voice.chain.push(src);
      voice.chainOut = src;
    }
  } else {
    const nodes = [];
    const src = ctx.createMediaStreamSource(voice.raw);
    nodes.push(src);
    const pitch = new AudioWorkletNode(ctx, 'pitch-shifter', { parameterData: { pitch: fx.pitch } });
    nodes.push(pitch);
    for (const [type, freq, gain, q] of fx.eq || []) {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      if (gain != null) f.gain.value = gain;
      if (q != null) f.Q.value = q;
      nodes.push(f);
    }
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    let last = nodes[nodes.length - 1];

    if (fx.tremolo) {
      // 快速的音量抖动，模拟声带"咕噜咕噜"的气泡感
      const amp = ctx.createGain();
      amp.gain.value = 1 - fx.tremolo.depth / 2;
      const lfo = ctx.createOscillator();
      lfo.type = 'triangle';
      lfo.frequency.value = fx.tremolo.rate;
      const depth = ctx.createGain();
      depth.gain.value = fx.tremolo.depth / 2;
      lfo.connect(depth).connect(amp.gain);
      lfo.start();
      last.connect(amp);
      nodes.push(amp, lfo, depth);
      last = amp;
    }
    if (fx.reverb) {
      const mix = ctx.createGain();
      const wet = ctx.createGain();
      wet.gain.value = fx.reverb;
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulse(ctx, 0.9);
      last.connect(mix);
      last.connect(conv).connect(wet).connect(mix);
      nodes.push(mix, wet, conv);
      last = mix;
    }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3;
    last.connect(comp);
    const dest = ctx.createMediaStreamDestination();
    comp.connect(dest);
    nodes.push(comp, dest);
    voice.chain = nodes;
    voice.chainOut = comp;
    track = dest.stream.getAudioTracks()[0];
  }

  if (voice.monitor && voice.chainOut) voice.chainOut.connect(ctx.destination);
  track.enabled = !voice.muted;
  voice.sendTrack = track;
  if (!voice.sendStream) voice.sendStream = new MediaStream();
  // 换音轨时不需要重新协商，直接替换
  for (const peer of voice.peers.values()) peer.sender.replaceTrack(track).catch(() => {});
  if (oldTrack) oldTrack.stop();
  return track;
}

async function loadIceServers() {
  try {
    const res = await fetch('/api/ice-servers', { cache: 'no-store' });
    const data = await res.json();
    voice.iceServers = data.iceServers && data.iceServers.length ? data.iceServers : FALLBACK_ICE;
    voice.relay = !!data.relay;
  } catch {
    voice.iceServers = FALLBACK_ICE;
    voice.relay = false;
  }
}

async function joinVoice() {
  if (!(await prepareAudio())) return;
  await loadIceServers();
  const res = await emit('voice:join');
  if (!res.ok) return releaseAudio();
  voice.joined = true;
  for (const peer of res.peers) createPeer(peer.socketId, peer.playerId, true);
  updateVoiceButtons();
  toast(res.peers.length ? `已加入语音，${res.peers.length} 人在线` : '已加入语音，等待其他人加入');
}

function leaveVoice(notify = true) {
  for (const id of [...voice.peers.keys()]) closePeer(id);
  if (voice.joined && notify) emit('voice:leave');
  voice.joined = false;
  releaseAudio();
  voiceSpeaking.clear();
  refreshSpeakingUI();
  updateVoiceButtons();
}

// 调整 Opus 编码参数：开启前向纠错（弱网丢包时补偿）、单声道、提高码率
function tuneOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!m) return sdp;
  const pt = m[1];
  const params = 'useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=40000;maxplaybackrate=48000';
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, (line, existing) => {
      const kept = existing
        .split(';')
        .filter((kv) => kv && !/^(useinbandfec|stereo|sprop-stereo|maxaveragebitrate|maxplaybackrate)=/.test(kv.trim()));
      return `a=fmtp:${pt} ${[...kept, params].join(';')}`;
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${params}`);
}

function createPeer(socketId, playerId, initiator) {
  const pc = new RTCPeerConnection({ iceServers: voice.iceServers });
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.setAttribute('playsinline', '');
  document.body.append(audio);

  const sender = pc.addTrack(voice.sendTrack, voice.sendStream);
  const peer = { pc, playerId, audio, sender, initiator, pending: [], restarts: 0, timer: null, warned: false };
  voice.peers.set(socketId, peer);

  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 40000;
    params.encodings[0].priority = 'high';
    params.encodings[0].networkPriority = 'high';
    sender.setParameters(params).catch(() => {});
  } catch {}

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('voice:signal', { to: socketId, data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    // 加大抖动缓冲，手机网络波动时声音更连贯（多约 0.1 秒延迟）
    try {
      e.receiver.jitterBufferTarget = 150;
    } catch {}
    audio.srcObject = e.streams[0] || new MediaStream([e.track]);
    audio.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    clearTimeout(peer.timer);
    if (st === 'connected') {
      peer.restarts = 0;
      peer.warned = false;
    } else if (st === 'disconnected') {
      // 网络短暂波动，稍等一下还没恢复就重连
      peer.timer = setTimeout(() => pc.connectionState === 'disconnected' && restartPeer(socketId), 3000);
    } else if (st === 'failed') {
      restartPeer(socketId);
    }
  };
  if (initiator) makeOffer(socketId);
  return peer;
}

async function makeOffer(socketId, iceRestart = false) {
  const peer = voice.peers.get(socketId);
  if (!peer) return;
  try {
    const offer = await peer.pc.createOffer({ iceRestart });
    offer.sdp = tuneOpus(offer.sdp);
    await peer.pc.setLocalDescription(offer);
    socket.emit('voice:signal', { to: socketId, data: { sdp: peer.pc.localDescription } });
  } catch (e) {
    console.warn('offer failed', e);
  }
}

// 连接断开/失败时自动重连（由发起方重新协商），多次失败才提示
function restartPeer(socketId) {
  const peer = voice.peers.get(socketId);
  if (!peer || !voice.joined) return;
  peer.restarts++;
  if (peer.restarts <= 3) {
    if (peer.initiator) makeOffer(socketId, true);
    // 非发起方等对方重连，超时再提示
    peer.timer = setTimeout(() => {
      if (peer.pc.connectionState !== 'connected') warnPeer(peer);
    }, 15000);
  } else {
    warnPeer(peer);
  }
}

function warnPeer(peer) {
  if (peer.warned) return;
  peer.warned = true;
  const name = state?.players.find((p) => p.id === peer.playerId)?.name || '对方';
  toast(
    voice.relay
      ? `和 ${name} 的语音连不上，请双方检查网络后点「📴」再重新加入语音`
      : `和 ${name} 的语音连不上：你们的网络无法直连，需要房主给服务器配置语音中转（TURN）`,
    5000
  );
}

function closePeer(socketId) {
  const peer = voice.peers.get(socketId);
  if (!peer) return;
  clearTimeout(peer.timer);
  peer.pc.close();
  peer.audio.remove();
  voiceSpeaking.delete(peer.playerId);
  refreshSpeakingUI();
  voice.peers.delete(socketId);
}

socket.on('voice:signal', async ({ from, playerId, data }) => {
  if (!voice.joined) return;
  const peer = voice.peers.get(from) || createPeer(from, playerId, false);
  const { pc } = peer;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        answer.sdp = tuneOpus(answer.sdp);
        await pc.setLocalDescription(answer);
        socket.emit('voice:signal', { to: from, data: { sdp: pc.localDescription } });
      }
      for (const c of peer.pending) await pc.addIceCandidate(c);
      peer.pending = [];
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else peer.pending.push(data.candidate);
    }
  } catch (e) {
    console.warn('voice signal error', e);
  }
});
socket.on('voice:peer-left', ({ socketId }) => closePeer(socketId));
socket.on('voice:speaking', ({ playerId, speaking }) => {
  speaking ? voiceSpeaking.add(playerId) : voiceSpeaking.delete(playerId);
  refreshSpeakingUI();
});
// 断线后服务器已经把我们移出语音，本地也清理掉
socket.on('disconnect', () => voice.joined && leaveVoice(false));

function refreshSpeakingUI() {
  document.querySelectorAll('.seat[data-pid]').forEach((el) => {
    el.classList.toggle('speaking', voiceSpeaking.has(el.dataset.pid));
  });
}

function setSpeaking(speaking) {
  if (voice.speaking === speaking) return;
  voice.speaking = speaking;
  const me = state?.you?.id;
  if (me) speaking ? voiceSpeaking.add(me) : voiceSpeaking.delete(me);
  refreshSpeakingUI();
  if (voice.joined) socket.emit('voice:speaking', { speaking });
}

// 只检测自己的麦克风音量，说话状态通过服务器同步给别人
setInterval(() => {
  if (!voice.analyser || !voice.joined) return setSpeaking(false);
  voice.analyser.getByteTimeDomainData(voice.analyserData);
  let sum = 0;
  for (const x of voice.analyserData) sum += (x - 128) * (x - 128);
  const rms = Math.sqrt(sum / voice.analyserData.length);
  const now = Date.now();
  if (rms > 5 && !voice.muted) voice.lastLoud = now;
  setSpeaking(now - voice.lastLoud < 400);
}, 120);

function applyMute() {
  if (voice.sendTrack) voice.sendTrack.enabled = !voice.muted;
}

function updateVoiceButtons() {
  $('voiceBtn').innerHTML = voice.joined ? '📴<span class="lbl"> 退出语音</span>' : '🎤<span class="lbl"> 语音</span>';
  $('voiceBtn').classList.toggle('active', voice.joined);
  $('muteBtn').classList.toggle('hidden', !voice.joined);
  $('muteBtn').textContent = voice.muted ? '🔇 已静音' : '🎙 静音';
  const fx = VOICE_EFFECTS[voice.effect];
  $('effectBtn').textContent = voice.effect === 'none' ? '🎭 变声' : `🎭 ${fx.name}`;
  $('effectBtn').classList.toggle('active', voice.effect !== 'none');
}

$('voiceBtn').onclick = () => (voice.joined ? leaveVoice() : joinVoice());
$('muteBtn').onclick = () => {
  voice.muted = !voice.muted;
  applyMute();
  emit('voice:mute', { muted: voice.muted });
  updateVoiceButtons();
};

// ---------- 变声器面板 ----------

function renderEffects() {
  const list = $('effectList');
  list.innerHTML = '';
  for (const [key, fx] of Object.entries(VOICE_EFFECTS)) {
    const btn = document.createElement('button');
    btn.className = 'effect-item' + (voice.effect === key ? ' active' : '');
    btn.innerHTML = '<b></b><small></small>';
    btn.querySelector('b').textContent = fx.name;
    btn.querySelector('small').textContent = fx.desc;
    btn.onclick = () => setEffect(key);
    list.append(btn);
  }
  $('monitorBtn').textContent = voice.monitor ? '⏹ 停止试听' : '🎧 试听自己的声音（请戴耳机）';
  $('monitorBtn').classList.toggle('active', voice.monitor);
}

function setEffect(key) {
  voice.effect = key;
  try {
    localStorage.setItem(EFFECT_KEY, key);
  } catch {}
  if (voice.raw) buildSendTrack();
  renderEffects();
  updateVoiceButtons();
  if (voice.effect !== 'none' && voice.raw && !voice.worklet) toast('当前浏览器不支持变声，请换用 Safari 或 Chrome');
}

async function setMonitor(on) {
  if (on && !(await prepareAudio())) return;
  voice.monitor = on;
  if (voice.chainOut && voice.ctx) {
    try {
      if (on) voice.chainOut.connect(voice.ctx.destination);
      else voice.chainOut.disconnect(voice.ctx.destination);
    } catch {}
  }
  renderEffects();
}

function closeEffects() {
  $('effectModal').classList.add('hidden');
  if (voice.monitor) setMonitor(false);
  // 只是试听、没有加入语音的话，关掉麦克风
  if (!voice.joined) releaseAudio();
}

$('effectBtn').onclick = () => {
  renderEffects();
  $('effectModal').classList.remove('hidden');
};
$('monitorBtn').onclick = () => setMonitor(!voice.monitor);
$('effectClose').onclick = closeEffects;
$('effectModal').onclick = (e) => e.target.id === 'effectModal' && closeEffects();
updateVoiceButtons();
