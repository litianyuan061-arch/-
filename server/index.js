'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Table, GameError } = require('./table');

const PORT = process.env.PORT || 3000;
const TURN_SECONDS = Number(process.env.TURN_SECONDS || 30);
const NEXT_HAND_SECONDS = Number(process.env.NEXT_HAND_SECONDS || 6);
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server);

/** code -> { code, table, started, turnTimer, turnDeadline, nextHandTimer, nextHandAt, emptySince } */
const rooms = new Map();

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 0/O、1/I
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanName(name) {
  const s = String(name || '').trim().slice(0, 12);
  return s || '玩家' + crypto.randomInt(100, 1000);
}

// 给房间里的每个人推送各自视角的状态（只看得到自己的底牌）
function broadcast(room) {
  const sockets = io.sockets.adapter.rooms.get(room.code) || new Set();
  for (const sid of sockets) {
    const socket = io.sockets.sockets.get(sid);
    if (!socket) continue;
    const state = room.table.getState(socket.data.playerId);
    state.roomCode = room.code;
    state.started = room.started;
    // 发送剩余毫秒数而不是绝对时间，避免客户端时钟不准
    const now = Date.now();
    state.turnMsLeft = room.turnDeadline ? Math.max(0, room.turnDeadline - now) : null;
    state.turnMsTotal = room.turnDuration || null;
    state.nextHandMsLeft = room.nextHandAt ? Math.max(0, room.nextHandAt - now) : null;
    socket.emit('state', state);
  }
}

// 每次状态变化后调用：处理行动计时器和自动开下一手
function schedule(room) {
  const { table } = room;
  clearTimeout(room.turnTimer);
  room.turnDeadline = null;

  const actor = table.toActPlayer();
  if (actor) {
    const seq = table.seq;
    const seconds = actor.connected ? TURN_SECONDS : Math.min(TURN_SECONDS, 5);
    room.turnDeadline = Date.now() + seconds * 1000;
    room.turnDuration = seconds * 1000;
    room.turnTimer = setTimeout(() => {
      if (table.seq !== seq) return;
      try {
        table.autoAct(actor.id);
      } catch (e) {
        console.error('autoAct failed', e);
      }
      schedule(room);
    }, seconds * 1000);
  }

  if (table.stage === 'showdown' && room.started && !room.nextHandTimer) {
    room.nextHandAt = Date.now() + NEXT_HAND_SECONDS * 1000;
    room.nextHandTimer = setTimeout(() => {
      room.nextHandTimer = null;
      room.nextHandAt = null;
      if (table.canStartHand()) {
        table.startHand();
      } else {
        room.started = false; // 人不够了，等房主重新开始
      }
      schedule(room);
    }, NEXT_HAND_SECONDS * 1000);
  }

  broadcast(room);
}

function getRoom(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) throw new GameError('房间不存在');
  return room;
}

function joinSocketToRoom(socket, room, playerId) {
  socket.data.roomCode = room.code;
  socket.data.playerId = playerId;
  socket.join(room.code);
  room.emptySince = null;
}

io.on('connection', (socket) => {
  // 统一的错误处理：回调里返回 { error }
  const handle = (event, fn) => {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        reply(fn(payload || {}) || { ok: true });
      } catch (e) {
        if (!(e instanceof GameError)) console.error(e);
        reply({ error: e instanceof GameError ? e.message : '服务器错误' });
      }
    });
  };

  handle('createRoom', ({ name, settings = {} }) => {
    const bigBlind = clampInt(settings.bigBlind, 2, 100000, 20);
    const table = new Table({
      bigBlind,
      smallBlind: Math.max(1, Math.floor(bigBlind / 2)),
      startingChips: clampInt(settings.startingChips, bigBlind * 10, 10000000, 1000),
      maxSeats: clampInt(settings.maxSeats, 2, 9, 9),
    });
    const code = makeRoomCode();
    const room = { code, table, started: false, emptySince: null };
    rooms.set(code, room);
    const playerId = crypto.randomUUID();
    table.addPlayer(playerId, cleanName(name));
    joinSocketToRoom(socket, room, playerId);
    schedule(room);
    return { ok: true, code, playerId };
  });

  handle('joinRoom', ({ code, name, playerId }) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) throw new GameError('房间不存在或已解散');
    const { table } = room;
    // 断线重连：用之前保存的 playerId 找回座位
    if (playerId && table.players.has(playerId)) {
      table.setConnected(playerId, true);
    } else {
      playerId = crypto.randomUUID();
      table.addPlayer(playerId, cleanName(name));
    }
    joinSocketToRoom(socket, room, playerId);
    schedule(room);
    return { ok: true, code: room.code, playerId };
  });

  handle('startGame', () => {
    const room = getRoom(socket);
    if (room.table.hostId !== socket.data.playerId) throw new GameError('只有房主可以开始游戏');
    room.table.startHand();
    room.started = true;
    schedule(room);
  });

  handle('action', ({ type, amount }) => {
    const room = getRoom(socket);
    room.table.act(socket.data.playerId, type, amount);
    schedule(room);
  });

  handle('rebuy', () => {
    const room = getRoom(socket);
    room.table.rebuy(socket.data.playerId);
    schedule(room);
  });

  handle('chat', ({ text }) => {
    const room = getRoom(socket);
    const p = room.table.players.get(socket.data.playerId);
    const msg = String(text || '').trim().slice(0, 200);
    if (!p || !msg) return;
    io.to(room.code).emit('chat', { name: p.name, text: msg, t: Date.now() });
  });

  handle('leaveRoom', () => {
    const room = getRoom(socket);
    room.table.removePlayer(socket.data.playerId);
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    schedule(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    room.table.setConnected(socket.data.playerId, false);
    if (!io.sockets.adapter.rooms.get(room.code)?.size) room.emptySince = Date.now();
    schedule(room);
  });
});

// 定期清理长时间没人的房间
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.emptySince && Date.now() - room.emptySince > EMPTY_ROOM_TTL_MS) {
      clearTimeout(room.turnTimer);
      clearTimeout(room.nextHandTimer);
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`德州扑克服务器已启动: http://localhost:${PORT}`);
});

module.exports = { server, io, rooms };
