// retrieval.js
// Motor de búsqueda simple (TF-IDF) sobre los fragmentos generados por
// build-index.js (o agregados luego desde el panel de administración).
// No necesita servicios externos ni base de datos.
//
// Nota sobre precisión: ningún documento tiene prioridad sobre otro — todos
// compiten en igualdad de condiciones. Lo que sí hacemos es limpiar mejor el
// texto antes de compararlo (tildes, mayúsculas) y evitar que un solo
// documento muy largo acapare todos los resultados de una pregunta, para
// que el contexto que recibe la IA sea más variado y relevante.

const fs = require("fs");
const path = require("path");
const natural = require("natural");
const { chunkText } = require("./lib/chunk");

const INDEX_FILE = path.join(__dirname, "index.json");
const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");

// Máximo de fragmentos que puede aportar un documento que NO es
// claramente el más relevante de esta búsqueda. Evita que un documento
// largo con coincidencias débiles o casuales acapare todo el contexto.
const MAX_CHUNKS_PER_SOURCE = 2;

// Cuando un documento es notoriamente el más relevante para esta pregunta
// en particular (su mejor fragmento supera bastante al resto), se le
// permite aportar más fragmentos seguidos — así, si la respuesta correcta
// es una lista larga contenida en un solo documento (por ejemplo, un
// listado completo de algo), no se corta a la mitad. Qué documento recibe
// este trato más flexible se decide en cada pregunta según su puntaje real,
// nunca por su nombre — para la siguiente pregunta puede ser otro distinto,
// o ninguno si no hay un documento claramente dominante.
const MAX_CHUNKS_TOP_SOURCE = 6;
// Qué tan por delante debe ir el mejor documento del segundo mejor para
// considerarlo "claramente dominante" (1.5 = al menos 50% más relevante).
const DOMINANCE_RATIO = 1.5;

// Una pregunta puede traer resultados con puntaje > 0 que en realidad son
// ruido (coincidencias muy débiles). Descartamos los que queden muy por
// debajo del mejor puntaje de esa búsqueda en particular.
const MIN_RELATIVE_SCORE = 0.12; // 12% del puntaje del mejor resultado

let chunks = [];
let tfidf = null;

// Quita tildes/acentos y baja a minúsculas, para que "artículo" y
// "articulo", o "reunión" y "REUNION", se comparen como la misma palabra.
// Se usa tanto al indexar el texto como al procesar la pregunta del
// usuario, así ambos lados se comparan de forma consistente.
function normalizeForSearch(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ\s]/gi, " ");
}

function rebuildTfidf() {
  tfidf = new natural.TfIdf();
  for (const chunk of chunks) {
    // Indexamos la versión normalizada (sin tildes) de cada fragmento, no
    // el texto crudo. El texto original se conserva intacto en chunk.text
    // para mostrarlo/enviarlo a la IA tal cual está escrito.
    tfidf.addDocument(normalizeForSearch(chunk.text));
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
// Todos los documentos compiten en igualdad de condiciones: no hay ningún
// documento con puntaje reforzado ni preferencia por nombre o tipo.
function search(query, topN = 5) {
  if (!tfidf) loadIndex();

  const scores = [];
  tfidf.tfidfs(normalizeForSearch(query), (i, measure) => {
    scores.push({ index: i, score: measure });
  });

  scores.sort((a, b) => b.score - a.score);

  const positiveScores = scores.filter((s) => s.score > 0);
  if (positiveScores.length === 0) return [];

  // Descartamos coincidencias demasiado débiles comparadas con la mejor de
  // esta búsqueda (ruido de palabras sueltas que aparecen por casualidad).
  const topScore = positiveScores[0].score;
  const filtered = positiveScores.filter(
    (s) => s.score >= topScore * MIN_RELATIVE_SCORE
  );

  // Recorremos los resultados ya ordenados por relevancia y los vamos
  // tomando, con un límite de fragmentos por documento — más flexible para
  // el documento que domina claramente esta búsqueda, más estricto para el
  // resto, así el contexto queda diverso salvo que un solo documento sea
  // obviamente la fuente correcta (por ejemplo, un listado completo).
  const bestSourceForThisQuery = chunks[filtered[0].index].source;
  const secondBestScore = filtered.find(
    (s) => chunks[s.index].source !== bestSourceForThisQuery
  )?.score;
  const isDominant =
    !secondBestScore || topScore >= secondBestScore * DOMINANCE_RATIO;

  const perSourceCount = {};
  const picked = [];

  for (const s of filtered) {
    const chunk = chunks[s.index];
    const limit =
      isDominant && chunk.source === bestSourceForThisQuery
        ? MAX_CHUNKS_TOP_SOURCE
        : MAX_CHUNKS_PER_SOURCE;
    const count = perSourceCount[chunk.source] || 0;
    if (count >= limit) continue;
    perSourceCount[chunk.source] = count + 1;
    picked.push(chunk);
    if (picked.length >= topN) break;
  }

  // Si el límite por documento dejó resultados afuera y aún hay espacio,
  // completamos con lo que sea (siempre respetando el orden de relevancia),
  // para no devolver menos fragmentos de los pedidos si hay más disponibles.
  if (picked.length < topN) {
    const pickedIds = new Set(picked.map((c) => c.id));
    for (const s of filtered) {
      const chunk = chunks[s.index];
      if (pickedIds.has(chunk.id)) continue;
      picked.push(chunk);
      pickedIds.add(chunk.id);
      if (picked.length >= topN) break;
    }
  }

  return picked;
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

// Quita tildes/acentos para comparar texto sin que las tildes afecten la búsqueda.
function normalizeText(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// Busca coincidencias EXACTAS de "Artículo N" en todos los fragmentos.
// Esto complementa la búsqueda por palabras clave (TF-IDF), que puede fallar
// con términos cortos y comunes como "artículo 1" (aparecen en casi todos
// los documentos, así que el puntaje de relevancia no los distingue bien).
function findArticleChunks(number, maxResults = 3) {
  const pattern = new RegExp(`art[ií]culo\\s+0*${number}(?!\\d)`, "i");
  return chunks.filter((c) => pattern.test(c.text)).slice(0, maxResults);
}

// Busca fragmentos cuyo texto contenga TODAS las palabras de la búsqueda
// (comparación literal, sin IA de por medio) — sirve para confirmar si algo
// específico quedó bien indexado.
function searchKeyword(query, maxResults = 10) {
  const words = normalizeText(query).split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return [];

  return chunks
    .filter((c) => {
      const normalizedText = normalizeText(c.text);
      return words.every((w) => normalizedText.includes(w));
    })
    .slice(0, maxResults);
}

module.exports = {
  loadIndex,
  search,
  addDocument,
  removeDocument,
  listSources,
  findArticleChunks,
  searchKeyword,
};
