# Inkara Draw — notas para seguir desarrollando

Léelo antes de tocar el código. Aquí está lo que ya se decidió, los errores que ya pasaron y cómo no repetirlos.

## Qué es
Editor vectorial de escritorio (Windows) tipo CorelDRAW, para una persona que diseña **placas de aluminio para sublimar**: diplomas, panorámicas, agradecimientos, reconocimientos. Muchos estilos y colores, casi nunca con foto. Todo en **español de México**, con palabras sencillas.

- Nombre: **Inkara Draw** (antes "Trazo"). Ícono: camaleón grabado a tinta sobre verde esmeralda `#1E9E76`. Nombre escrito en letra antigua (GFS Baskerville) con "DRAW" verde alineado a la derecha.
- Archivos de diseño: **`.ink`**. Los `.trz` viejos se siguen abriendo. Formato interno sigue siendo `trazo` (no cambiar: rompe archivos).
- `userData` está fijado a `%APPDATA%\Trazo` (main.ts) para no perder plantillas/fuentes al renombrar. `appId` sigue `mx.trazo.editor`. No cambiar ninguno de los dos.
- Pantalla de inicio: camaleón gigante que se pinta de color + abanico de colores (index.html, app.css, main.ts).

## Decisiones del usuario (respetarlas)
- **IA sin Claude API y sin Ollama.** Solo cosas que corran en la computadora (p. ej., quitar fondo con un modelo ligero). "Diseñar escribiendo" se descartó.
- Los CDR de Corel 2024 se traen **exportando PDF desde Corel** y abriéndolo (libcdr pierde rellenos). Un PDF de varias páginas se puede abrir por páginas o guardar cada página como plantilla.
- Todo objeto debe poder moverse/editarse.

## Arquitectura
- Electron 44: `src/main` (sistema, archivos, IPC validado), `src/preload` (`window.trazo`), `src/renderer` (UI), `src/engine` (motor puro, probado con tests).
- Documento inmutable en mm con matrices afines; historial por instantáneas (incluye páginas). `doc.shapes` es la página actual; `allPages`/`withPages`/`pageDocument`.
- Formato v2: nodos de curva empaquetados (redondeo 1e-6 mm solo en nodos).
- PDF: pdf.js 6.2.108 (`engine/pdf-import.ts` convierte operadores a figuras; el worker se copia a `dist/renderer`).
- Plantillas: `TemplateService` en main (`userData/plantillas/Nombre.trz + .png`).
- Placas en serie: Archivo › Placas en serie… (Ctrl+M). Hoy: pegar tabla o abrir CSV; `{{Columna}}` en textos; salida PNG/JPG/PDF/PDF único.

## Errores que ya pasaron (no repetir)
- pdf.js v6: no existe `isEvalSupported`; usar `task.destroy()`; pasar `bytes.slice()` (pdf.js se queda con el buffer).
- Importar pdf-open de forma dinámica falló: usar import estático.
- `.trz` de 20 MB: se resolvió empaquetando nodos; no redondear todo el JSON (rompe la prueba de ida y vuelta).
- Muchas pestañas de página empujaban la paleta fuera de pantalla: `.workspace{min-width:0}` y `.pager{overflow:hidden}`.
- Doble cambio de casilla en el selector de PDF: no poner un clic extra en el canvas dentro del label.
- Una página con solo foto marcada como campo no es plantilla: solo los textos `{{…}}` marcan plantilla.
- Ids de degradados SVG repetidos rompen íconos: hacer ids únicos antes de insertar.
- Sin internet a npm en el entorno de Claude: enlazar `esbuild`/`typescript`/`pdfjs-dist` desde `/opt/npm-tools/node_modules` y `~/.npm-global/lib/node_modules`.

## Cómo comprobar antes de entregar
1. `npm run build` y `npm test` (26 pruebas del motor deben pasar).
2. Abrir `dist/renderer/index.html` con Playwright y revisar que no haya errores de página.
3. Prueba de humo: clic en cada opción de cada menú, sin selección y con selección (0 errores en la 1.5).
4. Mirar capturas: pantalla de inicio, ventana, tema claro y oscuro.

## Cómo son sus placas reales (cliente universitario, octubre 2026)
- Verticales, se imprimen de 2 en 2. Acabados reales: **Blanco** (con marco negro), **Negro** (letras blancas) y **Bronce** (textura de metal cepillado = imagen, no color).
- El logo cambia según carrera/facultad (logo general, Administración, Ingeniería); algunas llevan yin-yang.
- **Hay modelos/paquetes distintos** (pendiente que el usuario explique medidas):
  - Básico: placa con margen negro alrededor.
  - Base con placa atrás: la placa va delante de otra y es más chica.
  - Con escultura: la placa deja un **hueco en medio** (ahí va la figura); no poner texto ahí.
