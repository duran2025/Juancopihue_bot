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
// Texto normalizado de cada fragmento, en el mismo orden que 'chunks'.
// Se recalcula junto con el índice TF-IDF (ver rebuildTfidf) para no tener
// que normalizar 13.000+ fragmentos en cada pregunta que se haga.
let normalizedChunkTexts = [];

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
  normalizedChunkTexts = chunks.map((chunk) => normalizeForSearch(chunk.text));
  for (const normalizedText of normalizedChunkTexts) {
    // Indexamos la versión normalizada (sin tildes) de cada fragmento, no
    // el texto crudo. El texto original se conserva intacto en chunk.text
    // para mostrarlo/enviarlo a la IA tal cual está escrito.
    tfidf.addDocument(normalizedText);
  }
}

// Palabras "genéricas" de una pregunta (pronombres, conectores, verbos de
// pedido) que NUNCA cuentan como distintivas de un tema, aunque sean
// poco comunes en la biblioteca por casualidad.
const QUESTION_STOPWORDS = new Set([
  "cuales", "cuando", "donde", "dame", "puedes", "podrias", "decime",
  "cuanto", "cuanta", "cuantos", "cuantas", "existe", "existen", "sobre",
  "segun", "estas", "estos", "esas", "esos", "quiero", "necesito", "favor",
]);

