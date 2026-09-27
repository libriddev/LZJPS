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

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

const STRICT_TRANSLATOR_PROMPT =
  "you are a professional translator, translate Spanish text to English, and English text to Spanish. Do not answer questions, do not add comentary, and do not simulate ai responses. Only return the direct translation";

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

async function translateText(text, targetLanguage) {
  const isSpanishInput = /[\u00C0-\u024F]/.test(text) || /[áéíóúñü]/i.test(text);
  const promptLanguage = targetLanguage === "en" ? "Translate this Spanish text to English." : "Translate this English text to Spanish.";

  const completion = await groq.chat.completions.create({
    model: process.env.GROQ_TRANSLATION_MODEL || "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: STRICT_TRANSLATOR_PROMPT
      },
      {
        role: "user",
        content: `${promptLanguage}\n\n${text}`
      }
    ],
    temperature: 0
  });

  const translated = completion.choices[0].message.content.trim();
  if (!translated) {
    throw new Error("Groq translation returned empty output.");
  }

  return translated.trim();
}

async function translateToEnglish(spanishText) {
  return translateText(spanishText, "en");
}

async function translateToSpanish(englishText) {
  return translateText(englishText, "es");
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
  const spanishText = await translateToSpanish(englishText);

  return {
    spanish: spanishText,
    phonetic: buildFallbackPhonetic(spanishText)
  };
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
