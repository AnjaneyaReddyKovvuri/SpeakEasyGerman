'use strict';

const $ = (sel) => document.querySelector(sel);

// Small DOM builder: el('div', {class: 'x', onclick: fn}, 'text', childNode)
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

// Two modes: with the Python server behind the page (laptop), or standalone (e.g. GitHub Pages),
// where backend.js does the server's job in the browser.
const serverMode = fetch('/api/config')
  .then((res) => res.ok && (res.headers.get('content-type') || '').includes('json'))
  .catch(() => false);

async function api(path, body) {
  if (!(await serverMode)) return Standalone.route(path, body);
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Turns a recording into German text: {text} and, if withWords, {words: [{word, prob}]}.
async function transcribeAudio(blob, context, withWords) {
  if (!(await serverMode)) return Standalone.transcribe(blob, context, withWords);
  const res = await fetch(`/api/transcribe?context=${encodeURIComponent(context)}${withWords ? '&words=1' : ''}`, { method: 'POST', body: blob });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'server error');
  return data;
}

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable: settings just don't persist */ }
  return null;
}

// ---------- settings ----------

// Speech recognition: 'browser' = the browser's own service (more accurate, audio goes to Google/Microsoft),
// 'whisper' = on the laptop (private, weaker with accents). Edge's browser service is unreliable.
const HAS_BROWSER_STT = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
const defaultStt = HAS_BROWSER_STT && !navigator.userAgent.includes('Edg/') ? 'browser' : 'whisper';
const settings = Object.assign({ level: 'B1', rate: 0.95, voice: '', explain: 'English', mic: '', stt: defaultStt }, store('settings'));

function bindSetting(id, key, parse = (v) => v) {
  const input = $(id);
  input.value = settings[key];
  input.addEventListener('change', () => {
    settings[key] = parse(input.value);
    store('settings', settings);
  });
}
bindSetting('#set-level', 'level');
bindSetting('#set-rate', 'rate', Number);
bindSetting('#set-explain', 'explain');
bindSetting('#set-stt', 'stt');

// ---------- text to speech ----------

let voices = [];

function loadVoices() {
  voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('de'));
  // Neural voices (Edge "Natural") sound far better than the classic ones.
  const rank = (v) => (/natural|neural/i.test(v.name) ? 0 : /google/i.test(v.name) ? 1 : 2);
  voices.sort((a, b) => rank(a) - rank(b));
  const select = $('#set-voice');
  select.replaceChildren(...voices.map((v) => el('option', { value: v.name }, v.name.replace(/Microsoft |Online \(Natural\) /g, ''))));
  if (voices.some((v) => v.name === settings.voice)) select.value = settings.voice;
  else if (voices.length) settings.voice = voices[0].name;
  showWarnings();
}
$('#set-voice').addEventListener('change', (e) => {
  settings.voice = e.target.value;
  store('settings', settings);
  speak('So klingt diese Stimme.');
});

const splitSentences = (text) => text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);

// Speaks sentence by sentence: long single utterances get cut off in Chrome.
function speak(text, rateFactor = 1) {
  speechSynthesis.cancel();
  const voice = voices.find((v) => v.name === settings.voice);
  const parts = splitSentences(text);
  return new Promise((resolve) => {
    if (!parts.length) return resolve();
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      u.lang = 'de-DE';
      if (voice) u.voice = voice;
      u.rate = settings.rate * rateFactor;
      if (i === parts.length - 1) u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  });
}

// ---------- microphone ----------

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const IS_EDGE = navigator.userAgent.includes('Edg/');
let useWhisper = false;  // true when the server can transcribe recordings itself

const MIC_ERRORS = {
  'not-allowed': 'Microphone access is blocked. Click the lock/microphone icon in the address bar, allow the microphone, and reload.',
  'service-not-allowed': 'This browser has speech recognition switched off. Open this page in Chrome instead.',
  'audio-capture': 'No microphone found. Check that one is connected and selected in Windows sound settings.',
  'network': 'The browser could not reach its speech recognition service.'
    + ' Set “Speech” at the top to “Whisper”, or check your internet connection.',
  'language-not-supported': 'This browser cannot recognise German. Open this page in Chrome instead.',
};

// Writes microphone events to data/mic.log on the server so problems can be diagnosed.
function micLog(message) {
  api('/api/log', { key: 'mic', message }).catch(() => {});
}

function micStatus(text, isError = false) {
  if (text) micLog(`${isError ? 'ERROR' : 'status'}: ${text}`);
  const box = $('#mic-status');
  box.hidden = !text;
  box.textContent = text;
  box.classList.toggle('error', isError);
}

async function listMics(stream) {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.label);
  const select = $('#set-mic');
  if (!devices.length) return select.replaceChildren(el('option', { value: '' }, 'Default'));
  select.replaceChildren(...devices.map((d) => el('option', { value: d.deviceId }, d.label)));
  const current = stream ? stream.getAudioTracks()[0].getSettings().deviceId : settings.mic;
  if (devices.some((d) => d.deviceId === current)) select.value = current;
}
$('#set-mic').addEventListener('change', (e) => {
  settings.mic = e.target.value;
  store('settings', settings);
});

async function openMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: settings.mic ? { deviceId: { exact: settings.mic } } : true });
    listMics(stream);
    return stream;
  } catch (err) {
    if (settings.mic && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      settings.mic = '';  // the saved microphone is gone: fall back to the default one
      return openMic();
    }
    micStatus(`The browser cannot use a microphone (${err.name}). Allow microphone access for this page (icon in the address bar) and check Windows Settings → Privacy → Microphone.`, true);
    return null;
  }
}

