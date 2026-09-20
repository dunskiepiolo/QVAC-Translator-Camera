#!/usr/bin/env node
// QVAC Translator Camera — GUI mode. A tiny local web UI (no framework, no
// extra dependencies) on top of the same on-device QVAC pipeline as
// src/translate-camera.js: ocr() -> translate() -> textToSpeech(), each
// model loaded once and kept warm, streamed to the browser over
// Server-Sent Events. Everything — the photo, the text, the audio — stays
// on this machine, the server never calls out.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { URL, fileURLToPath } from "node:url";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 9191;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// In-memory store for uploaded images, keyed by a short-lived id.
const uploads = new Map();

function serveStatic(res) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 25 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function dataUrlToBuffer(dataUrl) {
  const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("Expected a PNG or JPEG data URL");
  return Buffer.from(match[2], "base64");
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Models are loaded lazily on first use and kept warm for later requests.
const models = {};

async function getOcrModel() {
  if (!models.ocr) {
    models.ocr = await loadModel({ modelSrc: OCR_LATIN.src, modelType: MODEL_TYPES.ggmlOcr });
  }
  return models.ocr;
}
async function getTranslateModel() {
  if (!models.translate) {
    models.translate = await loadModel({
      modelSrc: BERGAMOT_EN_ES,
      modelConfig: { engine: "Bergamot", from: "en", to: "es" },
    });
  }
  return models.translate;
}
async function getTtsModel() {
  if (!models.tts) {
    models.tts = await loadModel({
      modelSrc: TTS_MINI_V1_EN_PARLER_TTS_Q8_0,
      modelType: "tts",
      modelConfig: { ttsEngine: "parler", voice: "Laura", seed: 42, topK: 1 },
    });
  }
  return models.tts;
}

async function main() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return serveStatic(res);
    }

    if (req.method === "POST" && url.pathname === "/api/upload") {
      try {
        const body = await readJsonBody(req);
        const imageBuffer = dataUrlToBuffer(body.image);
        const id = crypto.randomUUID();
        uploads.set(id, imageBuffer);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/run") {
      const id = url.searchParams.get("id");
      const imageBuffer = id && uploads.get(id);
      if (!imageBuffer) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Unknown or expired upload id" }));
      }
      uploads.delete(id);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      try {
        // Step 1: OCR
        sseWrite(res, "step", { step: "ocr", status: "active" });
        const ocrModelId = await getOcrModel();
        const { blocks } = ocr({ modelId: ocrModelId, image: imageBuffer });
        const results = await blocks;
        const text = results.map((b) => b.text).join(" ").trim();
        if (!text) throw new Error("No text detected in the image");
        sseWrite(res, "step", { step: "ocr", status: "done" });

        // Step 2: Translate
        sseWrite(res, "step", { step: "translate", status: "active" });
        const translateModelId = await getTranslateModel();
        const result = translate({
          modelId: translateModelId,
          text,
          modelType: "nmtcpp-translation",
          stream: false,
        });
        const translated = await result.text;
        sseWrite(res, "step", { step: "translate", status: "done" });

        // Step 3: Text-to-speech
        sseWrite(res, "step", { step: "tts", status: "active" });
        const ttsModelId = await getTtsModel();
        const speech = textToSpeech({ modelId: ttsModelId, text, inputType: "text", stream: false });
        const pcm = await speech.buffer;
        const sampleRate = (await speech.sampleRate) ?? 44100;
        sseWrite(res, "step", { step: "tts", status: "done" });

        sseWrite(res, "done", {
          text,
          translated,
          audioBase64: pcmToWav(pcm, sampleRate).toString("base64"),
        });
      } catch (error) {
        sseWrite(res, "error", { error: error.message });
      } finally {
        res.end();
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(`▸ QVAC Translator Camera GUI ready at http://localhost:${PORT}`);
    console.log("  (models load lazily on first use, so the first run per step takes longer)");
  });

  const shutdown = async () => {
    console.log("\n▸ Shutting down...");
    server.close();
    await Promise.all(
      Object.values(models).map((id) => unloadModel({ modelId: id }).catch(() => {}))
    );
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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

main().catch((error) => {
  console.error("✖", error);
  process.exit(1);
});
