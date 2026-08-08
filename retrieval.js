// retrieval.js
// Motor de búsqueda simple (TF-IDF) sobre los fragmentos generados por
// build-index.js (o agregados luego desde el panel de administración).
// No necesita servicios externos ni base de datos.

const fs = require("fs");
const path = require("path");
const natural = require("natural");
const { chunkText } = require("./lib/chunk");

const INDEX_FILE = path.join(__dirname, "index.json");
const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");

let chunks = [];
let tfidf = null;

function rebuildTfidf() {
  tfidf = new natural.TfIdf();
  for (const chunk of chunks) {
    tfidf.addDocument(chunk.text);
  }
}

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error(
      "No se encontró index.json. Corre 'npm run build-index' primero."
    );
  }
  chunks = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  rebuildTfidf();
  console.log(`Índice cargado: ${chunks.length} fragmentos.`);
}

// Devuelve los N fragmentos más relevantes para una pregunta dada.
function search(query, topN = 5) {
  if (!tfidf) loadIndex();

  const scores = [];
  tfidf.tfidfs(query, (i, measure) => {
    scores.push({ index: i, score: measure });
  });

  scores.sort((a, b) => b.score - a.score);

  return scores
    .filter((s) => s.score > 0)
    .slice(0, topN)
    .map((s) => chunks[s.index]);
}

// Agrega (o reemplaza, si ya existía uno con el mismo nombre) un documento
// nuevo al índice de búsqueda y lo persiste en disco.
// 'text' debe ser texto plano ya extraído del PDF/Word/txt subido.
function addDocument(sourceName, text) {
  // Si ya había un documento con ese nombre, se reemplaza por completo.
  chunks = chunks.filter((c) => c.source !== sourceName);

  const cleaned = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  const newChunks = chunkText(cleaned, sourceName);
  chunks = chunks.concat(newChunks);

  fs.writeFileSync(INDEX_FILE, JSON.stringify(chunks, null, 2), "utf-8");

  // Guardamos también el .txt en /knowledge, como respaldo legible y para
  // que quede incluido si más adelante alguien corre 'npm run build-index'.
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  }
  fs.writeFileSync(
    path.join(KNOWLEDGE_DIR, `${sourceName}.txt`),
    cleaned,
    "utf-8"
  );

  rebuildTfidf();

  return newChunks.length;
}

// Elimina un documento del índice (todos sus fragmentos) y lo persiste.
function removeDocument(sourceName) {
  const before = chunks.length;
  chunks = chunks.filter((c) => c.source !== sourceName);
  const removed = before - chunks.length;

  fs.writeFileSync(INDEX_FILE, JSON.stringify(chunks, null, 2), "utf-8");

  const txtPath = path.join(KNOWLEDGE_DIR, `${sourceName}.txt`);
  if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);

  rebuildTfidf();

  return removed;
}

// Lista los nombres de todos los documentos actualmente indexados.
function listSources() {
  const counts = {};
  for (const c of chunks) {
    counts[c.source] = (counts[c.source] || 0) + 1;
  }
  return Object.entries(counts).map(([source, fragments]) => ({
    source,
    fragments,
  }));
}

module.exports = { loadIndex, search, addDocument, removeDocument, listSources };