// Watches the sound level of a stream. onLevel gets 0..1 several times a second.
function meter(stream, onLevel) {
  const ctx = new AudioContext();
  ctx.resume();
  const analyser = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const watch = { peak: 0, stop() { clearInterval(timer); ctx.close(); } };
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    let now = 0;
    for (const v of samples) now = Math.max(now, Math.abs(v - 128));
    watch.peak = Math.max(watch.peak, now);
    onLevel(now / 128);
  }, 80);
  return watch;
}
const SILENT = 4;  // peak below this (of 128) means the microphone delivered no sound

// Records from the chosen microphone and lets the server transcribe it. Returns a stop function.
async function startRecording({ button, textarea, onStop, clear, context = '', handleAudio }) {
  const stream = await openMic();
  if (!stream) return null;
  const device = stream.getAudioTracks()[0].label;
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const level = meter(stream, (v) => {
    button.style.boxShadow = `0 0 0 ${Math.round(Math.min(v * 4, 1) * 12)}px rgba(179, 38, 30, 0.35)`;
  });
  recorder.onstop = async () => {
    clear();
    level.stop();
    stream.getTracks().forEach((t) => t.stop());
    button.classList.remove('rec');
    button.style.boxShadow = '';
    micLog(`recording stopped: device="${device}" peak=${level.peak}/128 bytes=${chunks.reduce((n, c) => n + c.size, 0)} type=${recorder.mimeType}`);
    if (level.peak < SILENT) {
      return micStatus(`No sound came from “${device}”. Choose another microphone in the “Mic” list at the top, or unmute it in Windows sound settings.`, true);
    }
    if (handleAudio) return handleAudio(new Blob(chunks, { type: recorder.mimeType }));
    button.disabled = true;
    micStatus('Turning your speech into text…');
    try {
      const data = await transcribeAudio(new Blob(chunks, { type: recorder.mimeType }), context, false);
      if (!data.text) return micStatus('I heard sound but no words. Speak a little louder or closer to the microphone.', true);
      micLog(`transcribed: ${data.text}`);
      textarea.value = `${textarea.value.trim()} ${data.text}`.trim();
      micStatus('');
      if (onStop) onStop();
    } catch (err) {
      micStatus(`Could not turn the recording into text: ${err.message}`, true);
    } finally {
      button.disabled = false;
    }
  };
  recorder.start();
  button.classList.add('rec');
  micStatus(`🎤 Recording from “${device}”. Speak German, then click the microphone again. The red ring shows your sound level.`);
  return () => recorder.stop();
}

// Fallback without Whisper: the browser's own recognition. Returns a stop function.
function startBrowserRecognition({ button, textarea, onStop, clear }) {
  if (!SR) { showWarnings(); return null; }
  let active = true, committed = '', session = '';
  const base = textarea.value.trim() ? textarea.value.trim() + ' ' : '';
  const rec = new SR();
  rec.lang = 'de-DE';
  // Android repeats earlier words in continuous mode, so there we take one phrase at a time and restart.
  rec.continuous = !/Android/.test(navigator.userAgent);
  rec.interimResults = true;
  rec.onresult = (e) => {
    let interim = '';
    session = '';
    for (const result of e.results) {
      if (result.isFinal) session += result[0].transcript + ' ';
      else interim += result[0].transcript;
    }
    textarea.value = (base + committed + session + interim).replace(/\s+/g, ' ');
  };
  rec.onstart = () => micStatus('🎤 Listening… speak German now, then click the microphone again.');
  rec.onspeechstart = () => micStatus('🎤 I can hear you…');
  rec.onerror = (e) => {
    if (e.error === 'aborted') return;
    if (e.error === 'no-speech') return micStatus('🎤 Still listening, but no speech detected. Use “Test microphone” if this keeps happening.');
    active = false;
    micStatus(MIC_ERRORS[e.error] || `Speech recognition failed (${e.error}). You can still type your answer.`, true);
  };
  rec.onend = () => {
    committed += session;
    session = '';
    if (active) {
      // The browser ends recognition after a pause; keep listening until the user stops.
      try { rec.start(); return; } catch { active = false; }
    }
    clear();
    button.classList.remove('rec');
    textarea.value = textarea.value.trim();
    micLog(`browser recognised: ${committed}`);
    if (!committed.trim() && useWhisper) {
      // The browser's service gave nothing (it fails on some machines): use Whisper from now on.
      settings.stt = 'whisper';
      store('settings', settings);
      $('#set-stt').value = 'whisper';
      return micStatus('The browser’s speech recognition returned nothing, so “Speech” is now set to Whisper. Click the microphone and say it again.', true);
    }
    if (!$('#mic-status').classList.contains('error')) {
      micStatus(textarea.value ? '' : 'Nothing was recognised. Use “Test microphone” to find out why.', !textarea.value);
    }
    if (onStop) onStop();
  };
  button.classList.add('rec');
  rec.start();
  return () => { active = false; rec.stop(); };
}

// Toggle button that puts spoken German into a textarea. Calls onStop once the text is there.
// getContext (optional) returns German text related to what will be said, to help Whisper.
function attachMic(button, textarea, onStop, getContext) {
  let stop = null, starting = false;
  button.addEventListener('click', async () => {
    micLog(`mic button clicked (${stop ? 'stop' : starting ? 'ignored, still starting' : 'start'}) whisper=${useWhisper} stt=${settings.stt}`);
    if (starting) return;
    if (stop) return stop();
    speechSynthesis.cancel();
    starting = true;
    const session = { button, textarea, onStop, clear: () => { stop = null; }, context: getContext ? getContext() : '' };
    const viaWhisper = useWhisper && (settings.stt === 'whisper' || !SR);
    stop = viaWhisper ? await startRecording(session) : startBrowserRecognition(session);
    starting = false;
  });
}

