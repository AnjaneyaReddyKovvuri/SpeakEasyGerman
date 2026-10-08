'use strict';

// Standalone engine: everything server.py does, done in the browser, so the app also works as a plain
// static site (e.g. GitHub Pages) with no computer behind it. app.js uses it when no server answers.
// The tutor is an AI service called directly with the learner's own API key; data lives in localStorage.
const Standalone = (() => {
  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(`st.${key}`)) ?? fallback; } catch { return fallback; }
  };
  const write = (key, value) => localStorage.setItem(`st.${key}`, JSON.stringify(value));
  const day = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };

  // ---------- AI services ----------

  const PROVIDERS = {
    gemini: { label: 'Google Gemini', kind: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta',
      note: 'Has a free tier. Create an API key at aistudio.google.com.' },
    groq: { label: 'Groq', kind: 'openai', base_url: 'https://api.groq.com/openai/v1',
      note: 'Has a free tier, and the same key can also do speech recognition (Whisper). Create an API key at console.groq.com.' },
    openrouter: { label: 'OpenRouter', kind: 'openai', base_url: 'https://openrouter.ai/api/v1',
      note: 'One key for many models, some of them free. Create an API key at openrouter.ai.' },
    openai: { label: 'OpenAI', kind: 'openai', base_url: 'https://api.openai.com/v1',
      note: 'Pay per use. The same key can also do speech recognition (Whisper). Create an API key at platform.openai.com.' },
    anthropic: { label: 'Claude API (Anthropic)', kind: 'anthropic', base_url: '',
      note: 'Pay per use. Create an API key at platform.claude.com.', chat_model: 'claude-opus-5-5', eval_model: 'claude-opus-5-5' },
    custom: { label: 'Other (OpenAI-compatible)', kind: 'openai', base_url: '',
      note: 'Any server with an OpenAI-compatible API that allows access from a browser.' },
  };
  const WHISPER = {
    groq: { base_url: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
    openai: { base_url: 'https://api.openai.com/v1', model: 'whisper-1' },
  };

  function config() {
    const cfg = read('config', {});
    if (!PROVIDERS[cfg.provider]) cfg.provider = 'gemini';
    cfg.settings ??= {};
    cfg.whisper ??= {};
    return cfg;
  }

  function providerSettings(cfg, id) {
    const preset = PROVIDERS[id];
    const saved = Object.fromEntries(Object.entries(cfg.settings[id] || {}).filter(([, v]) => v));
    return { api_key: '', base_url: preset.base_url, chat_model: preset.chat_model || '', eval_model: preset.eval_model || '', ...saved };
  }

  async function httpJson(url, headers, payload) {
    let res;
    try {
      res = await fetch(url, payload === undefined ? { headers } : {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload),
      });
    } catch {
      throw new Error(`Could not reach ${url.split('/')[2] || url}. Check the internet connection and the server address.`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`The AI service answered with error ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    try { return JSON.parse(text); } catch { throw new Error('The AI service did not answer with JSON. Check the server address.'); }
  }
  const bearer = (key) => (key ? { Authorization: `Bearer ${key}` } : {});

  async function anthropicClient(settings) {
    // Official SDK, loaded only when the Claude API is chosen. The key stays in this browser.
    const { default: Anthropic } = await import('https://esm.sh/@anthropic-ai/sdk');
    return [Anthropic, new Anthropic({ apiKey: settings.api_key, dangerouslyAllowBrowser: true })];
  }

  async function askAnthropic(settings, model, system, prompt, role) {
    const [Anthropic, client] = await anthropicClient(settings);
    const request = { model, max_tokens: 16000, system, messages: [{ role: 'user', content: prompt }] };
    let response;
    try {
      try {
        // Low effort keeps the conversation quick; scoring and texts get more care. If the model
        // declines a request, the server-side fallback reruns it on another Claude model.
        response = await client.beta.messages.create({
          ...request, output_config: { effort: role === 'chat' ? 'low' : 'medium' },
          betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        });
      } catch (err) {
        if (!(err instanceof Anthropic.BadRequestError)) throw err;
        response = await client.messages.create(request);  // models without effort or fallbacks (e.g. Haiku)
      }
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('The Claude API key was rejected. Check it in Settings.');
      if (err instanceof Anthropic.NotFoundError) throw new Error(`The Claude API does not know the model “${model}”. Pick another in Settings.`);
      if (err instanceof Anthropic.RateLimitError) throw new Error('The Claude API rate limit was reached. Wait a moment and try again.');
      if (err instanceof Anthropic.APIConnectionError) throw new Error('Could not reach the Claude API. Check the internet connection.');
      if (err instanceof Anthropic.APIError) throw new Error(`Claude API error ${err.status}: ${err.message}`.slice(0, 400));
      throw err;
    }
    if (response.stop_reason === 'refusal') throw new Error('The model declined this request. Try rephrasing.');
    return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  // role is "chat" (live conversation: fast) or "eval" (texts, scoring, pronunciation: careful).
  async function askLlm(system, prompt, role) {
    const cfg = config();
    const provider = PROVIDERS[cfg.provider];
    const settings = providerSettings(cfg, cfg.provider);
    if (!settings.api_key && cfg.provider !== 'custom') throw new Error(`No API key for ${provider.label} yet. Open the Settings tab and add one.`);
    const model = role === 'chat' ? settings.chat_model : settings.eval_model || settings.chat_model;
    if (!model) throw new Error(`No model is chosen for ${provider.label}. Open Settings and pick one.`);
    if (provider.kind === 'anthropic') return askAnthropic(settings, model, system, prompt, role);
    const base = settings.base_url.replace(/\/+$/, '');
    let text;
    if (provider.kind === 'gemini') {
      const out = await httpJson(`${base}/models/${model}:generateContent`, { 'x-goog-api-key': settings.api_key }, {
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
      const parts = out.candidates?.[0]?.content?.parts;
      if (!parts) throw new Error(`Gemini gave no answer (${out.candidates?.[0]?.finishReason || out.promptFeedback?.blockReason || 'unknown reason'}).`);
      text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
    } else {
      const out = await httpJson(`${base}/chat/completions`, bearer(settings.api_key), {
        model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      });
      text = out.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error(`Unexpected answer from the AI service: ${JSON.stringify(out).slice(0, 300)}`);
    }
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();  // some models print their reasoning
  }

  async function askJson(system, prompt, role) {
    const text = await askLlm(system, prompt, role);
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    try {
      if (start < 0 || end < 0) throw new Error();
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error('The tutor returned an unexpected answer. Try again.');
    }
  }

  async function listModels(body) {
    const id = body.provider;
    const settings = { ...providerSettings(config(), id), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v)) };
    const base = (settings.base_url || '').replace(/\/+$/, '');
    if (PROVIDERS[id].kind === 'anthropic') {
      const [, client] = await anthropicClient(settings);
      const models = [];
      for await (const m of client.models.list()) models.push(m.id);
      return { models };
    }
    if (PROVIDERS[id].kind === 'gemini') {
      const out = await httpJson(`${base}/models?pageSize=200`, { 'x-goog-api-key': settings.api_key });
      return { models: (out.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace('models/', '')).sort() };
    }
    const out = await httpJson(`${base}/models`, bearer(settings.api_key));
    return { models: (out.data || []).map((m) => m.id).filter(Boolean).sort() };
  }

  function whisperSettings() {
    const cfg = config();
    const service = WHISPER[cfg.whisper.service] ? cfg.whisper.service : ['groq', 'openai'].find((s) => cfg.settings[s]?.api_key) || 'groq';
    const key = cfg.whisper.api_key || cfg.settings[service]?.api_key;
    return key ? { service, key, model: cfg.whisper.model || WHISPER[service].model, base: WHISPER[service].base_url } : null;
  }

  function llmView() {
    const cfg = config();
    const settings = {};
    for (const id of Object.keys(PROVIDERS)) {
      const s = providerSettings(cfg, id);
      settings[id] = { base_url: s.base_url, chat_model: s.chat_model, eval_model: s.eval_model, has_key: !!s.api_key, key_hint: s.api_key.slice(-4) };
    }
    return {
      provider: cfg.provider,
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, note: p.note, kind: p.kind, available: true })),
      settings,
      whisper: { service: cfg.whisper.service || 'groq', model: cfg.whisper.model || '', has_key: !!cfg.whisper.api_key, key_hint: (cfg.whisper.api_key || '').slice(-4), active: !!whisperSettings() },
    };
  }

  function llmSave(body) {
    if (!PROVIDERS[body.provider]) throw new Error('Unknown AI service.');
    const cfg = config();
    const settings = providerSettings(cfg, body.provider);
    for (const key of ['api_key', 'base_url', 'chat_model', 'eval_model']) if ((body[key] || '').trim()) settings[key] = body[key].trim();
    cfg.provider = body.provider;
    cfg.settings[body.provider] = settings;
    if (body.whisper_service) cfg.whisper.service = body.whisper_service;
    if ((body.whisper_key || '').trim()) cfg.whisper.api_key = body.whisper_key.trim();
    cfg.whisper.model = (body.whisper_model || '').trim();
    write('config', cfg);
    return llmView();
  }

  async function llmTest() {
    const result = { provider: PROVIDERS[config().provider].label };
    for (const role of ['chat', 'eval']) {
      const started = Date.now();
      const reply = await askLlm('You are a German tutor. Answer with one short German sentence.', 'Sag Hallo.', role);
      result[role] = { reply: reply.trim().slice(0, 200), seconds: Math.round((Date.now() - started) / 100) / 10 };
    }
    return result;
  }

  // ---------- speech to text (hosted Whisper) ----------

  async function transcribe(blob, context, withWords) {
    const w = whisperSettings();
    if (!w) throw new Error('No Whisper key yet. Add one under Settings, or set “Speech” to “Browser”.');
    const form = new FormData();
    const extension = (blob.type.match(/audio\/(\w+)/) || [])[1] || 'webm';
    form.append('file', blob, `speech.${extension}`);
    form.append('model', w.model);
    form.append('language', 'de');
    if (context) form.append('prompt', context.slice(0, 500));  // tells Whisper which words to expect
    if (withWords) {
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
    }
    let res;
    try {
      res = await fetch(`${w.base}/audio/transcriptions`, { method: 'POST', headers: bearer(w.key), body: form });
    } catch {
      throw new Error('Could not reach the speech recognition service. Check the internet connection.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Speech recognition error ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    const out = { text: (data.text || '').trim() };
    // Hosted Whisper gives no per-word confidence, so every heard word counts as clear.
    if (withWords) out.words = (data.words || out.text.split(/\s+/).filter(Boolean).map((word) => ({ word }))).map((x) => ({ word: x.word.trim(), prob: 1 }));
    return out;
  }

  // ---------- storage: mistakes and statistics ----------

  const INTERVALS = [0, 1, 3, 7, 14, 30];  // days until a card comes back, by Leitner box (1-5)

  function bump(key) {
    const stats = read('stats', {});
    stats[day()] ??= {};
    stats[day()][key] = (stats[day()][key] || 0) + 1;
    write('stats', stats);
  }

  function addCards(corrections, source) {
    const cards = read('cards', []);
    const seen = new Set(cards.map((c) => `${c.original}|${c.corrected}`));
    for (const c of corrections) {
      const original = String(c.original || '').trim(), corrected = String(c.corrected || '').trim();
      if (!original || !corrected || seen.has(`${original}|${corrected}`)) continue;
      seen.add(`${original}|${corrected}`);
      cards.push({ id: Math.random().toString(36).slice(2, 12), original, corrected, explanation: String(c.explanation || '').trim(), source, box: 1, due: day(), created: day() });
    }
    write('cards', cards);
  }

  function statsSummary() {
    const stats = read('stats', {});
    let streak = 0, offset = stats[day()] ? 0 : -1;  // today not practised yet doesn't break the streak
    while (stats[day(offset)]) { streak++; offset--; }
    return { streak, today: stats[day()] || {}, days: Object.keys(stats).length, due: read('cards', []).filter((c) => c.due <= day()).length };
  }

  function reviewCard({ id, ok }) {
    const cards = read('cards', []);
    for (const c of cards) {
      if (c.id !== id) continue;
      c.box = ok ? Math.min(c.box + 1, 5) : 1;
      c.due = day(ok ? INTERVALS[c.box] : 0);
    }
    write('cards', cards);
    bump('reviews');
    return { ok: true };
  }

  // ---------- tutor prompts (keep in step with server.py) ----------

  // How German aimed at each CEFR level should sound, and the level the learner is working towards.
  const LEVELS = {
    A1: ['A2', 'Very short, simple main clauses in the present tense. Only the most common everyday words. Concrete topics. One idea per sentence.'],
    A2: ['B1', 'Short, simple sentences with common vocabulary. Present and Perfekt, modal verbs, simple connectors (und, aber, weil, dann). Familiar everyday and basic work topics.'],
    B1: ['B2', 'Clear standard German on familiar work and everyday topics. Some subordinate clauses and common fixed expressions, no rare idioms.'],
    B2: ['C1', 'Natural German at normal complexity: subordinate clauses, Konjunktiv II, passive, common idioms, abstract and professional topics.'],
    C1: ['C2', 'Fully natural, idiomatic and nuanced German with complex structures, precise professional vocabulary and varied register.'],
    C2: ['C2', 'Native-level German: sophisticated, subtle and idiomatic, with nominal style, colloquialisms, irony and rhetorical devices where they fit.'],
  };
  const levelInfo = (body) => {
    const level = LEVELS[body.level] ? body.level : 'B1';
    return [level, ...LEVELS[level]];
  };
  const LENGTHS = { short: 90, medium: 160, long: 260 };

  const correctionRules = (explain) => 'The learner\'s text comes from speech recognition, so ignore punctuation, '
    + 'capitalisation and spelling. Only report real language errors: grammar, case, gender, word order, '
    + 'verb forms, prepositions, wrong or unnatural word choice. Quote the faulty phrase exactly as the '
    + 'learner said it (a short phrase, not the whole sentence) and give the corrected phrase. '
    + `Write explanations in ${explain}, one short sentence each.`;

  // Drops "corrections" that only change capitalisation or punctuation (speech input has neither).
  const plain = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const realCorrections = (list) => (Array.isArray(list) ? list : []).filter((c) => c && plain(c.original) !== plain(c.corrected));

  async function chat(body) {
    const [level, target, style] = levelInfo(body);
    const explain = body.explain || 'English';
    const history = body.history || [];
    const system = `You are Lena, a friendly German colleague and conversation partner. You are helping a learner (currently ${level}, working towards ${target}) improve their German for working life in Germany.

German at the learner's level ${level}: ${style}

Scenario: ${body.scenario || 'Small talk with a colleague'}

Your reply ("reply"):
- Only German, natural spoken language, as it is really used at work.
- 1 to 3 sentences that a ${level} learner can follow, stretching them only slightly, then a question or prompt that makes them speak at length. Stay in role. Never correct or comment on their German inside the reply.

Separately, review ONLY the learner's last message ("corrections", at most 3, most important first). ${correctionRules(explain)}
"better": how a good ${target} speaker would say the learner's whole last message, keeping their meaning: a realistic next step for them, not native-level polish. Use an empty string if there is no learner message yet.
"reply_en": a natural English translation of your reply.

Answer with JSON only:
{"reply": "...", "reply_en": "...", "corrections": [{"original": "...", "corrected": "...", "explanation": "..."}], "better": "..."}`;
    const prompt = history.length
      ? history.map((t) => (t.role === 'tutor' ? 'Lena: ' : 'Learner: ') + t.text).join('\n')
      : '(No messages yet. Greet the learner and open the scenario.)';
    const out = await askJson(system, prompt, 'chat');
    const corrections = realCorrections(out.corrections);
    if (history.length) {
      addCards(corrections, 'conversation');
      bump('turns');
    }
    return { reply: out.reply || '', reply_en: out.reply_en || '', corrections, better: out.better || '' };
  }

  async function translate(body) {
    const system = 'Translate the German text into natural English. Keep the tone and register. Output only the translation, nothing else.';
    return { en: (await askLlm(system, String(body.text || '').slice(0, 4000), 'chat')).trim() };
  }

  function listen(body) {
    const [level, target, style] = levelInfo(body);
    const words = LENGTHS[body.length] || LENGTHS.medium;
    const system = `You write listening practice for a German learner (currently ${level}, working towards ${target}) who wants to use German in working life in Germany. Write a monologue of about ${words} words meant to be HEARD, not read: one speaker, natural spoken German (a voicemail, a meeting update, a podcast segment, a briefing, a short talk). German at the learner's level ${level}: ${style} Pitch the text at that level, stretching the learner only slightly, with useful workplace vocabulary. No headings, lists, abbreviations or digits that are awkward to read aloud.

Answer with JSON only:
{"title": "short German title", "text": "the monologue",
"questions": ["three comprehension questions in German"],
"vocab": [{"de": "word or phrase from the text", "en": "English meaning"}]}
Give 5 to 7 vocab items, choosing the ones a ${level} learner is least likely to know.`;
    return askJson(system, `Topic: ${body.topic || 'a typical situation at work'}`, 'eval');
  }

  function pronounce(body) {
    const system = `You are a German pronunciation coach for a learner who reads English. For every word of the German text, in order, give:
"word": the word as written, without punctuation.
"ipa": standard German pronunciation in IPA, with the stress mark.
"say": a respelling a reader of English can sound out: syllables separated by hyphens, the stressed syllable in CAPITALS, e.g. Entscheidung = "ent-SHY-doong", Büro = "bue-ROH", ich = "ikh".
"tip": at most 12 words in ${body.explain || 'English'} about the hardest sound in this word for a foreign speaker, or "" if nothing is tricky. Do not repeat the same tip for later words.

Answer with JSON only: {"words": [{"word": "...", "ipa": "...", "say": "...", "tip": "..."}]}`;
    return askJson(system, String(body.text || '').slice(0, 600), 'eval');
  }

  async function retell(body) {
    const [level, target] = levelInfo(body);
    const explain = body.explain || 'English';
    const system = `You assess a German learner (currently ${level}, working towards ${target}) who listened to a text and retold it aloud from memory. Judge the retelling against the original.

Score against what is expected at ${target}, not against a native speaker. Scores from 1 to 5: "content" (main points covered and correct), "grammar", "vocabulary" (range and precision). "level": the CEFR level this retelling shows, e.g. "B1+".
"feedback": 2 or 3 sentences in ${explain}: what was good and the single most useful thing to work on.
"missed": important points from the original that are missing or wrong, in ${explain} (may be empty).
"corrections": at most 5. ${correctionRules(explain)}
"model": a model retelling in German, 3 to 5 sentences, at ${target} level, that the learner can imitate.

Answer with JSON only:
{"content": 3, "grammar": 3, "vocabulary": 3, "level": "B1+", "feedback": "...", "missed": ["..."],
"corrections": [{"original": "...", "corrected": "...", "explanation": "..."}], "model": "..."}`;
    const out = await askJson(system, `ORIGINAL TEXT:\n${body.text || ''}\n\nLEARNER'S RETELLING:\n${body.retelling || ''}`, 'eval');
    out.corrections = realCorrections(out.corrections);
    addCards(out.corrections, 'retelling');
    bump('retells');
    return out;
  }

  // ---------- the same routes the Python server offers ----------

  const ROUTES = {
    '/api/config': () => ({ whisper: !!whisperSettings(), standalone: true, configured: !!providerSettings(config(), config().provider).api_key }),
    '/api/chat': chat,
    '/api/listen': listen,
    '/api/retell': retell,
    '/api/translate': translate,
    '/api/pronounce': pronounce,
    '/api/cards': () => ({ cards: read('cards', []), today: day() }),
    '/api/cards/review': reviewCard,
    '/api/cards/delete': ({ id }) => { write('cards', read('cards', []).filter((c) => c.id !== id)); return { ok: true }; },
    '/api/stats': statsSummary,
    '/api/log': ({ key }) => { if (key === 'shadow' || key === 'pron') bump(key); return { ok: true }; },
    '/api/llm': (body) => (body ? llmSave(body) : llmView()),
    '/api/llm/models': listModels,
    '/api/llm/test': llmTest,
  };

  return {
    route: async (path, body) => ROUTES[path](body),
    transcribe,
  };
})();
