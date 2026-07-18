'use strict';

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const roomBadge = document.querySelector('#roomBadge');
const leaveRoomButton = document.querySelector('#leaveRoomButton');
const brandButton = document.querySelector('#brandButton');
const SESSION_KEY = 'kotobanomori-session';
const NAME_KEY = 'kotobanomori-nickname';
const DEVICE_KEY = 'kotobanomori-device-id';

function loadDeviceId() {
  let value = localStorage.getItem(DEVICE_KEY);
  if (!value) {
    value = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, value);
  }
  return value;
}

let session = loadSession();
const deviceId = loadDeviceId();
let state = null;
let eventSource = null;
let topicRevealedRound = null;
let selectedVotes = new Set();
let toastTimer = null;
let reconnectTimer = null;
let recovering = false;

const avatars = ['🌿', '🍀', '🌼', '🌙', '🍎', '🐿️', '🌈', '⭐', '🍊', '🪴'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}

function saveSession(value) {
  session = value;
  if (value) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    if (value.name) localStorage.setItem(NAME_KEY, value.name);
  }
  else localStorage.removeItem(SESSION_KEY);
}

function savedNickname() {
  return session?.name || localStorage.getItem(NAME_KEY) || '';
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '通信に失敗しました');
    error.status = response.status;
    throw error;
  }
  return data;
}

function disconnect() {
  if (eventSource) eventSource.close();
  eventSource = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (!session || reconnectTimer || recovering) return;
  showToast('部屋へ再接続しています…');
  reconnectTimer = setTimeout(recoverSession, 1500);
}

async function recoverSession() {
  reconnectTimer = null;
  if (!session || recovering) return;
  recovering = true;
  try {
    const name = savedNickname();
    if (!name) throw Object.assign(new Error('ニックネームを入力して部屋へ戻ってください'), { status: 401 });
    const data = await request('/api/rooms/join', {
      method: 'POST',
      body: JSON.stringify({ code: session.code, name, deviceId })
    });
    saveSession({ ...data, name });
    recovering = false;
    connect();
  } catch (error) {
    recovering = false;
    if (error.status === 404) {
      const oldCode = session?.code || '';
      saveSession(null);
      state = null;
      renderLanding(`部屋 ${oldCode} は終了しました。新しい部屋へ参加してください。`);
    } else if (error.status === 401 || error.status === 409) {
      saveSession(null);
      state = null;
      renderLanding(error.message);
    } else {
      scheduleReconnect();
    }
  }
}

function connect() {
  disconnect();
  if (!session) return renderLanding();
  const query = new URLSearchParams({ playerId: session.playerId, token: session.token });
  eventSource = new EventSource(`/api/rooms/${session.code}/events?${query}`);
  eventSource.addEventListener('state', (event) => {
    const next = JSON.parse(event.data);
    if (!state || next.roundNumber !== state.roundNumber || next.phase !== state.phase
      || next.players.length !== state.players.length || next.minorityTotal !== state.minorityTotal) selectedVotes = new Set();
    state = next;
    const me = next.players.find((player) => player.id === next.viewerId);
    if (me && session && session.name !== me.name) saveSession({ ...session, name: me.name });
    render();
  });
  eventSource.onerror = () => {
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      eventSource = null;
      scheduleReconnect();
    }
  };
}

async function sendAction(action, payload = {}) {
  if (!session) return;
  try {
    await request(`/api/rooms/${session.code}/action`, {
      method: 'POST',
      body: JSON.stringify({ playerId: session.playerId, token: session.token, action, payload })
    });
  } catch (error) { showToast(error.message); }
}

function setRoomBadge(code) {
  roomBadge.textContent = code ? `部屋 ${code}` : '';
  roomBadge.classList.toggle('hidden', !code);
  leaveRoomButton.classList.toggle('hidden', !code);
}

