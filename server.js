// server.js
// Servidor web que sirve una página de chat y responde preguntas usando
// tus manuales/reglamentos como base de conocimiento.
//
// Usa la API gratuita de Google Gemini para generar las respuestas.
// Incluye un panel de administración (protegido con contraseña) para
// subir documentos nuevos y ver qué preguntas se han hecho.
//
// Flujo del chat:
// 1. El usuario escribe una pregunta en la página web (public/index.html)
// 2. El navegador manda la pregunta a POST /api/chat
// 3. Buscamos los fragmentos más relevantes de tus manuales (retrieval.js)
// 4. Le preguntamos a Gemini, dándole esos fragmentos como contexto
// 5. Devolvemos la respuesta a la página web, y guardamos un registro

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { search, loadIndex, addDocument, removeDocument, listSources } = require("./retrieval");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB por archivo
});

const {
  GEMINI_API_KEY,
  ADMIN_PASSWORD,
  PORT = 3000,
} = process.env;

// Modelo gratuito de Gemini vigente. Google actualiza estos nombres de vez
// en cuando — si en el futuro deja de funcionar, revisa el modelo disponible
// en aistudio.google.com y actualiza esta línea.
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const LOG_FILE = path.join(__dirname, "questions-log.jsonl");

// Carga el índice de búsqueda al arrancar el servidor.
try {
  loadIndex();
} catch (err) {
  console.error(
    "⚠️  No se pudo cargar el índice de búsqueda:",
    err.message,
    "\nEl servidor va a arrancar igual, pero corre 'npm run build-index' y reinicia."
  );
}

const SYSTEM_PROMPT = `Eres el asistente virtual de la Agrupación Nacional de Boy Scouts de Chile.
Respondes preguntas de dirigentes, familias y scouts sobre manuales y reglamentos oficiales.

Reglas:
- Responde SOLO con información que esté en los fragmentos de contexto que te entregan.
- Si la respuesta no está en el contexto, dilo claramente y sugiere consultar con un dirigente o revisar el documento original. No inventes información.
- Sé claro y directo.
- Si es útil, menciona de qué documento sale la información.
- Responde siempre en español.`;

// ---------- Utilidad: registrar cada pregunta hecha ----------
function logQuestion(question, answer, sources) {
  try {
    const entry = {
      time: new Date().toISOString(),
      question,
      answer,
      sources,
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error("No se pudo guardar el registro de la pregunta:", err.message);
  }
}

// ---------- Endpoint principal del chat ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Falta el mensaje." });
    }

    const relevantChunks = search(message, 5);

    const context = relevantChunks
      .map((c) => `[Fuente: ${c.source}]\n${c.text}`)
      .join("\n\n---\n\n");

    const userMessage = context
      ? `Contexto de los manuales:\n\n${context}\n\nPregunta del usuario: ${message}`
      : `No se encontró contexto relevante en los manuales para esta pregunta.\n\nPregunta del usuario: ${message}`;

    const geminiHistory = history.slice(-6).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const contents = [
      ...geminiHistory,
      { role: "user", parts: [{ text: userMessage }] },
    ];

    const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { maxOutputTokens: 800 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Error de la API de Gemini:", errText);
      return res.status(500).json({
        error: "Tuve un problema para responder tu pregunta. Intenta de nuevo.",
      });
    }

    const data = await response.json();
    const answer =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No pude generar una respuesta, intenta reformular tu pregunta.";

    const sources = [...new Set(relevantChunks.map((c) => c.source))];

    logQuestion(message, answer, sources);

    res.json({ answer, sources });
  } catch (err) {
    console.error("Error procesando la pregunta:", err);
    res.status(500).json({ error: "Ocurrió un error inesperado." });
  }
});

// ================== PANEL DE ADMINISTRACIÓN ==================
// Todo lo de aquí abajo requiere la contraseña de administrador
// (variable de entorno ADMIN_PASSWORD). Si no está configurada, estas
// funciones quedan desactivadas por seguridad.

function checkAdminPassword(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: "El panel de administración no está configurado (falta ADMIN_PASSWORD).",
    });
  }
  const provided = req.headers["x-admin-password"];
  if (provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Contraseña incorrecta." });
  }
  next();
}

// Extrae texto plano de un archivo subido según su tipo.
async function extractText(file) {
  const name = file.originalname.toLowerCase();

  if (name.endsWith(".pdf")) {
    const data = await pdfParse(file.buffer);
    return data.text;
  }

  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }

  if (name.endsWith(".txt")) {
    return file.buffer.toString("utf-8");
  }

  throw new Error("Formato no soportado. Usa PDF, Word (.docx) o texto (.txt).");
}

// Lista los documentos actualmente indexados.
app.get("/api/admin/documents", checkAdminPassword, (req, res) => {
  res.json({ documents: listSources() });
});

// Sube un documento nuevo (PDF, Word o texto) y lo agrega al conocimiento del bot.
app.post(
  "/api/admin/upload",
  checkAdminPassword,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No se recibió ningún archivo." });
      }

      const text = await extractText(req.file);

      if (!text || text.trim().length < 20) {
        return res.status(400).json({
          error: "No se pudo extraer texto legible de ese archivo. Revisa que no sea un escaneo de solo imágenes.",
        });
      }

      const sourceName = path
        .basename(req.file.originalname, path.extname(req.file.originalname))
        .replace(/[^a-zA-Z0-9_\-áéíóúñÁÉÍÓÚÑ ]/g, "")
        .trim()
        .replace(/\s+/g, "_");

      const fragments = addDocument(sourceName || `documento_${Date.now()}`, text);

      res.json({
        message: `Documento agregado: ${fragments} fragmentos indexados.`,
        source: sourceName,
        documents: listSources(),
      });
    } catch (err) {
      console.error("Error subiendo documento:", err);
      res.status(500).json({ error: err.message || "No se pudo procesar el archivo." });
    }
  }
);

// Elimina un documento del índice.
app.delete("/api/admin/documents/:source", checkAdminPassword, (req, res) => {
  const removed = removeDocument(req.params.source);
  res.json({ removed, documents: listSources() });
});

// Devuelve las últimas preguntas hechas al bot (para revisión humana).
app.get("/api/admin/logs", checkAdminPassword, (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json({ logs: [] });
    const lines = fs
      .readFileSync(LOG_FILE, "utf-8")
      .split("\n")
      .filter(Boolean)
      .slice(-50)
      .reverse()
      .map((line) => JSON.parse(line));
    res.json({ logs: lines });
  } catch (err) {
    res.status(500).json({ error: "No se pudo leer el registro." });
  }
});

app.get("/health", (req, res) => {
  res.send("Bot Scout web funcionando ✅");
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