async function testMicrophone() {
  speechSynthesis.cancel();
  const stream = await openMic();
  if (!stream) return;
  const device = stream.getAudioTracks()[0].label;
  micStatus(`Testing “${device}”: say something for 3 seconds…`);
  const level = meter(stream, () => {});
  await new Promise((r) => setTimeout(r, 3000));
  level.stop();
  stream.getTracks().forEach((t) => t.stop());
  if (level.peak < SILENT) {
    return micStatus(`“${device}” is connected but sends no sound. Choose another microphone in the “Mic” list at the top, or unmute it in Windows sound settings.`, true);
  }
  micStatus(`✓ “${device}” works (level ${Math.round((100 * level.peak) / 128)}%). Now use the 🎤 button next to an answer box.`);
}
$('#mic-test').addEventListener('click', testMicrophone);

function showWarnings(message) {
  const notes = [];
  if (message) notes.push(message);
  if (!SR && !useWhisper) notes.push('This browser has no speech recognition, so you can only type. Use Chrome or Edge to speak.');
  if (!voices.length) notes.push('No German voice found in this browser. Edge has the best free German voices.');
  $('#warn').hidden = !notes.length;
  $('#warn').textContent = notes.join(' ');
}

// ---------- shared rendering ----------

// "English" link plus the box it fills. The translation is fetched on first use unless already known.
function englishToggle(german, known) {
  const box = el('div', { class: 'english', hidden: true });
  let loaded = false;
  const link = el('button', { class: 'link', onclick: async () => {
    if (loaded) { box.hidden = !box.hidden; return; }
    loaded = true;
    box.hidden = false;
    box.textContent = known || 'Translating…';
    if (known) return;
    try {
      box.textContent = (await api('/api/translate', { text: german })).en;
    } catch (err) {
      loaded = false;
      box.textContent = err.message;
    }
  } }, 'English');
  return [link, box];
}

function renderCorrections(corrections, better) {
  const box = el('div', { class: 'fix' });
  if (!corrections.length) box.append(el('div', { class: 'ok' }, '✓ No mistakes found.'));
  for (const c of corrections) {
    box.append(el('div', {},
      el('span', { class: 'was' }, c.original), ' → ', el('span', { class: 'now' }, c.corrected),
      el('button', { class: 'link', onclick: () => speak(c.corrected) }, '🔊'),
      el('div', { class: 'muted' }, c.explanation || '')));
  }
  if (better) {
    box.append(el('div', {}, el('b', {}, 'More natural: '), better,
      el('button', { class: 'link', onclick: () => speak(better) }, '🔊'), englishToggle(better)));
  }
  return box;
}

async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try {
    await fn();
  } catch (err) {
    showWarnings(err.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
    refreshStats();
  }
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    const t = s.today;
    $('#stats').textContent = `🔥 ${s.streak}-day streak · today: ${t.turns || 0} turns, ${t.retells || 0} retellings, ${t.shadow || 0} sentences, ${t.pron || 0} pronunciation checks, ${t.reviews || 0} reviews`;
    $('#due-badge').hidden = !s.due;
    $('#due-badge').textContent = s.due;
  } catch { /* stats are cosmetic */ }
}

// ---------- tabs ----------

const tabs = ['talk', 'listen', 'shadow', 'say', 'cards', 'settings'];
function showTab(name) {
  speechSynthesis.cancel();
  for (const t of tabs) $(`#tab-${t}`).hidden = t !== name;
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('active', b.dataset.tab === name);
  if (name === 'cards') loadCards();
  if (name === 'settings') loadLlm();
  if (name === 'shadow' && !$('#shadow-source').value && listening) $('#shadow-source').value = listening.text;
}
for (const b of document.querySelectorAll('nav button')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------- conversation ----------

const SCENARIOS = [
  ['Small talk with a colleague', 'Casual small talk with a colleague in the office kitchen on a Monday morning.'],
  ['Job interview', 'A job interview. Lena is the hiring manager and interviews the learner for a role in their own profession; she first asks what they do.'],
  ['Introduce yourself to a new team', 'The learner\'s first day at a German company. Lena is a team member who wants to know their background and experience.'],
  ['Team meeting: status update', 'A weekly team meeting. Lena leads it and asks the learner for a status update on their project, with follow-up questions.'],
  ['Disagree politely in a meeting', 'A meeting where Lena proposes a plan the learner should question. Practise disagreeing politely and arguing a position.'],
  ['Phone call with a customer', 'A phone call. Lena is a customer with a problem and the learner must clarify it and offer a solution.'],
  ['Explain your work to a non-expert', 'Lena is from another department and asks the learner to explain what they work on, in plain language.'],
  ['Salary and contract negotiation', 'A negotiation about salary, start date and working conditions. Lena represents HR.'],
  ['Lunch with colleagues', 'Lunch in the canteen. Relaxed talk about weekend plans, holidays, the city and current events.'],
  ['Discuss an opinion topic', 'A discussion about a current topic in working life (remote work, AI at work, four-day week). Lena asks for opinions and challenges them.'],
];
$('#scenario').append(...SCENARIOS.map(([label], i) => el('option', { value: i }, label)));

let history = [];
let scenario = '';

function addBubble(role, text, english) {
  const say = el('div', { class: 'say' }, text);
  const bubble = el('div', { class: `bubble ${role}` }, say);
  if (role === 'tutor') {
    if ($('#opt-hide').checked) bubble.classList.add('hidden-text');
    say.addEventListener('click', () => bubble.classList.remove('hidden-text'));
    bubble.append(el('div', { class: 'tools' }, el('button', { class: 'link', onclick: () => speak(text) }, '🔊 again'),
      el('button', { class: 'link', onclick: () => speak(text, 0.75) }, '🐢 slower'), englishToggle(text, english)));
  }
  $('#chat').append(bubble);
  $('#chat').scrollTop = $('#chat').scrollHeight;
  return bubble;
}

async function chatTurn(learnerBubble) {
  const out = await api('/api/chat', { scenario, level: settings.level, explain: settings.explain, history });
  if (learnerBubble) learnerBubble.append(renderCorrections(out.corrections, out.better));
  history.push({ role: 'tutor', text: out.reply });
  addBubble('tutor', out.reply, out.reply_en);
  speak(out.reply);
}

$('#talk-start').addEventListener('click', () => withBusy($('#talk-start'), async () => {
  scenario = $('#scenario-custom').value.trim() || SCENARIOS[$('#scenario').value][1];
  history = [];
  $('#chat').replaceChildren();
  await chatTurn(null);
}));

function sendTalk() {
  const text = $('#talk-input').value.trim();
  if (!text || $('#talk-send').disabled) return;
  if (!scenario) return showWarnings('Press Start first to begin a conversation.');
  $('#talk-input').value = '';
  history.push({ role: 'learner', text });
  const bubble = addBubble('learner', text);
  withBusy($('#talk-send'), () => chatTurn(bubble));
}
$('#talk-send').addEventListener('click', sendTalk);
$('#talk-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTalk(); }
});
attachMic($('#talk-mic'), $('#talk-input'), () => { if ($('#opt-autosend').checked) sendTalk(); },
  () => history.filter((t) => t.role === 'tutor').slice(-1).map((t) => t.text).join(''));

