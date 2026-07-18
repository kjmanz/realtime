'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TOPIC_PAIRS, CATEGORY_QUESTIONS } = require('./topics');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const rooms = new Map();

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function createRoomCode() {
  for (let i = 0; i < 10000; i += 1) {
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!rooms.has(code)) return code;
  }
  throw new Error('空いている部屋コードがありません');
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 10);
}

function normalizeDeviceId(value) {
  const id = String(value || '').trim().slice(0, 80);
  return /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : '';
}

function createPlayer(name, isHost = false, deviceId = '') {
  return {
    id: randomId(8), token: randomId(18), name, isHost, deviceId,
    ready: false, submitted: false, votes: [], minorityCount: 0, waiting: false
  };
}

function activePlayers(room) {
  if (!room.round) return room.players;
  return room.players.filter((player) => room.round.activePlayerIds.includes(player.id));
}

function roomPublicState(room, viewer) {
  const round = room.round;
  const isResults = room.phase === 'results';
  const isWaiting = Boolean(viewer.waiting && round && !round.activePlayerIds.includes(viewer.id));
  const ownTopic = round && !isWaiting && ['topic', 'talk', 'vote', 'results'].includes(room.phase)
    ? (round.minorityIds.includes(viewer.id) ? round.minorityTopic : round.majorityTopic)
    : null;

  return {
    code: room.code,
    phase: isWaiting ? 'waiting' : room.phase,
    roomPhase: room.phase,
    roundNumber: room.roundNumber,
    viewerId: viewer.id,
    isHost: viewer.isHost,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      isHost: player.isHost,
      ready: player.ready,
      submitted: player.submitted,
      waiting: player.waiting,
      active: !round || round.activePlayerIds.includes(player.id)
    })),
    ownTopic,
    category: round ? round.category : null,
    question: round && room.phase === 'talk' ? round.questions[round.questionIndex] : null,
    questionIndex: round ? round.questionIndex : 0,
    questionTotal: round ? round.questions.length : 0,
    minorityTotal: round && !isWaiting && ['vote', 'results'].includes(room.phase) ? round.minorityIds.length : null,
    ownVotes: round && room.phase === 'vote' && !isWaiting ? viewer.votes : [],
    results: isResults && !isWaiting ? buildResults(room) : null,
    createdAt: room.createdAt
  };
}

function buildResults(room) {
  const roundPlayers = activePlayers(room);
  const tally = Object.fromEntries(roundPlayers.map((player) => [player.id, 0]));
  for (const player of roundPlayers) {
    for (const votedId of player.votes) {
      if (Object.hasOwn(tally, votedId)) tally[votedId] += 1;
    }
  }
  return {
    majorityTopic: room.round.majorityTopic,
    minorityTopic: room.round.minorityTopic,
    minorityIds: room.round.minorityIds,
    tally,
    submittedCount: roundPlayers.filter((player) => player.submitted).length
  };
}

function sendEvent(room) {
  room.updatedAt = Date.now();
  for (const client of room.clients) {
    const viewer = room.players.find((player) => player.id === client.playerId);
    if (!viewer) continue;
    client.res.write(`event: state\ndata: ${JSON.stringify(roomPublicState(room, viewer))}\n\n`);
  }
}

function removePlayer(room, player) {
  for (const client of [...room.clients]) {
    if (client.playerId === player.id) {
      client.res.end();
      room.clients.delete(client);
    }
  }

  room.players = room.players.filter((candidate) => candidate.id !== player.id);
  if (!room.players.length) {
    rooms.delete(room.code);
    return true;
  }

  if (room.round) {
    room.round.activePlayerIds = room.round.activePlayerIds.filter((id) => id !== player.id);
    room.round.minorityIds = room.round.minorityIds.filter((id) => id !== player.id);
    room.lastMinorityIds = room.lastMinorityIds.filter((id) => id !== player.id);
    for (const candidate of room.players) candidate.votes = candidate.votes.filter((id) => id !== player.id);

    if (!room.round.activePlayerIds.length) {
      room.phase = 'lobby';
      room.round = null;
      for (const candidate of room.players) {
        candidate.waiting = false;
        candidate.ready = false;
        candidate.submitted = false;
        candidate.votes = [];
      }
    } else if (room.phase === 'vote') {
      for (const candidate of activePlayers(room)) {
        candidate.submitted = false;
        candidate.votes = [];
      }
    }
  }

  if (player.isHost) {
    const nextHost = activePlayers(room)[0] || room.players[0];
    nextHost.isHost = true;
  }
  sendEvent(room);
  return false;
}

function maxMinorities(playerCount) {
  if (playerCount <= 5) return 1;
  if (playerCount <= 8) return 2;
  if (playerCount <= 12) return 3;
  if (playerCount <= 16) return 4;
  return 5;
}

