#!/usr/bin/env python3
"""Sprechtraining - local German listening & speaking trainer.

The browser records your voice and speaks German; Whisper (in .venv) turns your
speech into text on this machine; the tutor runs through the local `claude` CLI or
another AI service chosen on the Settings tab.
The page in docs/ also runs without this server (see docs/backend.js), e.g. on GitHub Pages.
Without .venv the app still works and falls back to the browser's speech recognition.

Run:  python3 server.py   then open http://localhost:8765
"""
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import tempfile
import threading
import uuid
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).parent
STATIC = ROOT / "docs"  # named "docs" so GitHub Pages can publish the same files as a standalone app
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
CARDS_FILE = DATA / "cards.json"
STATS_FILE = DATA / "stats.json"
CONFIG_FILE = DATA / "config.json"

# Whisper lives in the project's own environment; switch to it if we were started with system Python.
VENV_PYTHON = ROOT / ".venv" / "bin" / "python"
try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None
    if VENV_PYTHON.exists() and not os.environ.get("SPRECHTRAINING_IN_VENV"):
        os.environ["SPRECHTRAINING_IN_VENV"] = "1"
        os.execv(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv])

try:
    import anthropic  # official SDK, used when the Claude API is chosen as the tutor
except ImportError:
    anthropic = None

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))
# Models for the "Claude account on this laptop" provider; other providers are set on the Settings tab.
CHAT_MODEL = os.environ.get("CHAT_MODEL", "sonnet")  # catches more errors than haiku at similar speed
EVAL_MODEL = os.environ.get("EVAL_MODEL", "sonnet")  # more careful, for texts and scoring

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")  # ~4s for 20s of speech on this CPU

# Days until a card comes back, by Leitner box (1-5).
INTERVALS = [0, 1, 3, 7, 14, 30]
LENGTHS = {"short": 90, "medium": 160, "long": 260}

# How German aimed at each CEFR level should sound, and the level the learner is working towards.
LEVELS = {
    "A1": ("A2", "Very short, simple main clauses in the present tense. Only the most common everyday "
                 "words. Concrete topics. One idea per sentence."),
    "A2": ("B1", "Short, simple sentences with common vocabulary. Present and Perfekt, modal verbs, "
                 "simple connectors (und, aber, weil, dann). Familiar everyday and basic work topics."),
    "B1": ("B2", "Clear standard German on familiar work and everyday topics. Some subordinate clauses "
                 "and common fixed expressions, no rare idioms."),
    "B2": ("C1", "Natural German at normal complexity: subordinate clauses, Konjunktiv II, passive, "
                 "common idioms, abstract and professional topics."),
    "C1": ("C2", "Fully natural, idiomatic and nuanced German with complex structures, precise "
                 "professional vocabulary and varied register."),
    "C2": ("C2", "Native-level German: sophisticated, subtle and idiomatic, with nominal style, "
                 "colloquialisms, irony and rhetorical devices where they fit."),
}


def level_info(body):
    """Returns (level, next level, description of German at that level)."""
    level = body.get("level") if body.get("level") in LEVELS else "B1"
    return (level, *LEVELS[level])


LOCK = threading.Lock()
LLM_CWD = tempfile.mkdtemp(prefix="sprechtraining-")


# ---------- storage ----------

def load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(path, obj):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def today():
    return date.today().isoformat()


def bump(key, n=1):
    with LOCK:
        stats = load(STATS_FILE, {})
        day = stats.setdefault(today(), {})
        day[key] = day.get(key, 0) + n
        save(STATS_FILE, stats)


def add_cards(corrections, source):
    with LOCK:
        cards = load(CARDS_FILE, [])
        seen = {(c["original"], c["corrected"]) for c in cards}
        for c in corrections:
            original = str(c.get("original", "")).strip()
            corrected = str(c.get("corrected", "")).strip()
            if not original or not corrected or (original, corrected) in seen:
                continue
            seen.add((original, corrected))
            cards.append({
                "id": uuid.uuid4().hex[:10],
                "original": original,
                "corrected": corrected,
                "explanation": str(c.get("explanation", "")).strip(),
                "source": source,
                "box": 1,
                "due": today(),
                "created": today(),
            })
        save(CARDS_FILE, cards)


