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
const crypto = require("crypto");
const fetch = require("node-fetch");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { search, loadIndex, addDocument, removeDocument, listSources, findArticleChunks } = require("./retrieval");

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

// ---------- Documentos sugeridos por visitantes, pendientes de aprobación ----------
const PENDING_DIR = path.join(__dirname, "pending");
const PENDING_FILES_DIR = path.join(PENDING_DIR, "files");
const PENDING_META_FILE = path.join(PENDING_DIR, "pending.json");

if (!fs.existsSync(PENDING_FILES_DIR)) {
  fs.mkdirSync(PENDING_FILES_DIR, { recursive: true });
}

function loadPending() {
  if (!fs.existsSync(PENDING_META_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PENDING_META_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function savePending(list) {
  fs.writeFileSync(PENDING_META_FILE, JSON.stringify(list, null, 2), "utf-8");
}

// ---------- Biblioteca de imágenes (nudos, señas, insignias, etc.) ----------
const MEDIA_DIR = path.join(__dirname, "media");
const MEDIA_FILES_DIR = path.join(MEDIA_DIR, "files");
const MEDIA_META_FILE = path.join(MEDIA_DIR, "media.json");
const MEDIA_ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

if (!fs.existsSync(MEDIA_FILES_DIR)) {
  fs.mkdirSync(MEDIA_FILES_DIR, { recursive: true });
}

// Las imágenes de la biblioteca se sirven como archivos estáticos normales.
app.use("/media-files", express.static(MEDIA_FILES_DIR));

function loadMedia() {
  if (!fs.existsSync(MEDIA_META_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(MEDIA_META_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveMedia(list) {
  fs.writeFileSync(MEDIA_META_FILE, JSON.stringify(list, null, 2), "utf-8");
}

// Quita tildes/acentos para que la comparación de palabras no falle por eso.
function normalizeText(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// Busca en la biblioteca las imágenes cuyas etiquetas coincidan con la pregunta.
function findMatchingImages(question, maxResults = 2) {
  const media = loadMedia();
  if (media.length === 0) return [];

  const normalizedQuestion = normalizeText(question);

  const matches = media.filter((item) => {
    const tags = (item.tags || "").split(",").map((t) => normalizeText(t)).filter(Boolean);
    return tags.some((tag) => tag.length > 2 && normalizedQuestion.includes(tag));
  });

  return matches.slice(0, maxResults).map((item) => ({
    url: `/media-files/${item.storedFileName}`,
    description: item.description || "",
  }));
}

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

const SYSTEM_PROMPT = `Eres Juan Copihue, el asistente virtual de la Agrupación Nacional de Boy Scouts de Chile.
Respondes preguntas de dirigentes, familias y scouts sobre manuales y reglamentos oficiales.

Cómo responder:
- Basa tu respuesta SOLO en la información que esté en los fragmentos de contexto que te entregan. No inventes datos, cifras ni reglas que no estén ahí.
- Pero no te limites a copiar o parafrasear el texto tal cual — interprétalo y explícalo con tus propias palabras, como lo haría un dirigente con experiencia que conoce bien el reglamento y te lo explica de forma cercana.
- Da contexto: por qué existe esa regla, cómo se aplica en la práctica, o un ejemplo concreto, cuando el contexto te dé pie para eso.
- Si la pregunta tiene varias partes o matices, organiza la respuesta para que sea fácil de seguir (puedes usar viñetas o pasos si ayuda).
- Usa un tono cercano y natural, como conversando con alguien de la agrupación — no como leyendo un artículo legal en voz alta.
- Si la respuesta no está en el contexto, dilo claramente y sugiere consultar con un dirigente o revisar el documento original. No inventes información para rellenar.
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

    let relevantChunks = search(message, 5);

    // Si la pregunta menciona "Artículo N", buscamos esa coincidencia EXACTA
    // en todos los documentos y la ponemos primero — la búsqueda por
    // palabras clave sola puede fallar con términos tan cortos y comunes.
    let articleNumber = null;
    const directMatch = message.match(/art[ií]culo\s+(\d+)/i);
    if (directMatch) {
      articleNumber = directMatch[1];
    } else {
      // Preguntas de seguimiento cortas ("y el 2", "el 3", "2?") solo tienen
      // sentido como "siguiente artículo" si la conversación reciente ya
      // venía hablando de un artículo específico.
      const followUpMatch = message.match(/^\s*(?:y\s+)?(?:el\s+)?(\d+)\s*\??\s*$/i);
      const recentlyTalkedAboutArticles = history
        .slice(-4)
        .some((m) => /art[ií]culo/i.test(m.content || ""));
      if (followUpMatch && recentlyTalkedAboutArticles) {
        articleNumber = followUpMatch[1];
      }
    }

    if (articleNumber) {
      const exactMatches = findArticleChunks(articleNumber, 3);
      const seen = new Set(exactMatches.map((c) => c.id));
      relevantChunks = [
        ...exactMatches,
        ...relevantChunks.filter((c) => !seen.has(c.id)),
      ].slice(0, 6);
    }

    const context = relevantChunks
      .map((c) => `[Fuente: ${c.source}]\n${c.text}`)
      .join("\n\n---\n\n");

    const followUpHint =
      articleNumber && !directMatch
        ? `\n\n(Nota: interpreté "${message}" como una pregunta de seguimiento pidiendo el Artículo ${articleNumber}, continuando la conversación anterior. Si hay varios artículos con ese número en distintos libros/documentos, prioriza el mismo libro/documento del que veníamos hablando.)`
        : "";

    const userMessage = context
      ? `Contexto de los manuales:\n\n${context}\n\nPregunta del usuario: ${message}${followUpHint}`
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
        generationConfig: { maxOutputTokens: 1100 },
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
    const images = findMatchingImages(message);

    logQuestion(message, answer, sources);

    res.json({ answer, sources, images });
  } catch (err) {
    console.error("Error procesando la pregunta:", err);
    res.status(500).json({ error: "Ocurrió un error inesperado." });
  }
});

// ---------- Endpoint público: sugerir un documento (queda pendiente de aprobación) ----------
const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt"];

app.post("/api/submit-document", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo." });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return res.status(400).json({
        error: "Formato no permitido. Sube un PDF, Word (.docx) o texto (.txt).",
      });
    }

    const note = typeof req.body.note === "string" ? req.body.note.slice(0, 500) : "";

    const id = crypto.randomUUID();
    const safeOriginalName = req.file.originalname.replace(/[^a-zA-Z0-9_\-.áéíóúñÁÉÍÓÚÑ ]/g, "");
    const storedFileName = `${id}__${safeOriginalName}`;

    fs.writeFileSync(path.join(PENDING_FILES_DIR, storedFileName), req.file.buffer);

    const pending = loadPending();
    pending.push({
      id,
      originalName: req.file.originalname,
      storedFileName,
      note,
      submittedAt: new Date().toISOString(),
      size: req.file.size,
    });
    savePending(pending);

    res.json({
      message: "¡Gracias! Tu documento quedó enviado para revisión de un administrador.",
    });
  } catch (err) {
    console.error("Error recibiendo documento sugerido:", err);
    res.status(500).json({ error: "No se pudo recibir el archivo. Intenta de nuevo." });
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

// Lista los documentos pendientes de aprobación.
app.get("/api/admin/pending", checkAdminPassword, (req, res) => {
  const pending = loadPending();
  res.json({ pending: pending.slice().reverse() });
});

// Descarga el archivo original de un documento pendiente, para revisarlo.
app.get("/api/admin/pending/:id/download", checkAdminPassword, (req, res) => {
  const pending = loadPending();
  const item = pending.find((p) => p.id === req.params.id);
  if (!item) return res.status(404).json({ error: "No se encontró ese documento pendiente." });

  const filePath = path.join(PENDING_FILES_DIR, item.storedFileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "El archivo ya no está disponible en el servidor." });
  }

  res.download(filePath, item.originalName);
});

// Aprueba un documento pendiente: lo agrega oficialmente al chatbot.
app.post("/api/admin/pending/:id/approve", checkAdminPassword, async (req, res) => {
  try {
    const pending = loadPending();
    const item = pending.find((p) => p.id === req.params.id);
    if (!item) return res.status(404).json({ error: "No se encontró ese documento pendiente." });

    const filePath = path.join(PENDING_FILES_DIR, item.storedFileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "El archivo ya no está disponible en el servidor." });
    }

    const buffer = fs.readFileSync(filePath);
    const text = await extractText({ originalname: item.originalName, buffer });

    if (!text || text.trim().length < 20) {
      return res.status(400).json({
        error: "No se pudo extraer texto legible de ese archivo. Revísalo manualmente antes de aprobarlo.",
      });
    }

    const sourceName = path
      .basename(item.originalName, path.extname(item.originalName))
      .replace(/[^a-zA-Z0-9_\-áéíóúñÁÉÍÓÚÑ ]/g, "")
      .trim()
      .replace(/\s+/g, "_");

    const fragments = addDocument(sourceName || `documento_${Date.now()}`, text);

    // Ya quedó incorporado al índice oficial (y respaldado en /knowledge),
    // así que se quita de la lista de pendientes.
    fs.unlinkSync(filePath);
    savePending(pending.filter((p) => p.id !== item.id));

    res.json({
      message: `Documento aprobado y agregado: ${fragments} fragmentos indexados.`,
      documents: listSources(),
    });
  } catch (err) {
    console.error("Error aprobando documento:", err);
    res.status(500).json({ error: err.message || "No se pudo aprobar el documento." });
  }
});

// Rechaza (elimina) un documento pendiente sin agregarlo al chatbot.
app.delete("/api/admin/pending/:id", checkAdminPassword, (req, res) => {
  const pending = loadPending();
  const item = pending.find((p) => p.id === req.params.id);
  if (!item) return res.status(404).json({ error: "No se encontró ese documento pendiente." });

  const filePath = path.join(PENDING_FILES_DIR, item.storedFileName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  savePending(pending.filter((p) => p.id !== item.id));

  res.json({ message: "Documento rechazado y eliminado." });
});

// Lista las imágenes de la biblioteca (nudos, señas, etc.).
app.get("/api/admin/media", checkAdminPassword, (req, res) => {
  res.json({ media: loadMedia().slice().reverse() });
});

// Sube una imagen nueva a la biblioteca, con etiquetas para que el bot la encuentre.
app.post("/api/admin/media", checkAdminPassword, upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ninguna imagen." });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!MEDIA_ALLOWED_EXTENSIONS.includes(ext)) {
      return res.status(400).json({
        error: "Formato no permitido. Sube una imagen JPG, PNG, WEBP o GIF.",
      });
    }

    const tags = typeof req.body.tags === "string" ? req.body.tags.slice(0, 300) : "";
    if (!tags.trim()) {
      return res.status(400).json({
        error: "Escribe al menos una etiqueta (ej: 'nudo as de guía, as de guia') para que el bot sepa cuándo mostrarla.",
      });
    }

    const description = typeof req.body.description === "string" ? req.body.description.slice(0, 300) : "";

    const id = crypto.randomUUID();
    const storedFileName = `${id}${ext}`;
    fs.writeFileSync(path.join(MEDIA_FILES_DIR, storedFileName), req.file.buffer);

    const media = loadMedia();
    media.push({
      id,
      storedFileName,
      originalName: req.file.originalname,
      tags,
      description,
      uploadedAt: new Date().toISOString(),
    });
    saveMedia(media);

    res.json({ message: "Imagen agregada a la biblioteca.", media: media.slice().reverse() });
  } catch (err) {
    console.error("Error subiendo imagen a la biblioteca:", err);
    res.status(500).json({ error: "No se pudo subir la imagen." });
  }
});

// Elimina una imagen de la biblioteca.
app.delete("/api/admin/media/:id", checkAdminPassword, (req, res) => {
  const media = loadMedia();
  const item = media.find((m) => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: "No se encontró esa imagen." });

  const filePath = path.join(MEDIA_FILES_DIR, item.storedFileName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  saveMedia(media.filter((m) => m.id !== item.id));

  res.json({ message: "Imagen eliminada." });
});

// Verificador: busca coincidencias exactas de "Artículo N" y devuelve el
// texto real indexado, sin pasar por la IA — para confirmar con certeza
// si un artículo específico quedó bien indexado.
app.get("/api/admin/verify-article/:number", checkAdminPassword, (req, res) => {
  const matches = findArticleChunks(req.params.number, 10);
  res.json({
    found: matches.length > 0,
    matches: matches.map((c) => ({ source: c.source, text: c.text })),
  });
});

app.get("/health", (req, res) => {
  res.send("Bot Scout web funcionando ✅");
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