- Pantalla de revisar aprobada: "Estudio oscuro", vista Hojas (2 por hoja) + Cuadrícula/Lista, filtros por acabado, panel derecho con la misma placa en los 3 acabados. Mostrar placas completas (sin recortes) y no dibujar contornos encima de la placa.

## Hecho en 1.6
- `engine/xlsx.ts` (lector de Excel propio: ZIP + XML; descompresión inyectada), `engine/finishes.ts` (acabados: cambios de color + textura como PowerClip dentro de la figura del fondo; se guardan en `doc.finishes`; `merge.finishColumn`).
- `renderer/ui/batch-dialog.ts` (asistente de 4 pasos, pantalla completa, clases `bt-*`), `finishes-dialog.ts`, `textures.ts` (metal cepillado dibujado en canvas), `list-file.ts`.
- Plantillas con categoría (`plantillas/categorias.json` en main). Salida `pdf-pairs` (2 por hoja A4).
- Pantalla de inicio en `renderer/splash.ts` (corre primero y se quita sola a los 5 s pase lo que pase).
- **CSP:** no usar atributo `style` en `h()`; usar `el.style.cssText` (helper `css()`).
- Ventanas modales encima de `.bt`: `.bt ~ .modal-backdrop { z-index: 1000 }`.

## Hecho en 1.7
- `merge.fitFieldText` (2 líneas y luego achicar hasta `MIN_FIT` = 70 %; `merge.fit === false` lo apaga); avisos en revisar (`adjusted`).
- `showWhen` en objetos (`conditionHolds`: la celda contiene alguno de los valores separados por `|`), diálogo `condition-dialog.ts`.
- `engine/sheet.ts` (`planSheet`, `cropMarks`), salida `pdf-sheet` con `SheetComposer` en `renderer/merge.ts`; ajustes de papel guardados con la salida.
- `error-log.ts` + `report-dialog.ts` + IPC `app:capture` (`capturePage`). Exportar acepta `html`.
- Los **modelos de placa** (básico, placa atrás, escultura) siguen pendientes: faltan las medidas del usuario.

## Hecho en 1.8
- `engine/split.ts` (`splitIntoPlates`, `withBackground`), `ui/plate-tools.ts` (Dividir en placas, Convertir textos en campos con `guessRoles`).
- `engine/names.ts` (`checkName`, `isNameColumn`; lista de acentos comunes, sin tocar Ortiz/Ruiz/Valdez), avisos y "Corregir N nombres" en revisar.
- Material del pedido (`materialText` en batch-dialog). Acabados: solo grises (`neutral`) se invierten, oscuros hasta luma 140.
- `engine/background.ts` + `ui/background-dialog.ts` (quitar fondo por color de la orilla).
- Biblioteca de elementos: `TemplateService` en `userData/elementos`, IPC `elements:*`, `ui/elements-dialog.ts`.
- Fuentes favoritas en `font-picker.ts` (localStorage `inkara.fonts.favorites`); aviso de fuentes faltantes en revisar.
- **Pruebas visuales en el entorno de Claude:** el PDF real necesita servirse por HTTP (`python3 -m http.server` en `dist/renderer`) para el worker de pdf.js; sus fuentes se extrajeron del PDF solo para probar (`~/.local/share/fonts/inkara-test`, script en scratchpad). Nunca se distribuyen.

## Hecho en 1.8.1
- `split.ts`: `detectPlates` (columnas `'auto'`: figuras grandes sin encimarse que cubren ≥55 % de lo dibujado), fondo blanco por placa, `fitToContent` al guardar.
- `plate-tools.ts`: `openSavePagesDialog` (firma `designSignature` para no repetir; `kindOf` separa diploma/agradecimiento), `autoFields` en todas las páginas; `retext` conserva el centro.
- Paquetes `.inkpack` en `templates-dialog.ts`: JSON `{format:'inkara-plantillas', version:1, templates:[{name, category, content, thumbnail}]}`; importar pregunta si reemplaza los repetidos.
- Guía de uso para el usuario y su compañero: doc "Guía de Inkara Draw" (claude.ai/artifact/72cW1eGVQwFTw1YdVk3JAa).

