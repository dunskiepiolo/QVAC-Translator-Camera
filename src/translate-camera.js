#!/usr/bin/env node
// QVAC Translator Camera — point it at a photo of text and it reads,
// translates, and speaks it aloud, entirely on-device via Tether's QVAC
// SDK. Chains three functions in one pipeline: ocr() -> translate() ->
// textToSpeech(). No cloud call, no API key: every model downloads once
// to a local cache, then every step runs on this machine.

import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import {
  loadModel,
  unloadModel,
  ocr,
  OCR_LATIN,
  MODEL_TYPES,
  translate,
  BERGAMOT_EN_ES,
  textToSpeech,
  TTS_MINI_V1_EN_PARLER_TTS_Q8_0,
} from "@qvac/sdk";

function printUsage() {
  console.log(`
QVAC Translator Camera — OCR + translate + text-to-speech, chained, on-device

Usage:
  node src/translate-camera.js <path-to-image.png-or-.jpg> [--out audio.wav]

It extracts English text from the photo, translates it to Spanish, and
speaks the original English text aloud — three on-device AI steps, one
pipeline, no cloud call.

Example:
  node src/translate-camera.js samples/sign.jpg
`);
}

function pcmToWav(samples, sampleRate) {
  const numSamples = samples.length;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) buffer.writeInt16LE(samples[i], 44 + i * 2);
  return buffer;
}

function playAudio(filePath) {
  const platform = process.platform;
  const cmd =
    platform === "win32"
      ? `start "" "${filePath}"`
      : platform === "darwin"
      ? `afplay "${filePath}"`
      : `xdg-open "${filePath}"`;
  exec(cmd, () => {});
}

async function main() {
  const args = process.argv.slice(2);
  const inputArg = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outPath = path.resolve(outIdx >= 0 ? args[outIdx + 1] : "output.wav");

  if (!inputArg) {
    printUsage();
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  if (!fs.existsSync(inputPath)) {
    console.error(`✖ Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // --- Step 1: OCR ---
  console.log("▸ [1/3] Loading OCR model on-device...");
  const ocrModelId = await loadModel({
    modelSrc: OCR_LATIN.src,
    modelType: MODEL_TYPES.ggmlOcr,
  });
  console.log("▸ Reading text from image on-device...");
  const { blocks } = ocr({ modelId: ocrModelId, image: fs.readFileSync(inputPath) });
  const results = await blocks;
  await unloadModel({ modelId: ocrModelId });

  const text = results.map((b) => b.text).join(" ").trim();
  if (!text) {
    console.error("✖ No text detected in the image.");
    process.exit(1);
  }
  console.log(`✔ Detected text: "${text}"\n`);

  // --- Step 2: Translate ---
  console.log("▸ [2/3] Loading translation model on-device...");
  const translateModelId = await loadModel({
    modelSrc: BERGAMOT_EN_ES,
    modelConfig: { engine: "Bergamot", from: "en", to: "es" },
  });
  console.log("▸ Translating on-device...");
  const result = translate({
    modelId: translateModelId,
    text,
    modelType: "nmtcpp-translation",
    stream: false,
  });
  const translated = await result.text;
  await unloadModel({ modelId: translateModelId, clearStorage: false });
  console.log(`✔ Translated (EN -> ES): "${translated}"\n`);

  // --- Step 3: Text-to-speech ---
  console.log("▸ [3/3] Loading TTS model on-device...");
  const ttsModelId = await loadModel({
    modelSrc: TTS_MINI_V1_EN_PARLER_TTS_Q8_0,
    modelType: "tts",
    modelConfig: { ttsEngine: "parler", voice: "Laura", seed: 42, topK: 1 },
  });
  console.log("▸ Synthesizing speech for the original text on-device...");
  const speech = textToSpeech({ modelId: ttsModelId, text, inputType: "text", stream: false });
  const pcm = await speech.buffer;
  const sampleRate = (await speech.sampleRate) ?? 44100;
  await unloadModel({ modelId: ttsModelId });

  fs.writeFileSync(outPath, pcmToWav(pcm, sampleRate));
  console.log(`✔ Wrote spoken audio to ${outPath}\n`);

  console.log("Summary:");
  console.log(`  Detected (OCR):     "${text}"`);
  console.log(`  Translated (ES):    "${translated}"`);
  console.log(`  Spoken audio:       ${outPath}`);

  playAudio(outPath);
}

main().catch((error) => {
  console.error("✖", error);
  process.exit(1);
});
