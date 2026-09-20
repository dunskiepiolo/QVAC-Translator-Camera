# QVAC Translator Camera

Point it at a photo of text, a sign, a menu, a note, and it reads the
text, translates it, and speaks it aloud, entirely on your own machine
using [Tether's QVAC SDK](https://github.com/tetherto/qvac) — no cloud
call, no API key, no bill.

Unlike a single-function demo, this chains **three** on-device AI steps
into one pipeline: `ocr()` to extract the text, `translate()` to
translate it, and `textToSpeech()` to speak it, all calling QVAC's
`loadModel()` in between. Every model downloads once to a local cache,
then every run after that is fully offline.

## What it does

```
node src/translate-camera.js samples/sign.png
```
```
▸ [1/3] Loading OCR model on-device...
✔ Detected text: "Welcome to the museum"

▸ [2/3] Loading translation model on-device...
✔ Translated (EN -> ES): "¡Bienvenidos al museo"

▸ [3/3] Loading TTS model on-device...
✔ Wrote spoken audio to output.wav
```

## Verified output

Actually run end-to-end on 2026-09-20 (Windows), against a synthetic test
image reading "Welcome to the museum":

```
Detected (OCR):     "Welcome to the museum"
Translated (ES):    "¡Bienvenidos al museo"
Spoken audio:       output.wav  (valid RIFF/WAVE, 147500 bytes)
```

All three steps ran correctly on the first real attempt — the translation
is genuinely correct Spanish, not just plausible-looking text.

## SDK version

Built and tested against `@qvac/sdk` **v0.19.1** (see [package.json](package.json)).

## Requirements

- Node.js `>= 22.17`
- A machine that meets [QVAC's system requirements](https://docs.qvac.tether.io/system-requirements)
- ~1.3 GB free disk space for the three model weights on first run (OCR
  ~83MB, Bergamot EN-ES ~37MB, Parler TTS ~1.16GB)

## Install

```bash
git clone https://github.com/<your-username>/qvac-translator-camera.git
cd qvac-translator-camera
npm install
```

## Run

```bash
node src/translate-camera.js <path-to-image.png-or-.jpg> [--out audio.wav]
```

A synthetic sample image is bundled at `samples/sign.png` so you can try
it immediately. Point it at your own photo of English text (a sign, a
label, a printed note) to try it on something real.

On first run each of the three models downloads with a progress bar.
Every run after that loads from the local cache and runs fully offline —
your photo and text never leave your machine.

## GUI mode

A web UI is also included with a live 3-step pipeline view — same
on-device chain, streamed over Server-Sent Events:

```bash
npm run gui
```

This starts a local server (`http://localhost:9191` by default) and loads
each model lazily on first use, so startup is instant and only the first
run per step takes a moment. Open the page, drop in a photo, click
**Read, translate & speak**, and watch each of the three steps light up
(OCR → Translate → Speak) as they complete, then see the detected text,
the Spanish translation, and a playable audio result. Override the port
with `PORT=8080 npm run gui`.

Verified working end-to-end on 2026-09-20 via the actual HTTP endpoints:
uploading the bundled sample returned the correct detected text, the
correct Spanish translation, and a valid WAV audio payload, with each SSE
pipeline step firing `active` then `done` in the right order.

## How it uses QVAC

```js
import {
  loadModel, unloadModel,
  ocr, OCR_LATIN, MODEL_TYPES,
  translate, BERGAMOT_EN_ES,
  textToSpeech, TTS_MINI_V1_EN_PARLER_TTS_Q8_0,
} from "@qvac/sdk";

// 1. OCR
const ocrModelId = await loadModel({ modelSrc: OCR_LATIN.src, modelType: MODEL_TYPES.ggmlOcr });
const { blocks } = ocr({ modelId: ocrModelId, image: imageBuffer });
const text = (await blocks).map(b => b.text).join(" ");
await unloadModel({ modelId: ocrModelId });

// 2. Translate
const translateModelId = await loadModel({ modelSrc: BERGAMOT_EN_ES, modelConfig: { engine: "Bergamot", from: "en", to: "es" } });
const { text: translated } = translate({ modelId: translateModelId, text, modelType: "nmtcpp-translation", stream: false });
await unloadModel({ modelId: translateModelId, clearStorage: false });

// 3. Speak
const ttsModelId = await loadModel({ modelSrc: TTS_MINI_V1_EN_PARLER_TTS_Q8_0, modelType: "tts", modelConfig: { ttsEngine: "parler", voice: "Laura" } });
const { buffer: pcm } = textToSpeech({ modelId: ttsModelId, text, inputType: "text", stream: false });
await unloadModel({ modelId: ttsModelId });
```

See [src/translate-camera.js](src/translate-camera.js) for the full
implementation, including the WAV encoding for the raw PCM output.

## License

[MIT](LICENSE)