// ---------- listen & retell ----------

let listening = store('listening');

function renderListening() {
  $('#listen-body').hidden = !listening;
  $('#listen-empty').hidden = !!listening;
  if (!listening) return;
  $('#listen-title').textContent = listening.title;
  $('#listen-text').hidden = true;
  $('#listen-reveal').textContent = 'Show transcript';
  $('#listen-text').replaceChildren(
    el('p', {}, listening.text),
    el('div', {}, englishToggle(listening.text)),
    el('ul', { class: 'vocab' }, (listening.vocab || []).map((v) => el('li', {}, el('b', {}, v.de), ` – ${v.en}`))));
  $('#listen-questions').replaceChildren(...(listening.questions || []).map((q) => el('li', {}, q)));
  $('#retell-result').replaceChildren();
  $('#retell-input').value = '';
}

$('#listen-new').addEventListener('click', () => withBusy($('#listen-new'), async () => {
  listening = await api('/api/listen', {
    topic: $('#listen-topic').value.trim(), level: settings.level, length: $('#listen-length').value,
  });
  store('listening', listening);
  renderListening();
  speak(listening.text);
}));
$('#listen-play').addEventListener('click', () => speak(listening.text));
$('#listen-stop').addEventListener('click', () => speechSynthesis.cancel());
$('#listen-reveal').addEventListener('click', () => {
  const text = $('#listen-text');
  text.hidden = !text.hidden;
  $('#listen-reveal').textContent = text.hidden ? 'Show transcript' : 'Hide transcript';
});
$('#listen-shadow').addEventListener('click', () => {
  $('#shadow-source').value = listening.text;
  showTab('shadow');
  loadShadow();
});

$('#retell-send').addEventListener('click', () => {
  const retelling = $('#retell-input').value.trim();
  if (!retelling) return;
  speechSynthesis.cancel();
  withBusy($('#retell-send'), async () => {
    const r = await api('/api/retell', {
      text: listening.text, retelling, level: settings.level, explain: settings.explain,
    });
    const score = (label, value) => el('div', { class: 'score' }, el('b', {}, value), label);
    $('#retell-result').replaceChildren(
      el('div', { class: 'scores' }, score('Content', `${r.content}/5`), score('Grammar', `${r.grammar}/5`),
        score('Vocabulary', `${r.vocabulary}/5`), score('Shown level', r.level)),
      el('p', {}, r.feedback),
      (r.missed || []).length ? el('div', {}, el('b', {}, 'Missed points'), el('ul', {}, r.missed.map((m) => el('li', {}, m)))) : null,
      renderCorrections(r.corrections || [], ''),
      el('div', { class: 'panel' }, el('b', {}, 'Model answer '),
        el('button', { class: 'link', onclick: () => speak(r.model) }, '🔊'), el('p', {}, r.model),
        englishToggle(r.model)));
  });
});
attachMic($('#retell-mic'), $('#retell-input'), null,
  () => (listening ? `${listening.title}. ${(listening.vocab || []).map((v) => v.de).join(', ')}.` : ''));

// ---------- shadowing & dictation ----------

let sentences = [];
let position = 0;

const normalise = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

