# Sprechtraining

A German listening and speaking trainer for learners from A1 to C2, aimed at working life in Germany.

- **Conversation** with an AI colleague, with corrections after every answer
- **Listen & retell**: generated workplace audio, then scored retelling
- **Shadowing** and dictation, sentence by sentence
- **Pronunciation**: sounds-like spelling and IPA for any text, plus a word-by-word check of your own speech
- **My mistakes**: every correction comes back as a spaced-repetition review

## Use it on a phone or tablet (no computer needed)

The `docs/` folder is a complete app that runs in the browser, published with GitHub Pages.

1. Open the Pages address of this repository in Chrome.
2. On the **Settings** tab choose an AI service (Google Gemini and Groq have free tiers), paste your API key,
   load the model list, pick a model and press **Save and test**.
3. Use the browser menu → **Add to Home screen** to install it.

Your API key, mistakes and progress are stored only in that browser. Speech recognition uses the browser's
own service, or Whisper if you add a Groq or OpenAI key.

## Run it on a computer

With the Python server the tutor can also use a local Claude Code login, and speech recognition runs
locally with Whisper.

```
python3 server.py        # then open http://localhost:8765
```

Optional local Whisper and the Claude API need a `.venv` with `faster-whisper`, `av<16` and `anthropic`;
without it the server runs on the standard library alone and uses the browser's speech recognition.