def stats_summary():
    stats = load(STATS_FILE, {})
    streak, day = 0, date.today()
    if day.isoformat() not in stats:
        day -= timedelta(days=1)  # today not practised yet doesn't break the streak
    while day.isoformat() in stats:
        streak += 1
        day -= timedelta(days=1)
    due = sum(1 for c in load(CARDS_FILE, []) if c["due"] <= today())
    return {"streak": streak, "today": stats.get(today(), {}), "days": len(stats), "due": due}


# ---------- AI providers ----------

# The tutor can run on different AI services; the choice is made on the Settings tab and kept in
# data/config.json. "openai" kind = any service that speaks the OpenAI chat-completions format.
PROVIDERS = {
    "claude-cli": {"label": "Claude account on this laptop", "kind": "cli",
                   "note": "Uses the Claude login on this laptop. No key needed."},
    "anthropic": {"label": "Claude API (Anthropic)", "kind": "anthropic",
                  "note": "Pay per use. Create an API key at platform.claude.com.",
                  "chat_model": "claude-opus-5-5", "eval_model": "claude-opus-5-5"},
    "gemini": {"label": "Google Gemini", "kind": "openai",
               "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
               "note": "Has a free tier. Create an API key at aistudio.google.com."},
    "groq": {"label": "Groq", "kind": "openai", "base_url": "https://api.groq.com/openai/v1",
             "note": "Has a free tier. Create an API key at console.groq.com."},
    "openai": {"label": "OpenAI", "kind": "openai", "base_url": "https://api.openai.com/v1",
               "note": "Pay per use. Create an API key at platform.openai.com."},
    "openrouter": {"label": "OpenRouter", "kind": "openai", "base_url": "https://openrouter.ai/api/v1",
                   "note": "One key for many models, some of them free. Create an API key at openrouter.ai."},
    "custom": {"label": "Other (OpenAI-compatible, e.g. Ollama)", "kind": "openai", "base_url": "",
               "note": "Any server with an OpenAI-compatible API. For Ollama on this laptop the address "
                       "is http://localhost:11434/v1 and no key is needed."},
}


def read_config():
    cfg = load(CONFIG_FILE, {})
    if cfg.get("provider") not in PROVIDERS:
        cfg["provider"] = "claude-cli"
    cfg.setdefault("settings", {})
    return cfg


def provider_settings(cfg, provider):
    preset = PROVIDERS[provider]
    defaults = {"api_key": "", "base_url": preset.get("base_url", ""),
                "chat_model": preset.get("chat_model", ""), "eval_model": preset.get("eval_model", "")}
    return {**defaults, **{k: v for k, v in cfg["settings"].get(provider, {}).items() if v}}


def ask_llm(system, prompt, role, think=True):
    """role is "chat" (live conversation: fast) or "eval" (texts, scoring, pronunciation: careful)."""
    cfg = read_config()
    provider = cfg["provider"]
    settings = provider_settings(cfg, provider)
    kind = PROVIDERS[provider]["kind"]
    if kind == "cli":
        return ask_cli(system, prompt, CHAT_MODEL if role == "chat" else EVAL_MODEL, think)
    model = settings["chat_model"] if role == "chat" else settings["eval_model"] or settings["chat_model"]
    if not model:
        raise RuntimeError(f"No model is chosen for {PROVIDERS[provider]['label']}. Open Settings and pick one.")
    if kind == "anthropic":
        return ask_anthropic(settings, model, system, prompt, role)
    return ask_openai_compatible(settings, model, system, prompt)


def anthropic_client(settings):
    if anthropic is None:
        raise RuntimeError("The Claude API needs the `anthropic` package, which is not installed in .venv.")
    # Without a key from Settings the SDK looks for credentials in the environment itself.
    return anthropic.Anthropic(api_key=settings["api_key"]) if settings["api_key"] else anthropic.Anthropic()