// Marks which words of the original appear, in order, in what the learner said (longest common subsequence).
function compareWords(original, said) {
  const words = original.split(/\s+/).filter(Boolean);
  const a = words.map((w) => normalise(w).join(''));
  const b = normalise(said);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hit = a.map((w) => w === '');  // pure punctuation counts as correct
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { hit[i] = true; i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  const real = a.filter((w) => w !== '').length;
  return { words, hit, score: real ? Math.round((100 * lcs[0][0]) / real) : 0 };
}

function showSentence() {
  $('#shadow-pos').textContent = `Sentence ${position + 1} of ${sentences.length}`;
  $('#shadow-sentence').hidden = true;
  $('#shadow-sentence').replaceChildren(el('div', {}, sentences[position]), ...englishToggle(sentences[position]));
  $('#shadow-input').value = '';
  $('#shadow-result').replaceChildren();
  speak(sentences[position]);
}

function loadShadow() {
  sentences = splitSentences($('#shadow-source').value);
  $('#shadow-body').hidden = !sentences.length;
  if (!sentences.length) return;
  position = 0;
  showSentence();
}

function checkShadow() {
  const said = $('#shadow-input').value.trim();
  if (!said) return;
  const { words, hit, score } = compareWords(sentences[position], said);
  $('#shadow-sentence').hidden = false;
  $('#shadow-result').replaceChildren(
    el('p', {}, el('b', {}, `${score}% `), score === 100 ? 'Perfect!' : score >= 80 ? 'Close. Listen again to the red words.' : 'Listen again and retry.'),
    el('p', {}, words.flatMap((w, i) => [el('span', { class: `word ${hit[i] ? 'hit' : 'miss'}` }, w), ' '])));
  api('/api/log', { key: 'shadow' }).then(refreshStats).catch(() => {});
}

function moveShadow(step) {
  position = Math.min(Math.max(position + step, 0), sentences.length - 1);
  showSentence();
}

$('#shadow-load').addEventListener('click', loadShadow);
$('#shadow-prev').addEventListener('click', () => moveShadow(-1));
$('#shadow-next').addEventListener('click', () => moveShadow(1));
$('#shadow-play').addEventListener('click', () => speak(sentences[position]));
$('#shadow-slow').addEventListener('click', () => speak(sentences[position], 0.7));
$('#shadow-peek').addEventListener('click', () => { $('#shadow-sentence').hidden = !$('#shadow-sentence').hidden; });
$('#shadow-check').addEventListener('click', checkShadow);
attachMic($('#shadow-mic'), $('#shadow-input'), checkShadow);

// ---------- pronunciation ----------

const PRON_SETS = [
  ['ü', 'Say “ee” as in “see”, keep your tongue exactly there, and round your lips tightly as if for “oo”.',
    ['Ich übe fünf Minuten.', 'Die Tür ist zu.', 'Wir müssen früh aufstehen.', 'Natürlich, kein Problem.', 'Ich wünsche Ihnen viel Glück.', 'Das Büro ist für uns zu klein.']],
  ['ö', 'Say “e” as in “bed” and round your lips. The tongue stays forward; only the lips change.',
    ['Ich möchte ein Brötchen.', 'Können Sie das wiederholen?', 'Das ist eine schöne Lösung.', 'Wir hören zwölf Wörter.', 'Das ist möglich.', 'Ich habe eine höfliche Frage.']],
  ['ei, ie, ä', '“ei” sounds like English “eye”. “ie” is a long “ee”. “ä” is like the “e” in “bed”.',
    ['Ich schreibe viele Briefe.', 'Wir bleiben hier.', 'Die Arbeit ist nicht schwierig.', 'Später erkläre ich die Details.', 'Das Gerät ist ziemlich teuer.', 'Ich weiß nicht, wie viel Zeit wir haben.']],
  ['ch', 'After i, e, ä, ö, ü, l, n, r: a soft hiss like the “h” in “huge”. After a, o, u, au: a rough sound at the back of the throat, like Scottish “loch”. It is never “k” or “sh”.',
    ['Ich möchte Milch.', 'Ich spreche ein bisschen Deutsch.', 'Das Buch ist auch wichtig.', 'Wir machen das am Mittwoch.', 'Vielleicht ist das richtig.', 'Acht Kollegen suchen eine Lösung.']],
  ['r and -er', 'At the start of a syllable, “r” is made at the back of the throat, like a very soft gargle. At the end of a word, “-er” is not rolled: it sounds like a short “a”.',
    ['Der Bericht ist fertig.', 'Ich brauche mehr Erfahrung.', 'Die Rechnung ist richtig.', 'Wir reden über das Projekt.', 'Mein Bruder arbeitet als Ingenieur.', 'Unsere Lehrerin kommt aus Bremen.']],
  ['z, s, ß', '“z” is always “ts”, as in “cats”. A single “s” before a vowel is voiced like English “z”. “ß” and “ss” are a sharp “s”.',
    ['Die Sitzung beginnt um zehn.', 'Wir haben zu wenig Zeit.', 'Sie sind sehr zufrieden.', 'Zwei Zimmer sind besetzt.', 'Die Straße ist groß.', 'Zusammen schaffen wir das.']],
  ['sch, sp, st', '“sch” is “sh”. At the start of a word or syllable, “sp” and “st” are said “shp” and “sht”.',
    ['Wir stehen an der Straße.', 'Die Stelle ist spannend.', 'Ich verstehe die Sprache.', 'Das Gespräch war schwierig.', 'Der Student spielt Schach.', 'Ich bestelle später etwas.']],
  ['w and v', '“w” is English “v” (teeth on the lower lip). “v” is usually “f”, as in “viel” and “vor”.',
    ['Wir wollen das wissen.', 'Vielen Dank für die Antwort.', 'Wann beginnt der Vortrag?', 'Ich warte vor dem Büro.', 'Das ist sehr wichtig für uns.', 'Wie viele Wochen brauchen wir?']],
  ['eu, äu, au', '“eu” and “äu” sound like English “oy”. “au” sounds like “ow” in “now”.',
    ['Heute treffe ich neue Leute.', 'Das Gebäude ist teuer.', 'Die Häuser sind neu.', 'Der Verkäufer ist freundlich.', 'Ich freue mich auf den Urlaub.', 'Wir brauchen auch neue Räume.']],
  ['Long and short vowels', 'A vowel is long before a single consonant or “h”, and short before a double consonant. The length changes the meaning.',
    ['Der Staat und die Stadt.', 'Die Miete und die Mitte.', 'Der Ofen ist offen.', 'Das Bett steht im Beet.', 'Ich fühle, wie ich die Flasche fülle.', 'Wir wohnen in einer Wohnung mit Sonne.']],
  ['Long workplace words', 'Say each part on its own first, then join them. The main stress is on the first part of a compound.',
    ['die Geschäftsführung', 'das Vorstellungsgespräch', 'die Arbeitserlaubnis', 'die Krankenversicherung', 'der Verbesserungsvorschlag', 'die Zuständigkeit', 'die Entscheidung', 'die Besprechung']],
];
$('#say-set').append(...PRON_SETS.map(([name], i) => el('option', { value: i }, `Sound: ${name}`)));

let sayItems = [];
let sayIndex = 0;
let myRecording = null;
let lastCheck = [];  // verdict per target word from the latest recording: {kind, note}

// Adds the "Your try" column to the pronunciation table when both it and a recording exist.
function paintGuide() {
  const rows = [...document.querySelectorAll('#say-guide tr')];
  if (!rows.length) return;
  rows.forEach((row) => row.querySelector('.try')?.remove());
  if (lastCheck.length !== rows.length - 1) return;  // the table splits the words differently
  rows[0].append(el('th', { class: 'try' }, 'Your try'));
  lastCheck.forEach(({ kind, note }, i) => rows[i + 1].append(el('td', { class: `try ${kind}` }, note)));
}

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}
const similarity = (a, b) => (a || b ? 1 - editDistance(a, b) / Math.max(a.length, b.length) : 1);