function renderLanding(message = '') {
  setRoomBadge(null);
  app.innerHTML = `
    <section class="hero">
      <p class="eyebrow">3〜20人で遊べる会話ゲーム</p>
      <h1>同じことば？<br>ちがうことば？</h1>
      <p class="lead">みんなのお題は、ほとんど同じ。自由に話して、少しだけ違うお題の人を見つけよう。</p>
    </section>
    <section class="card stack">
      ${message ? `<p class="fine-print">${escapeHtml(message)}</p>` : ''}
      <form id="landingForm" class="stack">
        <label class="label">あなたのニックネーム
          <input class="input" name="name" minlength="2" maxlength="10" autocomplete="nickname" placeholder="例：みどり" value="${escapeHtml(savedNickname())}" required>
        </label>
        <button class="button" id="createRoom" type="button">部屋をつくる</button>
        <div class="divider">または</div>
        <label class="label">4桁の部屋コード
          <input class="input code-input" name="code" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="0000" required>
        </label>
        <button class="button secondary" type="submit">部屋に入る</button>
      </form>
    </section>`;

  const landingForm = document.querySelector('#landingForm');
  const nicknameInput = landingForm.querySelector('input[name="name"]');
  const createButton = document.querySelector('#createRoom');
  const joinButton = landingForm.querySelector('button[type="submit"]');
  const setPending = (pending) => {
    createButton.disabled = pending;
    joinButton.disabled = pending;
  };

  createButton.addEventListener('click', async () => {
    if (!nicknameInput.reportValidity()) return;
    setPending(true);
    try {
      const name = nicknameInput.value;
      const data = await request('/api/rooms', { method: 'POST', body: JSON.stringify({ name, deviceId }) });
      saveSession(data);
      connect();
    } catch (error) { showToast(error.message); setPending(false); }
  });

  const codeInput = landingForm.querySelector('input[name="code"]');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 4); });
  landingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setPending(true);
    try {
      const form = new FormData(event.currentTarget);
      const data = await request('/api/rooms/join', {
        method: 'POST',
        body: JSON.stringify({ code: form.get('code'), name: form.get('name'), deviceId })
      });
      saveSession(data);
      connect();
    } catch (error) { showToast(error.message); setPending(false); }
  });
}

function playerRows(players, mode = '') {
  return players.map((player, index) => `
    <div class="player-row">
      <div class="player-name"><span class="avatar">${avatars[index % avatars.length]}</span><span>${escapeHtml(player.name)}${player.id === state.viewerId ? '（あなた）' : ''}</span></div>
      <span class="status ${player.ready || player.submitted ? 'ready' : ''}">
        ${player.waiting ? '次のラウンドから参加' : player.isHost ? '進行役' : mode === 'ready' ? (player.ready ? '確認済み' : '確認中') : mode === 'vote' ? (player.submitted ? '予想済み' : '考え中') : ''}
      </span>
    </div>`).join('');
}

function renderLobby() {
  const canStart = state.players.length >= 3;
  app.innerHTML = `
    <section class="screen">
      <div class="screen-head"><span class="pill">待機中</span><h2>みんなが集まるのを待とう</h2><p>4桁のコードを同じ場所にいる人へ伝えてください。</p></div>
      <div class="room-code-panel"><p>部屋コード</p><strong class="big-code">${state.code}</strong></div>
      <section class="card stack">
        <div class="player-list">${playerRows(state.players)}</div>
        <p class="fine-print">${state.players.length} / 20人　・　3人から開始できます</p>
        ${state.isHost
          ? `<button class="button" id="startRound" ${canStart ? '' : 'disabled'}>最初のラウンドへ</button>`
          : '<div class="waiting"><div class="dots"><i></i><i></i><i></i></div><span>進行役が始めるのを待っています</span></div>'}
      </section>
    </section>`;
  document.querySelector('#startRound')?.addEventListener('click', () => sendAction('start_round'));
}

function renderTopic() {
  const me = state.players.find((player) => player.id === state.viewerId);
  const allReady = state.players.filter((player) => player.active).every((player) => player.ready);
  const revealed = topicRevealedRound === state.roundNumber;
  app.innerHTML = `
    <section class="screen">
      <div class="screen-head"><span class="pill">ラウンド ${state.roundNumber}</span><h2>あなたのお題</h2><p>周りから見えないように、こっそり確認してください。</p></div>
      <section class="card">
        ${revealed ? `
          <div class="topic-card">
            <span class="category">${escapeHtml(state.category)}</span>
            <div class="topic-word">${escapeHtml(state.ownTopic)}</div>
            <p class="private-note">自分が多数派か少数派かは、まだ分かりません。</p>
          </div>` : `
          <button class="topic-cover" id="revealTopic" type="button">
            <span><span class="big-icon">🙈</span><br><strong>タップしてお題を見る</strong><br><small>画面を自分のほうへ向けてね</small></span>
          </button>`}
      </section>
      ${revealed && !me.ready ? '<button class="button" id="readyButton">確認した！</button>' : ''}
      ${me.ready ? `<section class="card stack"><div class="player-list">${playerRows(state.players, 'ready')}</div></section>` : ''}
      ${state.isHost && me.ready
        ? `<button class="button secondary" id="startTalk" ${allReady ? '' : 'disabled'}>${allReady ? '会話をスタート' : 'みんなの確認を待っています'}</button>`
        : me.ready ? '<p class="hint">進行役が会話を始めるまで待ってね</p>' : ''}
    </section>`;
  document.querySelector('#revealTopic')?.addEventListener('click', () => { topicRevealedRound = state.roundNumber; render(); });
  document.querySelector('#readyButton')?.addEventListener('click', () => sendAction('ready'));
  document.querySelector('#startTalk')?.addEventListener('click', () => sendAction('start_talk'));
}

