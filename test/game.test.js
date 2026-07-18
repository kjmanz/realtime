'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server, rooms, maxMinorities } = require('../server');

let baseUrl;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

async function action(code, player, name, payload = {}) {
  return post(`/api/rooms/${code}/action`, {
    playerId: player.playerId,
    token: player.token,
    action: name,
    payload
  });
}

test('参加人数から少数派の上限を決める', () => {
  assert.equal(maxMinorities(3), 1);
  assert.equal(maxMinorities(5), 1);
  assert.equal(maxMinorities(6), 2);
  assert.equal(maxMinorities(8), 2);
  assert.equal(maxMinorities(9), 3);
  assert.equal(maxMinorities(10), 3);
  assert.equal(maxMinorities(12), 3);
  assert.equal(maxMinorities(13), 4);
  assert.equal(maxMinorities(16), 4);
  assert.equal(maxMinorities(17), 5);
  assert.equal(maxMinorities(20), 5);
});

test('3人が部屋作成から次のラウンドまで進める', async () => {
  const host = await post('/api/rooms', { name: 'はる' });
  const code = host.code;
  const guest1 = await post('/api/rooms/join', { code, name: 'なつ' });
  const guest2 = await post('/api/rooms/join', { code, name: 'あき' });
  const players = [host, guest1, guest2];
  const room = rooms.get(code);

  assert.equal(room.players.length, 3);
  assert.equal(room.phase, 'lobby');

  await action(code, host, 'start_round');
  assert.equal(room.phase, 'topic');
  assert.equal(room.round.minorityIds.length, 1);
  assert.equal(room.round.questions.length, 3);

  for (const player of players) await action(code, player, 'ready');
  assert.ok(room.players.every((player) => player.ready));

  await action(code, host, 'start_talk');
  await action(code, host, 'next_question');
  await action(code, host, 'next_question');
  assert.equal(room.phase, 'talk');
  assert.equal(room.round.questionIndex, 2);

  await action(code, host, 'start_vote');
  assert.equal(room.phase, 'vote');
  const suspectedId = room.round.minorityIds[0];
  for (const player of players) await action(code, player, 'submit_vote', { ids: [suspectedId] });
  assert.ok(room.players.every((player) => player.submitted));

  await action(code, host, 'reveal_results');
  assert.equal(room.phase, 'results');

  const previousPair = `${room.round.majorityTopic}|${room.round.minorityTopic}`;
  await action(code, host, 'start_round');
  assert.equal(room.phase, 'topic');
  assert.equal(room.roundNumber, 2);
  assert.notEqual(`${room.round.majorityTopic}|${room.round.minorityTopic}`, previousPair);
});

test('少数派人数と違う人数は選択できない', async () => {
  const host = await post('/api/rooms', { name: '進行さん' });
  const code = host.code;
  const guest1 = await post('/api/rooms/join', { code, name: '参加いち' });
  const guest2 = await post('/api/rooms/join', { code, name: '参加に' });
  await action(code, host, 'start_round');
  await action(code, host, 'ready');
  await action(code, guest1, 'ready');
  await action(code, guest2, 'ready');
  await action(code, host, 'start_talk');
  await action(code, host, 'start_vote');

  await assert.rejects(
    action(code, guest1, 'submit_vote', { ids: [] }),
    /1人選んでください/
  );
  await action(code, guest2, 'submit_vote', { ids: [rooms.get(code).players[0].id] });
  assert.equal(rooms.get(code).players.find((player) => player.id === guest2.playerId).submitted, true);
  await action(code, guest2, 'reopen_vote');
  assert.equal(rooms.get(code).players.find((player) => player.id === guest2.playerId).submitted, false);
  assert.deepEqual(rooms.get(code).players.find((player) => player.id === guest2.playerId).votes, []);
  await action(code, guest2, 'submit_vote', { ids: [rooms.get(code).players[1].id] });
});