function chooseMinorityTotal(playerCount) {
  const max = maxMinorities(playerCount);
  const weights = [0.34, 0.27, 0.2, 0.12, 0.07].slice(0, max);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return i + 1;
  }
  return max;
}

function selectMinorityPlayers(room, count) {
  return [...room.players]
    .map((player) => ({
      player,
      score: player.minorityCount * 2 + (room.lastMinorityIds.includes(player.id) ? 3 : 0) + Math.random()
    }))
    .sort((left, right) => left.score - right.score)
    .slice(0, count)
    .map(({ player }) => player);
}

function selectTopicPair(room) {
  let candidates = TOPIC_PAIRS.filter((pair) => !room.recentPairKeys.includes(`${pair.a}|${pair.b}`));
  const withoutLastCategory = candidates.filter((pair) => pair.category !== room.lastCategory);
  if (withoutLastCategory.length) candidates = withoutLastCategory;
  const pair = candidates[crypto.randomInt(candidates.length)];
  const key = `${pair.a}|${pair.b}`;
  room.recentPairKeys = [key, ...room.recentPairKeys.filter((item) => item !== key)].slice(0, 12);
  room.lastCategory = pair.category;
  return pair;
}

function pickQuestions(pair, count = 3) {
  const pool = [...pair.questions, ...(CATEGORY_QUESTIONS[pair.category] || [])];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool.slice(0, count);
}