// Pairs each target word with what was heard in its place. Similar-sounding words are paired preferentially.
function alignWords(target, heard) {
  const a = target.map((w) => normalise(w).join(''));
  const b = heard.map((h) => normalise(h.word).join(''));
  const cost = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) cost[i][0] = i;
  for (let j = 0; j <= b.length; j++) cost[0][j] = j;
  const swap = (i, j) => 1 - similarity(a[i - 1], b[j - 1]);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cost[i][j] = Math.min(cost[i - 1][j] + 1, cost[i][j - 1] + 1, cost[i - 1][j - 1] + swap(i, j));
    }
  }
  const rows = [];
  let i = a.length, j = b.length;
  while (i > 0) {
    if (j > 0 && Math.abs(cost[i][j] - (cost[i - 1][j - 1] + swap(i, j))) < 1e-9) {
      rows.unshift({ word: target[i - 1], heard: heard[j - 1], match: similarity(a[i - 1], b[j - 1]) });
      i--; j--;
    } else if (j > 0 && cost[i][j] === cost[i][j - 1] + 1) {
      j--;  // an extra word that was heard: ignore
    } else {
      rows.unshift({ word: target[i - 1], heard: null, match: 0 });
      i--;
    }
  }
  return rows;
}

function showSayItem() {
  $('#say-body').hidden = !sayItems.length;
  if (!sayItems.length) return;
  $('#say-pos').textContent = `${sayIndex + 1} of ${sayItems.length}`;
  $('#say-target').replaceChildren(el('div', {}, sayItems[sayIndex]), ...englishToggle(sayItems[sayIndex]));
  $('#say-result').replaceChildren();
  $('#say-guide').replaceChildren();
  lastCheck = [];
  $('#say-mine').disabled = true;
}

// Written pronunciation guide for the current item: sounds-like spelling, IPA and a tip per word.
function loadGuide() {
  const text = sayItems[sayIndex];
  return withBusy($('#say-guide-btn'), async () => {
    const { words } = await api('/api/pronounce', { text, explain: settings.explain });
    if (text !== sayItems[sayIndex]) return;  // the learner moved on while this was loading
    $('#say-guide').replaceChildren(el('table', { class: 'guide' },
      el('tr', {}, el('th', {}, 'Word'), el('th', {}, 'Sounds like'), el('th', {}, 'IPA'), el('th', {}, 'Tip')),
      (words || []).map((w) => el('tr', {},
        el('td', {}, el('button', { class: 'link', title: 'Hear this word', onclick: () => speak(w.word, 0.8) }, `🔊 ${w.word}`)),
        el('td', {}, el('b', {}, w.say)), el('td', { class: 'muted' }, w.ipa), el('td', { class: 'muted' }, w.tip)))));
    paintGuide();
  });
}

function loadSaySet() {
  const [, tip, items] = PRON_SETS[$('#say-set').value];
  $('#say-tip').textContent = tip;
  $('#say-tip').hidden = false;
  sayItems = items;
  sayIndex = 0;
  showSayItem();
}

async function checkPronunciation(blob) {
  if (myRecording) URL.revokeObjectURL(myRecording);
  myRecording = URL.createObjectURL(blob);
  $('#say-mine').disabled = false;
  micStatus('Checking your pronunciation…');
  try {
    showPronunciation(await transcribeAudio(blob, '', true));
  } catch (err) {
    micStatus(`Could not check the recording: ${err.message}`, true);
  }
}

