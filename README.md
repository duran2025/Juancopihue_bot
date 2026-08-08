# Asistente Scout Web - Agrupación Nacional de Boy Scouts de Chile

Chatbot web (una página que se abre en el navegador) que responde preguntas
sobre tus manuales y reglamentos, usando IA (Claude) para buscar y explicar
la respuesta correcta dentro de tus documentos.

No necesitas WhatsApp, ni cuenta de Meta. Solo un repositorio en GitHub y
un despliegue en Render (gratis).

---

## Paso 0: Qué vas a necesitar

- [ ] Cuenta en **GitHub** (gratis)
- [ ] Cuenta en **Render.com** (gratis)
- [ ] Una **API Key gratuita de Google Gemini** (ver Paso 1.5 abajo — no requiere tarjeta de crédito)
- [ ] Tus 21 documentos convertidos a `.txt` (ver Paso 1)

---

## Paso 1: Preparar tus 21 documentos

El bot lee archivos `.txt` (texto plano), no PDF ni Word directamente.

**Si son Word (.docx):**
Abre el archivo → "Archivo" → "Guardar como" → elige formato "Texto sin formato (.txt)"

**Si son PDF:**
- Opción fácil: usa un conversor online (buscar "PDF a TXT online")
- Opción manual: abre el PDF, selecciona todo el texto (Ctrl+A), cópialo y pégalo en un archivo `.txt` nuevo

**Nombra cada archivo de forma clara**, por ejemplo:
```
Reglamento_Uniformes.txt
Manual_Progresion_Personal.txt
```
El nombre se usa para indicar de qué documento sale cada respuesta.

Pon los 21 archivos `.txt` dentro de la carpeta `/knowledge`, reemplazando el archivo de ejemplo.

---

## Paso 1.5: Conseguir tu API Key gratuita de Google Gemini