// Reduce una palabra a una forma aproximada de singular, para que
// "banderas" (como la escribe quien pregunta) también encuentre fragmentos
// que dicen "bandera" en singular (como suele estar redactado un
// reglamento, describiendo cada bandera una por una). Es una heurística
// simple, no un analizador morfológico real, pero alcanza para este uso.
function toApproximateSingular(word) {
  if (word.length > 6 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

// Un buscador por palabras clave (como este) no entiende sinónimos: si el
// reglamento dice "Dimensiones: 90 x 140 cm" y preguntan por "medidas", no
// hay ninguna coincidencia de palabras que los conecte, aunque para
// cualquier persona sean lo mismo. Esta lista cubre los pares de sinónimos
// detectados en uso real; agregar uno nuevo es una línea.
const QUERY_SYNONYMS = {
  medida: ["dimension"],
  dimension: ["medida"],
};

// Agrega a la pregunta, además de sus palabras originales, los sinónimos
// conocidos de esas palabras — así una pregunta por "medidas" también
// encuentra fragmentos que solo dicen "Dimensiones", y viceversa.
function expandQueryWithSynonyms(normalizedQuery) {
  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  const extra = [];
  for (const word of words) {
    const stem = toApproximateSingular(word);
    if (QUERY_SYNONYMS[stem]) extra.push(...QUERY_SYNONYMS[stem]);
  }
  return extra.length > 0
    ? `${normalizedQuery} ${extra.join(" ")}`
    : normalizedQuery;
}

// De las palabras de una pregunta, ¿cuáles son realmente distintivas del
// tema (aparecen en pocos fragmentos de TODA la biblioteca)? Sirve para
// casos como "medidas reglamentarias de las banderas": dentro de un mismo
// manual que mezcla uniformes, insignias y banderas, hay muchos más
// fragmentos sobre medidas de insignias que sobre medidas de banderas, y
// por puntaje general esos otros fragmentos pueden ganarle a los que sí
// importan. "banderas" es la palabra que de verdad distingue qué se está
// preguntando, así que un fragmento que la contenga literalmente (en
// singular o plural) merece prioridad dentro de su propio documento,
// aunque su puntaje TF-IDF general sea menor que el de otro fragmento del
// mismo documento sobre un tema parecido pero distinto.
function findDistinctiveTerms(query, maxShareOfLibrary = 0.05) {
  const words = [
    ...new Set(
      normalizeForSearch(query)
        .split(/\s+/)
        .filter((w) => w.length >= 5 && !QUESTION_STOPWORDS.has(w))
        .map(toApproximateSingular)
    ),
  ];
  if (words.length === 0 || normalizedChunkTexts.length === 0) return [];

  const total = normalizedChunkTexts.length;
  const distinctive = [];
  for (const word of words) {
    const re = new RegExp(`\\b${word}`, "i"); // prefijo: cubre singular/plural
    let count = 0;
    for (const text of normalizedChunkTexts) {
      if (re.test(text)) count++;
    }
    if (count > 0 && count / total <= maxShareOfLibrary) {
      distinctive.push(word);
    }
  }
  return distinctive;
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
//
// Ranking en dos niveles (importante para bibliotecas grandes con muchos
// documentos, como esta): primero se ordenan los DOCUMENTOS según su mejor
// fragmento, y luego se toman fragmentos dentro de cada documento en ese
// orden. Si se ordenara todo junto por fragmento (como se hacía antes), un
// documento muy extenso y muy concentrado en una palabra de la pregunta
// (ej: un manual entero sobre "el Clan" cuando preguntan por "el Clan")
// puede ocupar, solo, varias de las primeras posiciones del ranking de
// fragmentos y así dejar completamente afuera del top N a documentos más
// cortos que sí son relevantes pero para los que esa palabra es menos
// frecuente en términos absolutos (ej: un documento nuevo sobre "escollos
// del Clan" que menciona "Clan" solo un par de veces).
function search(query, topN = 5) {
  if (!tfidf) loadIndex();

  const scores = [];
  tfidf.tfidfs(expandQueryWithSynonyms(normalizeForSearch(query)), (i, measure) => {
    scores.push({ index: i, score: measure });
  });

  const positiveScores = scores.filter((s) => s.score > 0);
  if (positiveScores.length === 0) return [];

  // Puntaje de cada DOCUMENTO = el de su mejor fragmento para esta pregunta.
  const bestScoreBySource = {};
  for (const s of positiveScores) {
    const source = chunks[s.index].source;
    if (!bestScoreBySource[source] || s.score > bestScoreBySource[source]) {
      bestScoreBySource[source] = s.score;
    }
  }

  const rankedSources = Object.entries(bestScoreBySource).sort(
    (a, b) => b[1] - a[1]
  );
  const topScore = rankedSources[0][1];

  // Descartamos documentos demasiado débiles comparados con el mejor de
  // esta búsqueda (ruido de palabras sueltas que aparecen por casualidad).
  const eligibleSources = rankedSources.filter(
    ([, score]) => score >= topScore * MIN_RELATIVE_SCORE
  );

  const bestSourceForThisQuery = eligibleSources[0][0];
  const secondBestScore = eligibleSources[1]?.[1];
  const isDominant =
    !secondBestScore || topScore >= secondBestScore * DOMINANCE_RATIO;

  // Fragmentos de cada documento elegible, ya ordenados por relevancia
  // dentro de ese documento — pero primero los que contienen literalmente
  // alguna palabra distintiva de la pregunta (ver findDistinctiveTerms),
  // para que no se pierdan detrás de otros fragmentos de un tema parecido
  // que solo comparten palabras genéricas.
  const distinctiveTerms = findDistinctiveTerms(query);
  const chunksBySource = {};
  for (const s of positiveScores) {
    const source = chunks[s.index].source;
    if (!(source in bestScoreBySource)) continue;
    (chunksBySource[source] ||= []).push(s);
  }
  for (const source in chunksBySource) {
    chunksBySource[source].sort((a, b) => {
      if (distinctiveTerms.length > 0) {
        const aHas = distinctiveTerms.some((t) =>
          normalizedChunkTexts[a.index].includes(t)
        );
        const bHas = distinctiveTerms.some((t) =>
          normalizedChunkTexts[b.index].includes(t)
        );
        if (aHas !== bHas) return aHas ? -1 : 1;
      }
      return b.score - a.score;
    });
  }

  // Recorremos los documentos en orden de relevancia y, de cada uno,
  // tomamos sus mejores fragmentos — más de ellos para el documento que
  // domina claramente esta búsqueda, menos para el resto, así el contexto
  // queda diverso salvo que un solo documento sea obviamente la fuente
  // correcta (por ejemplo, un listado completo).
  const picked = [];
  for (const [source] of eligibleSources) {
    const limit =
      isDominant && source === bestSourceForThisQuery
        ? MAX_CHUNKS_TOP_SOURCE
        : MAX_CHUNKS_PER_SOURCE;
    for (const s of chunksBySource[source].slice(0, limit)) {
      picked.push(chunks[s.index]);
      if (picked.length >= topN) break;
    }
    if (picked.length >= topN) break;
  }

  // Si el límite por documento dejó espacio libre (pocos documentos
  // elegibles con pocos fragmentos cada uno), completamos con lo que sea,
  // siempre respetando el orden de relevancia por documento y luego por
  // fragmento, para no devolver menos fragmentos de los pedidos si hay
  // más disponibles.
  if (picked.length < topN) {
    const pickedIds = new Set(picked.map((c) => c.id));
    for (const [source] of eligibleSources) {
      for (const s of chunksBySource[source]) {
        const chunk = chunks[s.index];
        if (pickedIds.has(chunk.id)) continue;
        picked.push(chunk);
        pickedIds.add(chunk.id);
        if (picked.length >= topN) break;
      }
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
