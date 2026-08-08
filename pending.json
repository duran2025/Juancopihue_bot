// lib/chunk.js
// Función compartida para dividir un texto largo en fragmentos (chunks)
// más pequeños, usada tanto por build-index.js (documentos iniciales) como
// por el servidor (documentos subidos desde el panel de administración).

const CHUNK_SIZE = 220; // palabras por fragmento
const CHUNK_OVERLAP = 40; // palabras de superposición entre fragmentos

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

module.exports = { chunkText, CHUNK_SIZE, CHUNK_OVERLAP };
