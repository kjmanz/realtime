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
});