// Compares what was heard ({text, words}) with the current item and shows the verdict word by word.
function showPronunciation(data) {
  const target = sayItems[sayIndex].split(/\s+/).filter((w) => normalise(w).length);
  try {
    micStatus('');
    micLog(`pronunciation: target="${sayItems[sayIndex]}" heard="${data.text}"`);
    const rows = alignWords(target, (data.words || []).filter((h) => normalise(h.word).length));
    let good = 0;
    lastCheck = [];
    const chips = rows.map(({ word, heard, match }) => {
      let kind = 'bad', note = heard ? `heard “${heard.word.replace(/[.,!?]/g, '')}”` : 'not heard';
      if (heard && match > 0.8) {  // above 0.8 is the same word in another spelling (Encyclopädie / Enzyklopädie)
        kind = heard.prob >= 0.6 ? 'good' : 'unsure';
        note = heard.prob >= 0.6 ? 'clear' : 'understood, but unclear';
        good++;
      } else if (heard && match >= 0.5) {
        kind = 'close';
      }
      lastCheck.push({ kind, note: kind === 'good' ? '✓ correct' : note });
      return el('button', { class: `chip ${kind}`, title: 'Hear this word', onclick: () => speak(word, 0.8) },
        el('b', {}, word.replace(/[.,!?;:]/g, '')), el('small', {}, note));
    });
    $('#say-result').replaceChildren(
      good === rows.length
        ? el('p', { class: 'verdict pass' }, '✓ Correct. Every word was understood.')
        : el('p', { class: 'verdict fail' }, `Not yet: ${good} of ${rows.length} words understood. Tap a coloured word to hear it, then try again.`),
      el('div', { class: 'chips' }, chips),
      el('p', { class: 'muted' }, `The app heard: “${data.text || '(nothing)'}”`));
    paintGuide();
    api('/api/log', { key: 'pron' }).then(refreshStats).catch(() => {});
  } catch (err) {
    micStatus(`Could not check the recording: ${err.message}`, true);
  }
}

// Record button that hands the audio to a function instead of filling a text box (always uses Whisper).
function attachRecorder(button, handleAudio) {
  let stop = null, starting = false;
  button.addEventListener('click', async () => {
    if (starting) return;
    if (stop) return stop();
    speechSynthesis.cancel();
    if (!useWhisper) {
      // No Whisper available: fall back to the browser's recognition (no recording to play back).
      if (!SR) return micStatus('Pronunciation checks need speech recognition. Add a Whisper key in Settings, or use Chrome.', true);
      const heard = document.createElement('textarea');
      stop = startBrowserRecognition({
        button, textarea: heard, clear: () => { stop = null; },
        onStop: () => showPronunciation({ text: heard.value, words: heard.value.split(/\s+/).filter(Boolean).map((word) => ({ word, prob: 1 })) }),
      });
      return;
    }
    starting = true;
    stop = await startRecording({ button, clear: () => { stop = null; }, handleAudio });
    starting = false;
  });
}

$('#say-set').addEventListener('change', loadSaySet);
$('#say-custom-go').addEventListener('click', () => {
  const text = $('#say-custom').value.trim();
  if (!text) return;
  $('#say-tip').hidden = true;
  sayItems = splitSentences(text);
  sayIndex = 0;
  showSayItem();
  speak(sayItems[0]);
  loadGuide();
});
$('#say-guide-btn').addEventListener('click', loadGuide);
$('#say-prev').addEventListener('click', () => { sayIndex = Math.max(sayIndex - 1, 0); showSayItem(); });
$('#say-next').addEventListener('click', () => { sayIndex = Math.min(sayIndex + 1, sayItems.length - 1); showSayItem(); });
$('#say-play').addEventListener('click', () => speak(sayItems[sayIndex]));
$('#say-slow').addEventListener('click', () => speak(sayItems[sayIndex], 0.65));
$('#say-mine').addEventListener('click', () => { speechSynthesis.cancel(); new Audio(myRecording).play(); });
attachRecorder($('#say-mic'), checkPronunciation);
loadSaySet();

// ---------- settings: which AI plays the tutor ----------

let llm = null;  // provider list and saved settings from the server (API keys are never sent back)

function showProvider() {
  const id = $('#llm-provider').value;
  const provider = llm.providers.find((p) => p.id === id);
  const saved = llm.settings[id];
  const remote = provider.kind !== 'cli';
  $('#llm-note').textContent = provider.note + (provider.available ? '' : ' Not available: the server is missing the anthropic package.');
  for (const row of ['#llm-key-row', '#llm-models-row', '#llm-chat-row', '#llm-eval-row']) $(row).hidden = !remote;
  $('#llm-url-row').hidden = id !== 'custom';
  $('#llm-url').value = saved.base_url;
  $('#llm-key').value = '';
  $('#llm-key').placeholder = saved.has_key ? `saved (ends in ${saved.key_hint}); leave empty to keep it` : 'paste your key here';
  $('#llm-chat').value = saved.chat_model;
  $('#llm-eval').value = saved.eval_model;
  $('#llm-model-list').replaceChildren();
  $('#llm-result').replaceChildren();
}

function renderLlm(data) {
  llm = data;
  $('#llm-provider').replaceChildren(...llm.providers.map((p) => el('option', { value: p.id }, p.label)));
  $('#llm-provider').value = llm.provider;
  const ready = !llm.whisper || llm.settings[llm.provider].has_key;  // the standalone app needs a key first
  $('#llm-current').textContent = ready
    ? `Now in use: ${llm.providers.find((p) => p.id === llm.provider).label}`
    : 'Welcome! To start, choose an AI service below, paste its API key, load the model list, pick a model and press “Save and test”.';
  $('#whisper-block').hidden = !llm.whisper;  // only the standalone app takes a Whisper key
  if (llm.whisper) {
    $('#whisper-service').value = llm.whisper.service;
    $('#whisper-model').value = llm.whisper.model;
    $('#whisper-key').value = '';
    $('#whisper-key').placeholder = llm.whisper.has_key ? `saved (ends in ${llm.whisper.key_hint}); leave empty to keep it`
      : llm.whisper.active ? 'using the key of your AI service above' : 'optional';
  }
  showProvider();
}