function renderWaiting() {
  app.innerHTML = `
    <section class="screen">
      <div class="screen-head">
        <span class="pill">参加できました</span>
        <h2>次のラウンドから参加できます</h2>
        <p>いまのラウンドが終わるまで、この画面で待っていてください。画面を閉じても、同じニックネームで部屋に戻れます。</p>
      </div>
      <div class="room-code-panel"><p>部屋コード</p><strong class="big-code">${state.code}</strong></div>
      <section class="card stack">
        <div class="player-list">${playerRows(state.players)}</div>
        <div class="waiting"><div class="dots"><i></i><i></i><i></i></div><span>いまのラウンドを待っています</span></div>
      </section>
    </section>`;
}

function renderTalk() {
  const last = state.questionIndex === state.questionTotal - 1;
  app.innerHTML = `
    <section class="screen">
      <div class="screen-head"><span class="pill topic-reminder">ラウンド ${state.roundNumber}<strong>あなたのお題：${escapeHtml(state.ownTopic)}</strong></span><h2>自由に話そう</h2><p>お題そのものは言わずに、質問について話してください。</p></div>
      <div class="progress" style="--question-total:${state.questionTotal}">${Array.from({ length: state.questionTotal }, (_, index) => `<i class="progress-dot ${index <= state.questionIndex ? 'active' : ''}"></i>`).join('')}</div>
      <section class="card question-card">
        <p class="question-number">質問 ${state.questionIndex + 1} / ${state.questionTotal}</p>
        <p class="question">${escapeHtml(state.question)}</p>
      </section>
      <p class="hint">順番はありません。気になったことを聞き合ってみよう。</p>
      ${state.isHost && last && state.questionTotal < 10 ? '<button class="button secondary" id="addQuestion">さらに質問を1問追加する？</button>' : ''}
      ${state.isHost
        ? `<button class="button ${last ? 'secondary' : ''}" id="advanceTalk">${last ? '予想タイムへ' : '次の質問へ'}</button>`
        : '<div class="waiting"><div class="dots"><i></i><i></i><i></i></div><span>進行役が次へ進めます</span></div>'}
    </section>`;
  document.querySelector('#advanceTalk')?.addEventListener('click', () => sendAction(last ? 'start_vote' : 'next_question'));
  document.querySelector('#addQuestion')?.addEventListener('click', () => sendAction('add_question'));
}

function renderVote() {
  const me = state.players.find((player) => player.id === state.viewerId);
  const roundPlayers = state.players.filter((player) => player.active);
  const submittedCount = roundPlayers.filter((player) => player.submitted).length;
  const pendingNames = roundPlayers.filter((player) => !player.submitted).map((player) => player.name);
  const required = state.minorityTotal;
  if (me.submitted) {
    app.innerHTML = `
      <section class="screen">
        <div class="screen-head"><span class="pill topic-reminder">ラウンド ${state.roundNumber}<strong>あなたのお題：${escapeHtml(state.ownTopic)}</strong></span><h2>予想を受け付けました</h2><p>${submittedCount} / ${roundPlayers.length}人が予想済みです。</p></div>
        <section class="card"><div class="player-list">${playerRows(roundPlayers, 'vote')}</div></section>
        ${pendingNames.length ? `<p class="fine-print">まだ予想中：${pendingNames.map(escapeHtml).join('、')}</p>` : '<p class="fine-print">全員の予想がそろいました</p>'}
        <button class="button secondary" id="editVote">選び直す</button>
        ${state.isHost
          ? `<button class="button" id="revealResults" ${submittedCount === roundPlayers.length ? '' : 'disabled'}>結果を発表</button>`
          : '<div class="waiting"><div class="dots"><i></i><i></i><i></i></div><span>みんなの予想を待っています</span></div>'}
      </section>`;
    document.querySelector('#revealResults')?.addEventListener('click', () => sendAction('reveal_results'));
    document.querySelector('#editVote')?.addEventListener('click', () => {
      selectedVotes = new Set(state.ownVotes || []);
      sendAction('reopen_vote');
    });
    return;
  }

  app.innerHTML = `
    <section class="screen">
      <div class="screen-head"><span class="pill topic-reminder">ラウンド ${state.roundNumber}<strong>あなたのお題：${escapeHtml(state.ownTopic)}</strong></span><h2>違うお題の人は…</h2></div>
      <section class="card count-reveal">
        <span class="count-number">${required}</span>
        <span class="count-label">人います！</span>
      </section>
      <p class="selection-note">違うお題だと思う人を${required}人選んでください。自分も選べます。人数いっぱいのときは、別の人を押すと入れ替わります。</p>
      <div class="select-grid">
        ${roundPlayers.map((player) => `<button class="person-select ${selectedVotes.has(player.id) ? 'selected' : ''}" data-player-id="${player.id}">${escapeHtml(player.name)}${player.id === state.viewerId ? '<br><small>あなた</small>' : ''}</button>`).join('')}
      </div>
      <button class="button" id="submitVote" ${selectedVotes.size === required ? '' : 'disabled'}>この${required}人で決定</button>
    </section>`;
  document.querySelectorAll('.person-select').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.playerId;
    if (selectedVotes.has(id)) selectedVotes.delete(id);
    else if (selectedVotes.size < required) selectedVotes.add(id);
    else {
      const [oldestId] = selectedVotes;
      selectedVotes.delete(oldestId);
      selectedVotes.add(id);
    }
    renderVote();
  }));
  document.querySelector('#submitVote')?.addEventListener('click', () => sendAction('submit_vote', { ids: [...selectedVotes] }));
}