test('同じ名前で席に戻り、途中参加者は次のラウンドから遊べる', async () => {
  const host = await post('/api/rooms', { name: 'ホスト' });
  const code = host.code;
  const guest1 = await post('/api/rooms/join', { code, name: 'ゲスト一' });
  const guest2 = await post('/api/rooms/join', { code, name: 'ゲスト二' });
  const room = rooms.get(code);

  await action(code, host, 'start_round');
  const firstRoundIds = [...room.round.activePlayerIds];

  const latePlayer = await post('/api/rooms/join', { code, name: '途中参加' });
  assert.equal(latePlayer.waiting, true);
  assert.equal(room.players.find((player) => player.id === latePlayer.playerId).waiting, true);
  assert.deepEqual(room.round.activePlayerIds, firstRoundIds);

  const resumedHost = await post('/api/rooms/join', { code, name: 'ホスト' });
  assert.equal(resumedHost.resumed, true);
  assert.equal(resumedHost.playerId, host.playerId);
  assert.notEqual(resumedHost.token, host.token);

  const activePlayers = [resumedHost, guest1, guest2];
  for (const player of activePlayers) await action(code, player, 'ready');
  await action(code, resumedHost, 'start_talk');
  await action(code, resumedHost, 'start_vote');

  const suspectedId = room.round.minorityIds[0];
  for (const player of activePlayers) {
    await action(code, player, 'submit_vote', { ids: [suspectedId] });
  }
  await action(code, resumedHost, 'reveal_results');
  assert.equal(room.phase, 'results');

  await action(code, resumedHost, 'start_round');
  assert.equal(room.phase, 'topic');
  assert.equal(room.players.find((player) => player.id === latePlayer.playerId).waiting, false);
  assert.ok(room.round.activePlayerIds.includes(latePlayer.playerId));
});

test('質問は3問で始まり、最後の質問から最大10問まで追加できる', async () => {
  const host = await post('/api/rooms', { name: '質問係' });
  const code = host.code;
  const guest1 = await post('/api/rooms/join', { code, name: '回答一' });
  const guest2 = await post('/api/rooms/join', { code, name: '回答二' });
  const room = rooms.get(code);

  await action(code, host, 'start_round');
  assert.equal(room.round.questions.length, 3);

  for (const player of [host, guest1, guest2]) await action(code, player, 'ready');
  await action(code, host, 'start_talk');
  await assert.rejects(action(code, host, 'add_question'), /最後の質問/);
  await action(code, host, 'next_question');
  await action(code, host, 'next_question');
  for (let index = 0; index < 7; index += 1) {
    await action(code, host, 'add_question');
    assert.equal(room.round.questionIndex, room.round.questions.length - 1);
  }

  assert.equal(room.round.questions.length, 10);
  assert.equal(room.round.questionIndex, 9);
  assert.equal(new Set(room.round.questions).size, 10);
  await assert.rejects(action(code, host, 'add_question'), /最大10問/);

  room.phase = 'results';
  await action(code, host, 'start_round');
  assert.equal(room.round.questions.length, 3);
});

test('1部屋に20人まで参加できる', async () => {
  const host = await post('/api/rooms', { name: '二十人係' });
  const code = host.code;
  for (let index = 1; index < 20; index += 1) {
    await post('/api/rooms/join', { code, name: `参加${String(index).padStart(2, '0')}` });
  }
  assert.equal(rooms.get(code).players.length, 20);
  await assert.rejects(post('/api/rooms/join', { code, name: '二十一人目' }), /満員/);
});

test('退出すると参加者から外れ、進行役を引き継ぎ、最後なら部屋を閉じる', async () => {
  const host = await post('/api/rooms', { name: '退出進行' });
  const code = host.code;
  const guest1 = await post('/api/rooms/join', { code, name: '引継一' });
  const guest2 = await post('/api/rooms/join', { code, name: '引継二' });
  const room = rooms.get(code);

  await action(code, host, 'start_round');
  await action(code, host, 'leave_room');
  assert.equal(room.players.length, 2);
  assert.equal(room.players.some((player) => player.id === host.playerId), false);
  assert.equal(room.round.activePlayerIds.includes(host.playerId), false);
  assert.equal(room.players.find((player) => player.id === guest1.playerId).isHost, true);

  await action(code, guest1, 'leave_room');
  assert.equal(room.players.find((player) => player.id === guest2.playerId).isHost, true);
  await action(code, guest2, 'leave_room');
  assert.equal(rooms.has(code), false);
});

test('ファビコンとシェア画像を正しい形式で配信する', async () => {
  const page = await fetch(`${baseUrl}/`);
  const html = await page.text();
  assert.match(html, /rel="icon"[^>]+kotoba-no-mori-icon\.png/);
  assert.match(html, /property="og:image"[^>]+kotoba-no-mori-share\.png/);

  const icon = await fetch(`${baseUrl}/assets/kotoba-no-mori-icon.png`);
  const share = await fetch(`${baseUrl}/assets/kotoba-no-mori-share.png`);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.equal(share.headers.get('content-type'), 'image/png');
  assert.ok(Number(icon.headers.get('content-length') || 0) > 0 || (await icon.arrayBuffer()).byteLength > 0);
  assert.ok(Number(share.headers.get('content-length') || 0) > 0 || (await share.arrayBuffer()).byteLength > 0);
});