## Instaladores de un clic (preparado, falta GitHub o la PC del usuario)
- `package.json`: NSIS `oneClick: true` + `runAfterFinish` (doble clic y se instala solo, abre la app), nombres fijos `InkaraDraw-Windows.exe`, `InkaraDraw-Linux.AppImage`, `InkaraDraw-Mac.dmg` (sin firma). Scripts `dist`, `dist:linux`, `dist:mac`.
- `.github/workflows/instaladores.yml`: arma los tres al subir una etiqueta `v*` y los deja en Releases (enlace fijo `releases/latest/download/...`).
- Desde el entorno de Claude NO se puede armar: npm, GitHub y HuggingFace están bloqueados. Opciones: cuenta de GitHub del usuario, o correr `npm run dist` en su PC con el enlace del escritorio (Windows tiene voces SAPI en español para narrar videos).

## Hecho en 1.8.2
- Pantalla de inicio en video: `brand/intro.mp4` (completa, con sonido, primera vez; `localStorage inkara.intro.visto`) y `brand/intro-corta.mp4` (final, sin sonido). `splash.ts`: `playIntro` con botón Saltar y respaldo a la pantalla del abanico si el video falla o no arranca en 2.5 s; `replayIntro` en Ayuda. `main.ts`: `autoplay-policy=no-user-gesture-required`.
- La animación se genera aparte (canvas → cuadros a 60 fps → ffmpeg): `propuestas/intro.js` escena `luz` (malla del camaleón, mundo 3D en primera persona, lluvia, relámpagos, hojas que caen con vaivén, remolino de luciérnagas, charco con reflejo) y `propuestas/sonido_luz.py` (lluvia, truenos, pasos, campanitas + música cinemática). El usuario la aprobó.

## Página de descarga (aprobada: propuesta A "Noche de luciérnagas")
- Lema de la app (elegido por el usuario): **"Persigue tus ideas. Inkara las llena de color."** Frase de apoyo: "El editor para tus placas, diplomas y reconocimientos para sublimar. Haz todo un grupo desde tu Excel en minutos."
- `docs/` = página para GitHub Pages (`docs/index.html` + fondo-luz.mp4, tutorial.mp4, inkara-macro-corel.zip). `const REPO` ya apunta al repositorio real; los botones apuntan a `releases/latest/download/InkaraDraw-*.{exe,dmg,AppImage}`.
- Vista previa en claude.ai/artifact/NMym8hH2B9UYQi5abLdDPY (ahí las descargas no funcionan; en GitHub Pages sí).
- Tutorial rehecho con datos de ejemplo ("Universidad de Ejemplo", nombres inventados): `video/pdf_ejemplo.py` → `qa/ejemplo-corel.pdf`, paquete `qa/plantillas-ejemplo.inkpack`, lista `qa/pedido-ejemplo.xlsx`. Voz: Windows SAPI "Microsoft Sabina Desktop" (es-MX) en la laptop del usuario (carpeta conectada Documentos\\inkara voz, `grabar-voz.bat`). Repositorio: **mendozaherreraosvaldo08-netizen/inkara-draw-** (con guion final) → página en mendozaherreraosvaldo08-netizen.github.io/inkara-draw-/ (Pages desde `main` /docs).

## Lo que sigue (acordado, en este orden)
1. **Pendiente de 1.7:** modelos de placa (básico con margen negro, base con placa atrás más chica, con escultura = hueco al centro sin texto; faltan medidas en pulgadas), **nombres que siempre caben** (primero 2 líneas/espaciado, luego achicar hasta 70%), logo según carrera, revisión antes de imprimir (fuentes faltantes) y **Ayuda › Reportar un problema**.
2. **1.8:** acomodo en hoja para sublimar más completo (tamaños de papel, marcas de corte, aprovechar papel) e impresión directa; abrir CDR con ayuda de las macros de Corel (PDF automático).
3. **2.0:** arreglos tras usarla con pedidos reales.
4. **2.1 Diseñar más rápido:** biblioteca de elementos (logos de escuelas, escudos, marcos, adornos) para arrastrar; fuentes favoritas arriba y aviso de fuentes faltantes por plantilla; cambiar un logo en todas las plantillas a la vez.
5. **2.2 Producir sin errores:** pedidos (escuela, generación, entrega; lista + plantilla + qué se imprimió; reimprimir una sola placa); revisión de ortografía/acentos de nombres ("Ramirez" → "Ramírez"); contador de material (láminas, hojas, tinta).
6. **2.3 IA sin internet:** quitar fondos; limpiar logos borrosos de WhatsApp a curvas; asistente de órdenes en español ("pon todos los nombres en dorado").
7. Descartado por ahora (el usuario no lo quiere): catálogo para clientes, aprobación del cliente por enlace, vista previa para vender. Después: la app aprende de las correcciones; abrir SVG de Corel como objetos.
- Hecho: plantillas por categoría, acabados por fila, 2 por hoja en PDF, aviso de nombres que se salen (1.6).