def ask_anthropic(settings, model, system, prompt, role):
    client = anthropic_client(settings)
    request = dict(model=model, max_tokens=16000, system=system,
                   messages=[{"role": "user", "content": prompt}])
    try:
        try:
            # Low effort keeps the conversation quick; scoring and texts get more care. If the model
            # declines a request, the server-side fallback reruns it on another Claude model.
            response = client.beta.messages.create(
                **request, output_config={"effort": "low" if role == "chat" else "medium"},
                betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        except anthropic.BadRequestError:
            # Models that do not take effort or fallbacks (e.g. Haiku) get the plain request.
            response = client.messages.create(**request)
    except anthropic.AuthenticationError:
        raise RuntimeError("The Claude API key was rejected. Check it in Settings.")
    except anthropic.PermissionDeniedError:
        raise RuntimeError("This Claude API key is not allowed to use that model.")
    except anthropic.NotFoundError:
        raise RuntimeError(f"The Claude API does not know the model “{model}”. Pick another in Settings.")
    except anthropic.RateLimitError:
        raise RuntimeError("The Claude API rate limit was reached. Wait a moment and try again.")
    except anthropic.APIStatusError as e:
        raise RuntimeError(f"Claude API error {e.status_code}: {e.message}"[:400])
    except anthropic.APIConnectionError:
        raise RuntimeError("Could not reach the Claude API. Check the internet connection.")
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined this request. Try rephrasing.")
    return "".join(block.text for block in response.content if block.type == "text")


def http_json(url, api_key, payload=None):
    if not url.startswith(("http://", "https://")):
        raise RuntimeError("The server address must start with http:// or https://.")
    headers = {"Content-Type": "application/json", "User-Agent": "sprechtraining/1.0"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=180) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = " ".join(e.read().decode("utf-8", "replace").split())[:300]
        raise RuntimeError(f"The AI service answered with error {e.code}: {detail}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"Could not reach {url}: {getattr(e, 'reason', e)}")
    except json.JSONDecodeError:
        raise RuntimeError(f"{url} did not answer with JSON. Check the server address.")


def ask_openai_compatible(settings, model, system, prompt):
    out = http_json(settings["base_url"].rstrip("/") + "/chat/completions", settings["api_key"], {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
    })
    try:
        text = out["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise RuntimeError(f"Unexpected answer from the AI service: {json.dumps(out)[:300]}")
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()  # some models print their reasoning


def llm_view(_body=None):
    """The provider settings as the Settings tab shows them. API keys never leave the server."""
    cfg = read_config()
    settings = {}
    for pid in PROVIDERS:
        s = provider_settings(cfg, pid)
        settings[pid] = {"base_url": s["base_url"], "chat_model": s["chat_model"], "eval_model": s["eval_model"],
                         "has_key": bool(s["api_key"]), "key_hint": s["api_key"][-4:]}
    providers = [{"id": pid, "label": p["label"], "note": p["note"], "kind": p["kind"],
                  "available": p["kind"] != "anthropic" or anthropic is not None} for pid, p in PROVIDERS.items()]
    return {"provider": cfg["provider"], "providers": providers, "settings": settings}


def merged_settings(body):
    """Stored settings for the provider in the request, overridden by any non-empty fields sent with it."""
    provider = body.get("provider")
    if provider not in PROVIDERS:
        raise RuntimeError("Unknown AI provider.")
    settings = provider_settings(read_config(), provider)
    for key in ("api_key", "base_url", "chat_model", "eval_model"):
        if str(body.get(key) or "").strip():
            settings[key] = str(body[key]).strip()
    return provider, settings


def llm_save(body):
    with LOCK:
        provider, settings = merged_settings(body)
        cfg = read_config()
        cfg["provider"] = provider
        cfg["settings"][provider] = settings
        save(CONFIG_FILE, cfg)
        CONFIG_FILE.chmod(0o600)  # it holds API keys
    return llm_view()


def llm_models(body):
    provider, settings = merged_settings(body)
    kind = PROVIDERS[provider]["kind"]
    if kind == "cli":
        return {"models": []}
    if kind == "anthropic":
        try:
            return {"models": [m.id for m in anthropic_client(settings).models.list()]}
        except anthropic.AuthenticationError:
            raise RuntimeError("The Claude API key was rejected.")
        except anthropic.APIError as e:
            raise RuntimeError(f"Could not load the Claude model list: {e}"[:300])
    out = http_json(settings["base_url"].rstrip("/") + "/models", settings["api_key"])
    return {"models": sorted(str(m.get("id", "")).removeprefix("models/") for m in out.get("data", []) if m.get("id"))}


def llm_test(_body=None):
    cfg = read_config()
    result = {"provider": PROVIDERS[cfg["provider"]]["label"]}
    for role in ("chat", "eval"):
        started = time.time()
        reply = ask_llm("You are a German tutor. Answer with one short German sentence.", "Sag Hallo.", role, think=False)
        result[role] = {"reply": reply.strip()[:200], "seconds": round(time.time() - started, 1)}
    return result


# ---------- tutor ----------

def ask_cli(system, prompt, model, think=True):
    # Live conversation skips extended thinking: replies come back in ~3s instead of ~8s.
    env = os.environ if think else {**os.environ, "MAX_THINKING_TOKENS": "0"}
    cmd = [
        "claude", "-p", "--model", model, "--system-prompt", system,
        "--tools", "", "--strict-mcp-config", "--disable-slash-commands",
        "--no-session-persistence", "--setting-sources", "", "--output-format", "json",
    ]
    try:
        run = subprocess.run(cmd, input=prompt, capture_output=True, text=True,
                             timeout=180, cwd=LLM_CWD, env=env)
    except FileNotFoundError:
        raise RuntimeError("The `claude` command was not found on PATH.")
    except subprocess.TimeoutExpired:
        raise RuntimeError("The tutor took too long to answer. Try again.")
    try:
        out = json.loads(run.stdout)
    except json.JSONDecodeError:
        raise RuntimeError((run.stderr or run.stdout or "No output from claude").strip()[:400])
    if out.get("is_error"):
        raise RuntimeError(str(out.get("result", "Tutor error"))[:400])
    return out.get("result", "")


def ask_json(system, prompt, role, think=True):
    text = ask_llm(system, prompt, role, think)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise RuntimeError("The tutor returned an unexpected answer. Try again.")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        raise RuntimeError("The tutor returned an unexpected answer. Try again.")


CORRECTION_RULES = """The learner's text comes from speech recognition, so ignore punctuation, \
capitalisation and spelling. Only report real language errors: grammar, case, gender, word order, \
verb forms, prepositions, wrong or unnatural word choice. Quote the faulty phrase exactly as the \
learner said it (a short phrase, not the whole sentence) and give the corrected phrase. \
Write explanations in {explain}, one short sentence each."""


def plain(text):
    return "".join(ch for ch in str(text).lower() if ch.isalnum())


def real_corrections(corrections):
    """Drop 'corrections' that only change capitalisation or punctuation (speech input has neither)."""
    return [c for c in corrections or []
            if isinstance(c, dict) and plain(c.get("original")) != plain(c.get("corrected"))]


def chat(body):
    level, target, style = level_info(body)
    explain = body.get("explain", "English")
    history = body.get("history", [])
    system = f"""You are Lena, a friendly German colleague and conversation partner. You are helping \
a learner (currently {level}, working towards {target}) improve their German for working life in Germany.

German at the learner's level {level}: {style}

Scenario: {body.get("scenario", "Small talk with a colleague")}

Your reply ("reply"):
- Only German, natural spoken language, as it is really used at work.
- 1 to 3 sentences that a {level} learner can follow, stretching them only slightly, then a question or prompt that makes them \
speak at length. Stay in role. Never correct or comment on their German inside the reply.

Separately, review ONLY the learner's last message ("corrections", at most 3, most important first). \
{CORRECTION_RULES.format(explain=explain)}
"better": how a good {target} speaker would say the learner's whole last message, keeping their meaning: \
a realistic next step for them, not native-level polish. \
Use an empty string if there is no learner message yet.
"reply_en": a natural English translation of your reply.

Answer with JSON only:
{{"reply": "...", "reply_en": "...", "corrections": [{{"original": "...", "corrected": "...", "explanation": "..."}}], "better": "..."}}"""
    if history:
        lines = [("Lena: " if t["role"] == "tutor" else "Learner: ") + t["text"] for t in history]
        prompt = "\n".join(lines)
    else:
        prompt = "(No messages yet. Greet the learner and open the scenario.)"
    out = ask_json(system, prompt, "chat", think=False)
    corrections = real_corrections(out.get("corrections"))
    if history:
        add_cards(corrections, "conversation")
        bump("turns")
    return {"reply": out.get("reply", ""), "reply_en": out.get("reply_en", ""),
            "corrections": corrections, "better": out.get("better", "")}


def translate(body):
    system = ("Translate the German text into natural English. Keep the tone and register. "
              "Output only the translation, nothing else.")
    return {"en": ask_llm(system, str(body.get("text", ""))[:4000], "chat", think=False).strip()}


def listen(body):
    level, target, style = level_info(body)
    words = LENGTHS.get(body.get("length"), LENGTHS["medium"])
    system = f"""You write listening practice for a German learner (currently {level}, working towards \
{target}) who wants to use German in working life in Germany. Write a monologue of about {words} words meant to be HEARD, \
not read: one speaker, natural spoken German (a voicemail, a meeting update, a podcast segment, a \
briefing, a short talk). German at the learner's level {level}: {style} Pitch the text at that level, \
stretching the learner only slightly, with useful workplace vocabulary. No headings, lists, abbreviations or digits that are awkward to read aloud.

Answer with JSON only:
{{"title": "short German title", "text": "the monologue",
"questions": ["three comprehension questions in German"],
"vocab": [{{"de": "word or phrase from the text", "en": "English meaning"}}]}}
Give 5 to 7 vocab items, choosing the ones a {level} learner is least likely to know."""
    topic = body.get("topic") or "a typical situation at work"
    return ask_json(system, f"Topic: {topic}", "eval")


def pronounce(body):
    explain = body.get("explain", "English")
    system = f"""You are a German pronunciation coach for a learner who reads English. For every word of \
the German text, in order, give:
"word": the word as written, without punctuation.
"ipa": standard German pronunciation in IPA, with the stress mark.
"say": a respelling a reader of English can sound out: syllables separated by hyphens, the stressed \
syllable in CAPITALS, e.g. Entscheidung = "ent-SHY-doong", Büro = "bue-ROH", ich = "ikh".
"tip": at most 12 words in {explain} about the hardest sound in this word for a foreign speaker, or "" \
if nothing is tricky. Do not repeat the same tip for later words.

Answer with JSON only: {{"words": [{{"word": "...", "ipa": "...", "say": "...", "tip": "..."}}]}}"""
    return ask_json(system, str(body.get("text", ""))[:600], "eval", think=False)


def retell(body):
    level, target, _style = level_info(body)
    explain = body.get("explain", "English")
    system = f"""You assess a German learner (currently {level}, working towards {target}) who listened to a \
text and retold it aloud from memory. Judge the retelling against the original.

Score against what is expected at {target}, not against a native speaker. Scores from 1 to 5: "content" (main points covered and correct), "grammar", "vocabulary" (range and \
precision). "level": the CEFR level this retelling shows, e.g. "B1+".
"feedback": 2 or 3 sentences in {explain}: what was good and the single most useful thing to work on.
"missed": important points from the original that are missing or wrong, in {explain} (may be empty).
"corrections": at most 5. {CORRECTION_RULES.format(explain=explain)}
"model": a model retelling in German, 3 to 5 sentences, at {target} level, that the learner can imitate.

Answer with JSON only:
{{"content": 3, "grammar": 3, "vocabulary": 3, "level": "B1+", "feedback": "...", "missed": ["..."],
"corrections": [{{"original": "...", "corrected": "...", "explanation": "..."}}], "model": "..."}}"""
    prompt = f"ORIGINAL TEXT:\n{body.get('text', '')}\n\nLEARNER'S RETELLING:\n{body.get('retelling', '')}"
    out = ask_json(system, prompt, "eval")
    out["corrections"] = real_corrections(out.get("corrections"))
    add_cards(out["corrections"], "retelling")
    bump("retells")
    return out


# ---------- speech to text ----------

WHISPER_LOCK = threading.Lock()
whisper = None


def get_whisper():
    global whisper
    with WHISPER_LOCK:
        if whisper is None:
            whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        return whisper


def transcribe(audio, context="", with_words=False):
    if WhisperModel is None:
        raise RuntimeError("Whisper is not installed.")
    model = get_whisper()
    with WHISPER_LOCK:
        # vad_filter drops silence, which Whisper would otherwise turn into invented text.
        # The context (what the tutor just said, the topic) tells Whisper which words to expect.
        segments, _info = model.transcribe(io.BytesIO(audio), language="de", vad_filter=True,
                                           condition_on_previous_text=False,
                                           initial_prompt=context[:500] or None,
                                           word_timestamps=with_words)
        segments = list(segments)
    out = {"text": " ".join(seg.text.strip() for seg in segments).strip()}
    if with_words:
        # probability = how sure Whisper is about each word; low values hint at unclear pronunciation
        out["words"] = [{"word": w.word.strip(), "prob": round(w.probability, 2)}
                        for seg in segments for w in seg.words or []]
    return out


# ---------- cards ----------

def cards_all(_body=None):
    return {"cards": load(CARDS_FILE, []), "today": today()}


def cards_review(body):
    with LOCK:
        cards = load(CARDS_FILE, [])
        for c in cards:
            if c["id"] == body.get("id"):
                c["box"] = min(c["box"] + 1, 5) if body.get("ok") else 1
                days = INTERVALS[c["box"]] if body.get("ok") else 0
                c["due"] = (date.today() + timedelta(days=days)).isoformat()
        save(CARDS_FILE, cards)
    bump("reviews")
    return {"ok": True}


def cards_delete(body):
    with LOCK:
        save(CARDS_FILE, [c for c in load(CARDS_FILE, []) if c["id"] != body.get("id")])
    return {"ok": True}


def log_activity(body):
    if body.get("key") in ("shadow", "pron"):
        bump(body["key"])
    elif body.get("key") == "mic":
        # Microphone diagnostics from the browser, for troubleshooting.
        with LOCK, open(DATA / "mic.log", "a", encoding="utf-8") as f:
            f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S}  {str(body.get('message', ''))[:600]}\n")
    return {"ok": True}


POST_ROUTES = {
    "/api/chat": chat,
    "/api/listen": listen,
    "/api/retell": retell,
    "/api/translate": translate,
    "/api/pronounce": pronounce,
    "/api/llm": llm_save,
    "/api/llm/models": llm_models,
    "/api/llm/test": llm_test,
    "/api/cards/review": cards_review,
    "/api/cards/delete": cards_delete,
    "/api/log": log_activity,
}
GET_ROUTES = {
    "/api/cards": cards_all,
    "/api/stats": lambda: stats_summary(),
    "/api/llm": llm_view,
    "/api/config": lambda: {"whisper": WhisperModel is not None, "standalone": False, "configured": True},
}
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/backend.js": ("backend.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/manifest.json": ("manifest.json", "application/manifest+json"),
    "/icon-192.png": ("icon-192.png", "image/png"),
    "/icon-512.png": ("icon-512.png", "image/png"),
    "/icon-maskable.png": ("icon-maskable.png", "image/png"),
    "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
}


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, code=200):
        self.send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in STATIC_FILES:
            name, ctype = STATIC_FILES[path]
            self.send(200, (STATIC / name).read_bytes(), ctype)
        elif path in GET_ROUTES:
            self.send_json(GET_ROUTES[path]())
        else:
            self.send_json({"error": "Not found"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]
        route = POST_ROUTES.get(path)
        if not route and path != "/api/transcribe":
            return self.send_json({"error": "Not found"}, 404)
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if path == "/api/transcribe":
                query = parse_qs(urlsplit(self.path).query)
                return self.send_json(transcribe(raw, query.get("context", [""])[0], "words" in query))
            self.send_json(route(json.loads(raw or b"{}")))
        except RuntimeError as e:
            self.send_json({"error": str(e)}, 502)
        except Exception as e:  # keep the server alive, show the cause in the UI
            self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        raise SystemExit(f"Port {PORT} is already in use, so the app is probably running already: "
                         f"open http://localhost:{PORT}\n"
                         f"To restart it, stop the old one first:  pkill -f 'python.* server.py'")
    if WhisperModel is None:
        print("Whisper not installed: using the browser's own speech recognition.")
    else:
        threading.Thread(target=get_whisper, daemon=True).start()  # load now, not on first use
    print(f"Sprechtraining running at http://localhost:{PORT}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nTschüss!")
