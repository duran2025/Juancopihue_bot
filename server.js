// server.js
// Servidor web que sirve una página de chat y responde preguntas usando
// tus manuales/reglamentos como base de conocimiento.
//
// Usa la API gratuita de Google Gemini para generar las respuestas.
//
// Flujo:
// 1. El usuario escribe una pregunta en la página web (public/index.html)
// 2. El navegador manda la pregunta a POST /api/chat
// 3. Buscamos los fragmentos más relevantes de tus manuales (retrieval.js)
// 4. Le preguntamos a Gemini, dándole esos fragmentos como contexto
// 5. Devolvemos la respuesta a la página web

require("dotenv").config();
const express = require("express");
const path = require("path");
const fetch = require("node-fetch");
const { search, loadIndex } = require("./retrieval");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const { GEMINI_API_KEY, PORT = 3000 } = process.env;

// Modelo gratuito de Gemini vigente. Google actualiza estos nombres de vez
// en cuando — si en el futuro deja de funcionar, revisa el modelo disponible
// en aistudio.google.com y actualiza esta línea.
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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

    // Gemini usa "user"/"model" en vez de "user"/"assistant", y no tiene un
    // campo "system" separado en todas las versiones, así que lo agregamos
    // como instrucción del sistema aparte (systemInstruction).
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
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents,
        generationConfig: {
          maxOutputTokens: 800,
        },
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

    res.json({ answer, sources });
  } catch (err) {
    console.error("Error procesando la pregunta:", err);
    res.status(500).json({ error: "Ocurrió un error inesperado." });
  }
});

app.get("/health", (req, res) => {
  res.send("Bot Scout web funcionando ✅");
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
