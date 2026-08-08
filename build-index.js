// build-index.js
// Lee todos los archivos .txt de la carpeta /knowledge, los divide en fragmentos
// (chunks) y genera un archivo index.json que el servidor usa para buscar
// las partes más relevantes de tus manuales cuando alguien pregunta algo.
//
// Uso: npm run build-index
// (hay que correrlo de nuevo cada vez que agregues o cambies documentos)

const fs = require("fs");
const path = require("path");

const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");
const OUTPUT_FILE = path.join(__dirname, "index.json");

// Tamaño de cada fragmento (en palabras) y superposición entre fragmentos
// para no cortar ideas a la mitad.
const CHUNK_SIZE = 220;
const CHUNK_OVERLAP = 40;

function chunkText(text, sourceName) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < words.length) {
    const end = Math.min(start + CHUNK_SIZE, words.length);
    const chunkWords = words.slice(start, end);
    chunks.push({
      id: `${sourceName}#${chunkIndex}`,
      source: sourceName,
      text: chunkWords.join(" "),
    });
    chunkIndex++;
    if (end === words.length) break;
    start = end - CHUNK_OVERLAP;
  }

  return chunks;
}

function main() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    console.error(`No existe la carpeta ${KNOWLEDGE_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.toLowerCase().endsWith(".txt"));

  if (files.length === 0) {
    console.error(
      "No encontré archivos .txt en /knowledge. Convierte tus PDFs/Word a .txt y ponlos ahí (ver README)."
    );
    process.exit(1);
  }

  let allChunks = [];

  for (const file of files) {
    const filePath = path.join(KNOWLEDGE_DIR, file);
    const raw = fs.readFileSync(filePath, "utf-8");
    const cleaned = raw.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
    const sourceName = path.basename(file, ".txt");
    const chunks = chunkText(cleaned, sourceName);
    allChunks = allChunks.concat(chunks);
    console.log(`- ${file}: ${chunks.length} fragmentos`);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allChunks, null, 2), "utf-8");
  console.log(
    `\nListo. Se generaron ${allChunks.length} fragmentos en total desde ${files.length} documento(s).`
  );
  console.log(`Índice guardado en: ${OUTPUT_FILE}`);
}

main();