function renderResults() {
  const roundPlayers = state.players.filter((player) => player.active);
  const maxVotes = Math.max(1, ...Object.values(state.results.tally));
  const minorityNames = roundPlayers.filter((player) => state.results.minorityIds.includes(player.id));
  app.innerHTML = `
    <section class="screen">
      <div class="screen-head"><span class="pill">ラウンド ${state.roundNumber} 結果</span><h2>違うお題だったのは…</h2></div>
      <div class="minority-people">${minorityNames.map((player) => `<span class="minority-chip">${escapeHtml(player.name)}</span>`).join('')}</div>
      <section class="card stack">
        <div class="result-words">
          <div class="result-word"><span>みんなのお題</span><strong>${escapeHtml(state.results.majorityTopic)}</strong></div>
          <div class="result-word minority"><span>違うお題</span><strong>${escapeHtml(state.results.minorityTopic)}</strong></div>
        </div>
        <h3>みんなの予想</h3>
        <div class="tally-list">
          ${[...roundPlayers].sort((a, b) => state.results.tally[b.id] - state.results.tally[a.id]).map((player) => {
            const votes = state.results.tally[player.id];
            return `<div class="tally-row"><span class="tally-name">${escapeHtml(player.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${votes / maxVotes * 100}%"></div></div><span class="tally-number">${votes}</span></div>`;
          }).join('')}
        </div>
      </section>
      <p class="hint">どの言葉が怪しく聞こえたか、みんなで話してみよう。</p>
      ${state.isHost ? `
        <button class="button" id="nextRound">次のラウンドへ</button>
        <button class="button danger" id="endRoom">ゲームを終了</button>`
        : '<div class="waiting"><div class="dots"><i></i><i></i><i></i></div><span>進行役が次のラウンドへ進めます</span></div>'}
    </section>`;
  document.querySelector('#nextRound')?.addEventListener('click', () => { topicRevealedRound = null; sendAction('start_round'); });
  document.querySelector('#endRoom')?.addEventListener('click', () => {
    if (confirm('この部屋を終了しますか？')) sendAction('end_room');
  });
}

function renderEnded() {
  app.innerHTML = `
    <section class="screen">
      <div class="screen-head"><span class="pill">おしまい</span><h2>遊んでくれてありがとう！</h2><p>またみんなが集まったときに遊んでね。</p></div>
      <section class="card stack"><div class="topic-card"><div class="topic-word">🌱</div><p>全${state.roundNumber}ラウンド遊びました</p></div><button class="button" id="backHome">トップへ戻る</button></section>
    </section>`;
  document.querySelector('#backHome').addEventListener('click', leaveSession);
}

function leaveSession() {
  disconnect();
  saveSession(null);
  state = null;
  topicRevealedRound = null;
  selectedVotes = new Set();
  renderLanding();
}

async function exitRoom() {
  if (!session || !state) return leaveSession();
  const message = state.isHost
    ? '部屋を退出しますか？ 進行役は残っている人に引き継がれます。'
    : '部屋を退出しますか？';
  if (!confirm(message)) return;
  try {
    await request(`/api/rooms/${session.code}/action`, {
      method: 'POST',
      body: JSON.stringify({ playerId: session.playerId, token: session.token, action: 'leave_room', payload: {} })
    });
    leaveSession();
  } catch (error) {
    if (error.status === 401 || error.status === 404) leaveSession();
    else showToast(error.message);
  }
}

function render() {
  if (!state) return renderLanding();
  setRoomBadge(state.code);
  const renderers = {
    lobby: renderLobby,
    waiting: renderWaiting,
    topic: renderTopic,
    talk: renderTalk,
    vote: renderVote,
    results: renderResults,
    ended: renderEnded
  };
  (renderers[state.phase] || renderLobby)();
}

brandButton.addEventListener('click', () => {
  if (!session) return renderLanding();
  if (state?.phase === 'ended') return leaveSession();
  showToast('ゲーム中は部屋に参加しています');
});

leaveRoomButton.addEventListener('click', exitRoom);

if (session) connect(); else renderLanding();
