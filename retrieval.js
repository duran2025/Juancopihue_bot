// retrieval.js
// Motor de búsqueda simple (TF-IDF) sobre los fragmentos generados por
// build-index.js. No necesita servicios externos ni base de datos.

const fs = require("fs");
const path = require("path");
const natural = require("natural");

const INDEX_FILE = path.join(__dirname, "index.json");

let chunks = [];
let tfidf = null;

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error(
      "No se encontró index.json. Corre 'npm run build-index' primero."
    );
  }
  chunks = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));

  tfidf = new natural.TfIdf();
  for (const chunk of chunks) {
    tfidf.addDocument(chunk.text);
  }

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

module.exports = { loadIndex, search };