function prepareRound(room) {
  for (const player of room.players) player.waiting = false;
  const pair = selectTopicPair(room);
  const swap = crypto.randomInt(2) === 1;
  const minorityTotal = chooseMinorityTotal(room.players.length);
  const minorityPlayers = selectMinorityPlayers(room, minorityTotal);
  for (const player of room.players) {
    player.ready = false;
    player.submitted = false;
    player.votes = [];
  }
  for (const player of minorityPlayers) player.minorityCount += 1;
  room.lastMinorityIds = minorityPlayers.map((player) => player.id);
  room.roundNumber += 1;
  const questionPool = pickQuestions(pair, 10);
  room.round = {
    category: pair.category,
    majorityTopic: swap ? pair.b : pair.a,
    minorityTopic: swap ? pair.a : pair.b,
    minorityIds: room.lastMinorityIds,
    activePlayerIds: room.players.map((player) => player.id),
    questionPool,
    questions: questionPool.slice(0, 3),
    questionIndex: 0
  };
  room.phase = 'topic';
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function authenticate(room, playerId, token) {
  return room.players.find((player) => player.id === playerId && player.token === token);
}

function requireHost(player) {
  if (!player.isHost) throw Object.assign(new Error('進行役だけが操作できます'), { status: 403 });
}

function handleAction(room, player, action, payload) {
  switch (action) {
    case 'start_round':
      requireHost(player);
      if (!['lobby', 'results'].includes(room.phase)) throw new Error('今はラウンドを開始できません');
      if (room.players.length < 3) throw new Error('3人以上集まると開始できます');
      prepareRound(room);
      break;
    case 'ready':
      if (room.phase !== 'topic') throw new Error('今は準備確認できません');
      if (player.waiting) throw new Error('次のラウンドから参加できます');
      player.ready = true;
      break;
    case 'start_talk':
      requireHost(player);
      if (room.phase !== 'topic') throw new Error('今は会話を開始できません');
      if (!activePlayers(room).every((candidate) => candidate.ready)) throw new Error('全員のお題確認を待っています');
      room.phase = 'talk';
      break;
    case 'next_question':
      requireHost(player);
      if (room.phase !== 'talk') throw new Error('今は質問を進められません');
      if (room.round.questionIndex >= room.round.questions.length - 1) throw new Error('最後の質問です');
      room.round.questionIndex += 1;
      break;
    case 'add_question':
      requireHost(player);
      if (room.phase !== 'talk') throw new Error('会話中に追加してください');
      if (room.round.questionIndex !== room.round.questions.length - 1) throw new Error('最後の質問まで進んでから追加してください');
      if (room.round.questions.length >= 10) throw new Error('質問は最大10問です');
      room.round.questions.push(room.round.questionPool[room.round.questions.length]);
      room.round.questionIndex += 1;
      break;
    case 'start_vote':
      requireHost(player);
      if (room.phase !== 'talk') throw new Error('今は予想タイムへ進めません');
      room.phase = 'vote';
      break;
    case 'reopen_vote':
      if (room.phase !== 'vote') throw new Error('今は選び直せません');
      if (player.waiting) throw new Error('次のラウンドから参加できます');
      player.votes = [];
      player.submitted = false;
      break;
    case 'submit_vote': {
      if (room.phase !== 'vote') throw new Error('今は予想できません');
      if (player.waiting) throw new Error('次のラウンドから参加できます');
      const ids = Array.isArray(payload.ids) ? [...new Set(payload.ids)] : [];
      if (ids.length !== room.round.minorityIds.length) throw new Error(`${room.round.minorityIds.length}人選んでください`);
      if (ids.some((id) => !room.round.activePlayerIds.includes(id))) throw new Error('参加者を選び直してください');
      player.votes = ids;
      player.submitted = true;
      break;
    }
    case 'reveal_results':
      requireHost(player);
      if (room.phase !== 'vote') throw new Error('今は結果を発表できません');
      if (!activePlayers(room).every((candidate) => candidate.submitted)) throw new Error('全員の予想を待っています');
      room.phase = 'results';
      break;
    case 'end_room':
      requireHost(player);
      room.phase = 'ended';
      break;
    default:
      throw new Error('不明な操作です');
  }
  sendEvent(room);
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    json(res, 403, { error: 'Forbidden' });
    return;
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg'
  };
  fs.readFile(filePath, (error, data) => {
    if (error) { json(res, 404, { error: 'Not found' }); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (req.method === 'POST' && pathname === '/api/rooms') {
      const body = await readJson(req);
      const name = normalizeName(body.name);
      const deviceId = normalizeDeviceId(body.deviceId);
      if (name.length < 2) return json(res, 400, { error: 'ニックネームを2文字以上で入力してください' });
      const code = createRoomCode();
      const host = createPlayer(name, true, deviceId);
      const room = {
        code, players: [host], clients: new Set(), phase: 'lobby', round: null,
        roundNumber: 0, recentPairKeys: [], lastCategory: null, lastMinorityIds: [],
        createdAt: Date.now(), updatedAt: Date.now()
      };
      rooms.set(code, room);
      return json(res, 201, { code, playerId: host.id, token: host.token, name: host.name });
    }

    if (req.method === 'POST' && pathname === '/api/rooms/join') {
      const body = await readJson(req);
      const code = String(body.code || '').replace(/\D/g, '').slice(0, 4);
      const name = normalizeName(body.name);
      const deviceId = normalizeDeviceId(body.deviceId);
      const room = rooms.get(code);
      if (!room || room.phase === 'ended') return json(res, 404, { error: '部屋が見つかりません' });
      if (name.length < 2) return json(res, 400, { error: 'ニックネームを2文字以上で入力してください' });
      const existingByDevice = deviceId && room.players.find((player) => player.deviceId === deviceId);
      const existing = existingByDevice || room.players.find((player) => player.name === name);
      if (existing) {
        if (deviceId) existing.deviceId = deviceId;
        if (existingByDevice && existing.name !== name && !room.players.some((player) => player !== existing && player.name === name)) {
          existing.name = name;
        }
        for (const client of [...room.clients]) {
          if (client.playerId === existing.id) {
            client.res.end();
            room.clients.delete(client);
          }
        }
        existing.token = randomId(18);
        sendEvent(room);
        return json(res, 200, { code, playerId: existing.id, token: existing.token, name: existing.name, resumed: true });
      }
      if (room.players.length >= 20) return json(res, 409, { error: 'この部屋は満員です' });
      const player = createPlayer(name, false, deviceId);
      player.waiting = room.phase !== 'lobby';
      room.players.push(player);
      sendEvent(room);
      return json(res, 201, { code, playerId: player.id, token: player.token, name: player.name, waiting: player.waiting });
    }

    const eventsMatch = pathname.match(/^\/api\/rooms\/(\d{4})\/events$/);
    if (req.method === 'GET' && eventsMatch) {
      const room = rooms.get(eventsMatch[1]);
      const player = room && authenticate(room, url.searchParams.get('playerId'), url.searchParams.get('token'));
      if (!room || !player) return json(res, 401, { error: '参加情報が確認できません' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      res.write(`event: state\ndata: ${JSON.stringify(roomPublicState(room, player))}\n\n`);
      const client = { playerId: player.id, res };
      room.clients.add(client);
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(keepAlive); room.clients.delete(client); });
      return;
    }

    const actionMatch = pathname.match(/^\/api\/rooms\/(\d{4})\/action$/);
    if (req.method === 'POST' && actionMatch) {
      const room = rooms.get(actionMatch[1]);
      const body = await readJson(req);
      const player = room && authenticate(room, body.playerId, body.token);
      if (!room || !player) return json(res, 401, { error: '参加情報が確認できません' });
      if (body.action === 'leave_room') {
        const roomClosed = removePlayer(room, player);
        return json(res, 200, { ok: true, roomClosed });
      }
      handleAction(room, player, body.action, body.payload || {});
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    return json(res, error.status || 400, { error: error.message || '操作に失敗しました' });
  }
});

setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.updatedAt < cutoff) {
      for (const client of room.clients) client.res.end();
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`ほのぼのちがいを http://localhost:${PORT} で起動しました`);
  });
}

module.exports = { server, rooms, maxMinorities, chooseMinorityTotal };
