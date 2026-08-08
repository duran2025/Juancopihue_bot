# Bot de WhatsApp - Agrupación Nacional de Boy Scouts de Chile

Chatbot que responde preguntas sobre tus manuales y reglamentos por WhatsApp,
usando IA (Claude) para entender la pregunta y buscar la respuesta correcta
dentro de tus documentos.

No necesitas saber programar para ponerlo en marcha: sigue estos pasos en orden.

---

## Paso 0: Qué vas a necesitar antes de empezar

- [ ] Tu cuenta de **Meta for Developers** con la app de WhatsApp Business ya creada (la que ya tienes)
- [ ] Una cuenta gratis en **Render.com** (para alojar el bot)
- [ ] Una cuenta gratis en **GitHub** (para subir el código, Render se conecta desde ahí)
- [ ] Una **API Key de Anthropic** (se genera en console.anthropic.com > "API Keys"). Ojo: el uso de la API tiene costo según cuántos mensajes reciba el bot (es distinto a tu suscripción de Claude.ai), pero para un bot de agrupación scout el gasto mensual normalmente es bajo.
- [ ] Tus 21 documentos convertidos a `.txt` (ver Paso 1)

---

## Paso 1: Preparar tus 21 documentos

El bot lee archivos `.txt` (texto plano), no PDF ni Word directamente. Hay que convertir cada uno:

**Si son Word (.docx):**
Abre el archivo → "Archivo" → "Guardar como" → elige formato "Texto sin formato (.txt)"

**Si son PDF:**
- Opción fácil: usa un conversor online como `pdftotext` (varias páginas gratis lo ofrecen, ej. buscar "PDF a TXT online")
- Opción manual: abre el PDF, selecciona todo el texto (Ctrl+A), cópialo (Ctrl+C) y pégalo en un archivo `.txt` nuevo (con el Bloc de Notas, por ejemplo)

Con 21 documentos esto toma un rato, pero es un trabajo de una sola vez.

**Nombra cada archivo de forma clara**, por ejemplo:
```
Reglamento_Uniformes.txt
Manual_Progresion_Personal.txt
Reglamento_Disciplinario.txt
```
El nombre del archivo se usa para indicarle al usuario de qué documento sale cada respuesta, así que nombres claros ayudan mucho.

Pon los 21 archivos `.txt` dentro de la carpeta `/knowledge`, reemplazando el archivo de ejemplo `EJEMPLO-reemplazame.txt`.

---

## Paso 2: Subir el proyecto a GitHub

1. Crea una cuenta en [github.com](https://github.com) si no tienes.
2. Crea un repositorio nuevo (botón "New repository"), puede ser privado.
3. Sube todos los archivos de esta carpeta (`scout-whatsapp-bot`) al repositorio. La forma más fácil sin usar la terminal: en la página del repositorio, botón "Add file" → "Upload files", y arrastras todos los archivos y la carpeta `/knowledge` con tus documentos ya convertidos.

⚠️ **No subas el archivo `.env`** (si llegas a crear uno local) — ahí van tus claves secretas y no deben quedar públicas. El archivo `.env.example` sí se sube, ese es solo una plantilla sin datos reales.

---

## Paso 3: Desplegar en Render

1. Crea una cuenta en [render.com](https://render.com) (puedes entrar con tu cuenta de GitHub).
2. Click en "New +" → "Web Service".
3. Conecta el repositorio de GitHub que acabas de crear.
4. Configuración:
   - **Build Command:** `npm install && npm run build-index`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. En la sección **Environment Variables**, agrega estas (los valores salen de Meta for Developers y de tu cuenta de Anthropic):
   - `META_VERIFY_TOKEN` → invéntate un texto secreto (ej: `scout2026secreto`)
   - `META_ACCESS_TOKEN` → lo copias desde Meta for Developers > tu app > WhatsApp > API Setup
   - `META_PHONE_NUMBER_ID` → también está en esa misma pantalla de Meta
   - `ANTHROPIC_API_KEY` → tu clave de console.anthropic.com
6. Click en "Create Web Service". Render va a instalar todo y arrancar el bot. Cuando termine, te da una URL parecida a:
   `https://scout-whatsapp-bot.onrender.com`

⚠️ **Nota sobre el plan gratis de Render:** el servidor "se duerme" después de un rato sin uso, y tarda unos 30-50 segundos en "despertar" con el primer mensaje después de estar inactivo. Para un bot de agrupación esto normalmente no es problema (el primer mensaje del día puede demorar un poco más). Si más adelante quieres que responda siempre al instante, se puede pasar a un plan pago económico.

---

## Paso 4: Conectar el webhook en Meta

1. Ve a [Meta for Developers](https://developers.facebook.com/) → tu app → WhatsApp → Configuration.
2. En "Webhook", click "Edit".
3. **Callback URL:** `https://tu-url-de-render.onrender.com/webhook`
4. **Verify Token:** el mismo texto que pusiste en `META_VERIFY_TOKEN` en Render.
5. Click "Verify and Save". Si todo está bien configurado, debería verificarse sin error.
6. En "Webhook fields", suscríbete al campo **messages**.

---

## Paso 5: Probar

Escríbele por WhatsApp al número de tu app de Meta, algo como:
> "¿Cuál es el reglamento de uniformes?"

El bot debería buscar en tus documentos y responder basándose en ellos.

---

## Cómo actualizar los documentos más adelante

1. Reemplaza o agrega archivos `.txt` en `/knowledge` en GitHub.
2. Render vuelve a desplegar automáticamente (o puedes forzarlo con "Manual Deploy" en el panel de Render), lo cual corre de nuevo `npm run build-index` y actualiza lo que el bot sabe.

---

## Estructura del proyecto

```
scout-whatsapp-bot/
├── server.js          # Servidor principal (recibe y responde mensajes)
├── retrieval.js        # Motor de búsqueda dentro de tus documentos
├── build-index.js       # Convierte tus documentos en un índice buscable
├── package.json
├── .env.example         # Plantilla de variables de entorno
└── knowledge/            # Aquí van tus 21 documentos .txt
```

## Si algo falla

- **El webhook no se verifica en Meta:** revisa que `META_VERIFY_TOKEN` sea idéntico en Render y en Meta.
- **El bot no responde:** revisa los "Logs" en el panel de Render, ahí aparecen los errores.
- **Respuestas raras o vacías:** verifica que `npm run build-index` se haya ejecutado bien (debería listar tus 21 documentos en el log del build de Render).