1. Ve a [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Inicia sesión con una cuenta de Google (Gmail).
3. Click en **"Create API Key"**.
4. Copia la clave que se genera (empieza distinto según el caso, pero es una cadena larga de letras y números).

Esto es gratis y no pide tarjeta de crédito. Tiene un límite de uso diario/por minuto en la capa gratuita — más que suficiente para un chatbot de agrupación con uso normal. Si en algún momento se supera ese límite, Gemini simplemente devuelve un error temporal (no te cobra).

---

## Paso 2: Subir el proyecto a GitHub

1. Crea un repositorio nuevo en GitHub (puede ser privado, ya tienes uno creado: `Juancopihue_bot` — puedes usar ese mismo o crear uno nuevo para esta versión).
2. En la página del repositorio: "Add file" → "Upload files".
3. Arrastra todos los archivos de esta carpeta (`server.js`, `retrieval.js`, `build-index.js`, `package.json`, `.env.example`, `README.md`) y la carpeta `public/` completa, y la carpeta `knowledge/` con tus 21 documentos ya en `.txt`.
4. Click en "Commit changes".

⚠️ No subas ningún archivo `.env` con tu clave real (el `.env.example` sí se sube, es solo la plantilla).

---

## Paso 3: Desplegar en Render

1. Entra a [render.com](https://render.com) (puedes usar tu cuenta de GitHub para entrar).
2. Click en "New +" → "Web Service".
3. Conecta el repositorio que acabas de subir.
4. Configuración:
   - **Build Command:** `npm install && npm run build-index`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. En **Environment Variables**, agrega:
   - `GEMINI_API_KEY` → tu clave gratuita de aistudio.google.com
   - `ADMIN_PASSWORD` → invéntate una contraseña segura (la vas a usar para entrar al panel de administración en `/admin.html`)
6. Click en "Create Web Service". Cuando termine, Render te da una URL como:
   `https://scout-web-bot.onrender.com`

Esa URL ya es tu chatbot funcionando — cualquiera con el link puede abrirlo y preguntar.

⚠️ **Nota sobre el plan gratis de Render:** el servidor "se duerme" tras un rato sin uso y tarda unos 30-50 segundos en "despertar" con la primera visita del día. Es normal, no es un error.

---

## Paso 4: Probar

Abre la URL que te dio Render. Deberías ver una página de chat con el encabezado "Asistente Scout". Escribe una pregunta, por ejemplo:
> "¿Cuál es el reglamento de uniformes?"

---

## Panel de administración: subir documentos y ver preguntas

Ahora el bot no solo lee los documentos de `/knowledge` al arrancar — también
puedes agregar documentos nuevos directamente desde una página web, sin tocar
GitHub.

1. Abre `https://tu-url.onrender.com/admin.html`
2. Ingresa la contraseña que pusiste en `ADMIN_PASSWORD`
3. Ahí puedes:
   - **Subir un documento nuevo** (PDF, Word `.docx` o `.txt`) — se agrega al instante a lo que el bot sabe, sin reiniciar nada
   - **Ver la lista de documentos** actualmente indexados, y eliminar alguno si ya no corresponde
   - **Ver las últimas preguntas** que la gente le ha hecho al bot — útil para detectar qué información falta o no está clara

⚠️ **Importante sobre el plan gratis de Render:** el almacenamiento de Render en el plan Free **no es permanente** — los documentos que subas desde `/admin.html` sobreviven mientras el servicio siga corriendo normalmente, pero **se pierden la próxima vez que hagas un nuevo deploy** (por ejemplo, al subir un cambio de código a GitHub). Para que un documento quede de forma permanente, complementa subiéndolo también como `.txt` a la carpeta `/knowledge` en GitHub (ver Paso 1 y 2 más arriba). Si más adelante quieres que las subidas queden siempre guardadas sin hacer este paso extra, se puede agregar un "disco persistente" de Render (tiene un costo mensual bajo) — avísame si llegas a ese punto y te ayudo a configurarlo.

### Sobre "que el chatbot aprenda solo"

El bot no se reentrena automáticamente con lo que la gente le escribe (eso
sería riesgoso: cualquiera podría "enseñarle" información falsa a propósito).
En cambio, el sistema que se armó funciona así:
- El conocimiento del bot **crece cuando un administrador sube documentos nuevos** desde el panel.
- El **registro de preguntas** te muestra qué se está preguntando, para que un humano decida qué agregar o aclarar.

Esto es más seguro y confiable que un "aprendizaje" automático sin supervisión.

---

## Cómo actualizar los documentos más adelante

1. Reemplaza o agrega archivos `.txt` en `/knowledge` en GitHub.
2. Render vuelve a desplegar automáticamente (o fuerza un "Manual Deploy" en el panel de Render), lo cual corre de nuevo `npm run build-index` y actualiza lo que el bot sabe.

---

## Estructura del proyecto

```
scout-web-bot/
├── server.js          # Servidor (sirve la página y responde preguntas)
├── retrieval.js        # Motor de búsqueda dentro de tus documentos
├── build-index.js       # Convierte tus documentos en un índice buscable
├── public/
│   └── index.html        # La página de chat que ven los usuarios
├── package.json
├── .env.example         # Plantilla de variables de entorno
└── knowledge/            # Aquí van tus 21 documentos .txt
```

## Personalizar el diseño

El estilo (colores, logo, textos) está todo en `public/index.html`, en la
sección `<style>` y en el `<header>`. Puedes cambiar el color verde, el
emoji del logo o los textos de bienvenida directamente ahí sin tocar nada
del servidor.

## Si algo falla

- **La página carga pero no responde:** revisa los "Logs" en el panel de Render, ahí aparecen los errores. Lo más común es que falte o esté mal copiada la `GEMINI_API_KEY`.
- **Respuestas raras o vacías:** verifica que `npm run build-index` se haya ejecutado bien (debería listar tus 21 documentos en el log del build de Render).