const llmForm = () => ({
  provider: $('#llm-provider').value,
  api_key: $('#llm-key').value.trim(),
  base_url: $('#llm-url').value.trim(),
  chat_model: $('#llm-chat').value.trim(),
  eval_model: $('#llm-eval').value.trim(),
  whisper_service: $('#whisper-service').value,
  whisper_key: $('#whisper-key').value.trim(),
  whisper_model: $('#whisper-model').value.trim(),
});

const llmMessage = (text, ok) => $('#llm-result').replaceChildren(el('p', { class: `verdict ${ok ? 'pass' : 'fail'}` }, text));

async function loadLlm() {
  try { renderLlm(await api('/api/llm')); } catch (err) { showWarnings(err.message); }
}

async function lockButton(button, work) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try { await work(); } finally { button.disabled = false; button.textContent = label; }
}

$('#llm-provider').addEventListener('change', showProvider);
$('#llm-load').addEventListener('click', () => lockButton($('#llm-load'), async () => {
  try {
    const { models } = await api('/api/llm/models', llmForm());
    $('#llm-model-list').replaceChildren(...models.map((m) => el('option', { value: m })));
    llmMessage(`${models.length} models found. Click into a model box to choose one.`, true);
  } catch (err) {
    llmMessage(`Could not load the model list: ${err.message}`, false);
  }
}));
$('#llm-save').addEventListener('click', () => lockButton($('#llm-save'), async () => {
  let saved = false;
  try {
    renderLlm(await api('/api/llm', llmForm()));
    saved = true;
    useWhisper = (await api('/api/config')).whisper;
    const test = await api('/api/llm/test', {});
    llmMessage(`✓ ${test.provider} works. Conversation model answered in ${test.chat.seconds} s (“${test.chat.reply}”), scoring model in ${test.eval.seconds} s.`, true);
  } catch (err) {
    llmMessage(saved
      ? `Saved, but the test failed: ${err.message} The tutor will not work until this is fixed or you switch back to another service.`
      : `Not saved: ${err.message}`, false);
  }
}));

// ---------- mistakes (spaced repetition) ----------

let queue = [];

async function loadCards() {
  const { cards, today } = await api('/api/cards');
  queue = cards.filter((c) => c.due <= today);
  $('#cards-summary').textContent = `All saved mistakes (${cards.length})`;
  $('#cards-list').replaceChildren(...cards.map((c) => el('div', { class: 'card-row' },
    el('span', {}, el('span', { class: 'was' }, c.original), ' → ', el('span', { class: 'now' }, c.corrected),
      el('span', { class: 'muted' }, `  · next ${c.due}`)),
    el('button', { class: 'link', onclick: async () => { await api('/api/cards/delete', { id: c.id }); loadCards(); } }, 'delete'))));
  showCard();
  refreshStats();
}

function showCard() {
  const area = $('#card-area');
  const card = queue[0];
  if (!card) {
    area.replaceChildren(el('p', { class: 'muted' }, 'Nothing to review right now. Mistakes from your conversations and retellings appear here and come back after 1, 3, 7, 14 and 30 days.'));
    return;
  }
  const input = el('textarea', { rows: 2, placeholder: 'Say or type the correct version…' });
  const mic = el('button', { class: 'mic', title: 'Start / stop microphone' }, '🎤');
  const answer = el('div', { class: 'panel', hidden: true },
    el('div', { class: 'now' }, card.corrected, el('button', { class: 'link', onclick: () => speak(card.corrected) }, '🔊')),
    el('div', { class: 'muted' }, card.explanation));
  const grade = async (ok) => {
    await api('/api/cards/review', { id: card.id, ok });
    queue.shift();
    if (!ok) queue.push(card);
    showCard();
    refreshStats();
  };
  const reveal = () => { answer.hidden = false; buttons.hidden = false; speak(card.corrected); };
  const buttons = el('div', { class: 'row', hidden: true },
    el('button', { onclick: () => grade(false) }, 'Again'),
    el('button', { class: 'primary', onclick: () => grade(true) }, 'Got it'));
  area.replaceChildren(
    el('p', { class: 'muted' }, `${queue.length} to review`),
    el('p', {}, 'You said: ', el('span', { class: 'was' }, card.original)),
    el('div', { class: 'row answer' }, mic, input, el('button', { class: 'primary', onclick: reveal }, 'Show answer')),
    answer, buttons);
  attachMic(mic, input, reveal);
}

// ---------- start ----------

// Phones only let a page speak after the user has touched it once; this first touch unlocks the voice.
document.addEventListener('click', () => speechSynthesis.speak(new SpeechSynthesisUtterance('')), { once: true, capture: true });

window.addEventListener('error', (e) => micLog(`JS ERROR: ${e.message} (line ${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => micLog(`JS ERROR: ${(e.reason && e.reason.message) || e.reason}`));

speechSynthesis.addEventListener('voiceschanged', loadVoices);
loadVoices();
listMics();
api('/api/config').then(async (c) => {
  useWhisper = c.whisper;
  showWarnings();
  if (c.standalone) {
    $('#set-stt option[value=whisper]').textContent = 'Whisper (needs a key in Settings)';
    if (!c.configured) showTab('settings');
  }
  const permission = await navigator.permissions.query({ name: 'microphone' }).then((p) => p.state, () => 'unknown');
  micLog(`page loaded: whisper=${useWhisper} permission=${permission} mics=[${[...$('#set-mic').options].map((o) => o.textContent).join(' | ')}] browser=${navigator.userAgent.split(' ').slice(-2).join(' ')}`);
}).catch(() => {});
renderListening();
refreshStats();
