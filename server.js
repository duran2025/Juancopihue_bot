// server.js
// Servidor que conecta WhatsApp (Meta Cloud API) con Claude, usando tus
// manuales/reglamentos como base de conocimiento.
//
// Flujo:
// 1. Meta manda el mensaje del usuario a /webhook (POST)
// 2. Buscamos los fragmentos más relevantes de tus manuales (retrieval.js)
// 3. Le preguntamos a Claude, dándole esos fragmentos como contexto
// 4. Mandamos la respuesta de vuelta al usuario por WhatsApp

require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const { search, loadIndex } = require("./retrieval");

const app = express();
app.use(express.json());

const {
  META_VERIFY_TOKEN,
  META_ACCESS_TOKEN,
  META_PHONE_NUMBER_ID,
  ANTHROPIC_API_KEY,
  PORT = 3000,
} = process.env;

// Carga el índice de búsqueda al arrancar el servidor.
try {
  loadIndex();
} catch (err) {
  console.error(
    "⚠️  No se pudo cargar el índice de búsqueda:",
    err.message,
    "\nEl bot va a arrancar igual, pero corre 'npm run build-index' y reinicia."
  );
}

const SYSTEM_PROMPT = `Eres el asistente virtual de la Agrupación Nacional de Boy Scouts de Chile.
Respondes preguntas de dirigentes, familias y scouts sobre manuales y reglamentos oficiales.

Reglas:
- Responde SOLO con información que esté en los fragmentos de contexto que te entregan.
- Si la respuesta no está en el contexto, dilo claramente y sugiere consultar con un dirigente o revisar el documento original. No inventes información.
- Sé breve, claro y directo (esto es un chat de WhatsApp, evita respuestas muy largas).
- Si es útil, menciona de qué documento sale la información.
- Responde siempre en español.`;

// ---------- 1. Verificación del webhook (Meta la pide al configurar) ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- 2. Recepción de mensajes ----------
app.post("/webhook", async (req, res) => {
  // Respondemos rápido a Meta para que no reintente el envío.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const from = message.from; // número del usuario
    const userText = message.text.body;

    console.log(`Mensaje de ${from}: ${userText}`);

    const answer = await answerQuestion(userText);
    await sendWhatsAppMessage(from, answer);
  } catch (err) {
    console.error("Error procesando el mensaje:", err);
  }
});

// ---------- 3. Buscar contexto + preguntarle a Claude ----------
async function answerQuestion(question) {
  const relevantChunks = search(question, 5);

  const context = relevantChunks
    .map((c) => `[Fuente: ${c.source}]\n${c.text}`)
    .join("\n\n---\n\n");

  const userMessage = context
    ? `Contexto de los manuales:\n\n${context}\n\nPregunta del usuario: ${question}`
    : `No se encontró contexto relevante en los manuales para esta pregunta.\n\nPregunta del usuario: ${question}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Error de la API de Claude:", errText);
    return "Tuve un problema para responder tu pregunta. Intenta de nuevo en unos minutos.";
  }

  const data = await response.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  return textBlock?.text || "No pude generar una respuesta, intenta reformular tu pregunta.";
}

// ---------- 4. Enviar la respuesta por WhatsApp ----------
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Error enviando mensaje a WhatsApp:", errText);
  }
}

app.get("/", (req, res) => {
  res.send("Bot Scout de WhatsApp funcionando ✅");
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
