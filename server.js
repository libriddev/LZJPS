require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;
const fiveXOneBaseUrl = (process.env.FIVE_X_ONE_URL || "https://api.5x1.com:80").replace(/\/$/, "");

if (!process.env.GROQ_API_KEY) {
  console.warn("GROQ_API_KEY is not configured.");
}

// Groq provides an OpenAI-compatible API, so the OpenAI SDK can be reused.
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

app.use(express.json());

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, os.tmpdir()),
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname) || ".wav";
      callback(null, `jibo-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

async function transcribeSpanishAudio(filePath) {
  const result = await groq.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: process.env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo",
    language: "es",
    response_format: "json"
  });

  if (!result?.text) throw new Error("Groq Whisper returned an empty transcription.");
  return result.text.trim();
}

async function translateToEnglish(spanishText) {
  const completion = await groq.chat.completions.create({
    model: process.env.GROQ_TRANSLATION_MODEL || "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: "Translate Spanish to natural English. Return only the translated English text."
      },
      { role: "user", content: spanishText }
    ],
    temperature: 0
  });

  return completion.choices[0].message.content.trim();
}

function extractFiveXOneReply(payload) {
  if (!payload || typeof payload !== "object") return "";

  const candidates = [
    payload.reply,
    payload.response,
    payload.answer,
    payload.text,
    payload.message,
    payload.output,
    payload.result,
    payload.data?.reply,
    payload.data?.response,
    payload.data?.answer,
    payload.data?.text,
    payload.data?.message,
    payload.data?.output,
    payload.data?.result
  ];

  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  if (value) return value.trim();

  if (Array.isArray(payload.responses)) {
    const response = payload.responses.find((candidate) => typeof candidate === "string" && candidate.trim());
    if (response) return response.trim();
  }

  return "";
}

async function askFiveXOneServer(englishText, sessionId) {
  const attempts = [
    { path: "/api/ask", body: { message: englishText, sessionId, text: englishText } },
    { path: "/ask", body: { message: englishText, sessionId, text: englishText } },
    { path: "/api/chat", body: { query: englishText, sessionId, message: englishText } },
    { path: "/chat", body: { query: englishText, sessionId, message: englishText } },
    { path: "/api/command", body: { input: englishText, sessionId } },
    { path: "/command", body: { input: englishText, sessionId } }
  ];

  let lastError;

  for (const attempt of attempts) {
    try {
      const response = await axios.post(`${fiveXOneBaseUrl}${attempt.path}`, attempt.body, {
        timeout: 30000,
        headers: { "Content-Type": "application/json" }
      });
      const reply = extractFiveXOneReply(response.data);
      if (reply) return reply;
      console.warn("5x1 returned an unrecognized response:", JSON.stringify(response.data).slice(0, 500));
    } catch (error) {
      lastError = error;
      console.warn(`5x1 attempt failed (${attempt.path}):`, error.response?.status || error.message);
    }
  }

  throw new Error(`Unable to obtain a response from 5x1 at ${fiveXOneBaseUrl}: ${lastError?.message || "unknown error"}`);
}

async function translateBackToSpanishWithPhonetics(englishText) {
  const completion = await groq.chat.completions.create({
    model: process.env.GROQ_TRANSLATION_MODEL || "llama-3.3-70b-versatile",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Translate English into natural Spanish for a robot voice. Return JSON with exactly two keys: spanish and phonetic. The spanish value is the final Spanish sentence. The phonetic value is a simple pronunciation guide for Jibo using basic Latin letters and spaces, like 'oh laa soh ee jee boh'. Do not add explanations."
      },
      { role: "user", content: englishText }
    ],
    temperature: 0.3
  });

  try {
    const parsed = JSON.parse(completion.choices[0].message.content);
    const spanish = String(parsed.spanish || englishText).trim();
    return {
      spanish,
      phonetic: String(parsed.phonetic || buildFallbackPhonetic(spanish)).trim()
    };
  } catch (_error) {
    return { spanish: englishText, phonetic: buildFallbackPhonetic(englishText) };
  }
}

function buildFallbackPhonetic(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ñ/g, "ny")
    .replace(/ll/g, "y")
    .replace(/qu/g, "k")
    .replace(/h/g, "")
    .replace(/j/g, "h")
    .replace(/v/g, "b")
    .replace(/z/g, "s")
    .replace(/c(?=[ei])/g, "s")
    .replace(/c/g, "k")
    .replace(/\s+/g, " ")
    .trim();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "jibo-spanish-proxy", fiveXOneBaseUrl });
});

app.post("/api/jibo/audio", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Audio file is required in the 'audio' form field." });
    }

    const sessionId = req.body.sessionId || "jibo-default";
    const transcriptSpanish = await transcribeSpanishAudio(req.file.path);
    const englishRequest = await translateToEnglish(transcriptSpanish);
    const englishReply = await askFiveXOneServer(englishRequest, sessionId);
    const reply = await translateBackToSpanishWithPhonetics(englishReply);

    res.json({
      ok: true,
      input: { transcriptSpanish },
      englishForFiveXOne: { text: englishRequest },
      reply: { english: englishReply, ...reply }
    });
  } catch (error) {
    console.error("Proxy error:", error);
    res.status(500).json({ ok: false, error: error.message || "Unexpected server error" });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
  }
});

app.listen(port, () => {
  console.log(`Jibo proxy listening on http://localhost:${port}`);
  console.log(`5x1 target: ${fiveXOneBaseUrl}`);
});
