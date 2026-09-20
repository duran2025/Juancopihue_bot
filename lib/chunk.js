// lib/chunk.js
// Función compartida para dividir un texto largo en fragmentos (chunks)
// más pequeños, usada tanto por build-index.js (documentos iniciales) como
// por el servidor (documentos subidos desde el panel de administración).

const CHUNK_SIZE = 220; // palabras por fragmento
const CHUNK_OVERLAP = 40; // palabras de superposición entre fragmentos

// Muchos PDFs traen, en cada página, el mismo encabezado o pie de página
// repetido (ej. "Manual de Uniformes, Insignias, Distintivos y Banderas").
// Al extraer el texto, esa línea termina apareciendo docenas de veces a lo
// largo del documento, y como es texto real (no ruido evidente), termina
// metida en casi todos sus fragmentos. Esto contamina la búsqueda: una
// palabra de esa línea repetida (ej. "Banderas") parece aparecer por todo
// el documento, tapando a los fragmentos donde esa palabra sí es relevante
// de verdad. Quitamos esas líneas repetidas antes de trocear el texto.
const MIN_REPEATS_TO_STRIP = 4;
const MIN_LINE_LENGTH_TO_STRIP = 12; // no tocar líneas cortas (pueden ser subtítulos legítimos)

function stripRepeatedLines(text) {
  const lines = text.split("\n");
  const counts = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < MIN_LINE_LENGTH_TO_STRIP) continue;
    counts.set(trimmed, (counts.get(trimmed) || 0) + 1);
  }
  const repeated = new Set(
    [...counts.entries()]
      .filter(([, count]) => count >= MIN_REPEATS_TO_STRIP)
      .map(([line]) => line)
  );
  if (repeated.size === 0) return text;
  return lines.filter((line) => !repeated.has(line.trim())).join("\n");
}

function chunkText(text, sourceName) {
  const cleanedText = stripRepeatedLines(text);
  const words = cleanedText.split(/\s+/).filter(Boolean);
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

module.exports = { chunkText, stripRepeatedLines, CHUNK_SIZE, CHUNK_OVERLAP };
