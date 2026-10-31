# Inkara Draw — editor vectorial de escritorio para Windows

Editor vectorial pensado para diseñar **placas de graduación para sublimar**: páginas al tamaño de la placa, sangrado, margen seguro y exportación a 300 ppp. Se construye por pasos con **Electron + TypeScript**. El motor de dibujo va separado de la interfaz.

> Antes se llamaba "Trazo". Desde la 1.5 se llama **Inkara Draw** (ícono: camaleón grabado a tinta sobre verde esmeralda).
> - Los diseños se guardan como **`.ink`**; los `.trz` de antes se siguen abriendo (doble clic, Abrir o arrastrar).
> - Plantillas, fuentes, recientes y ajustes siguen en la misma carpeta de datos (`%APPDATA%\Trazo`): nada se pierde al actualizar.
> - Ícono y nombre: `assets/icon.ico`, `assets/icon.png` y `src/renderer/brand/` (pantalla de inicio y barra de título).
> La distribución de la pantalla (herramientas a la izquierda, paleta a la derecha, propiedades arriba) es la clásica de los editores vectoriales. El código, los íconos y la marca son propios: no se copia nada de CorelDRAW.

## Instalar Inkara Draw en Windows (el .exe)

La forma más fácil, sin escribir comandos:

1. Instala **Node.js 22 o más nuevo** desde https://nodejs.org (la versión "LTS", con *Siguiente, Siguiente*).
2. Descomprime este zip en una carpeta (por ejemplo `Documentos\trazo`).
3. Haz doble clic en **`CREAR-INSTALADOR.bat`**. La primera vez descarga Electron (unos minutos).
4. Se abre la carpeta `release` con **`Trazo-Instalador-1.4.0.exe`**. Ejecútalo e instala.

El instalador crea el acceso directo en el escritorio y el menú Inicio, permite elegir la carpeta, y hace que los archivos **.trz** se abran con Trazo al darles doble clic. Se desinstala desde *Configuración › Aplicaciones*.

> La primera vez Windows puede mostrar **"Windows protegió su PC"** porque el instalador no tiene firma digital (un certificado de firma cuesta dinero cada año). Elige **Más información › Ejecutar de todas formas**. Es normal en programas propios sin firmar.

**Sin instalar nada en tu PC (GitHub):** sube la carpeta a un repositorio de GitHub y en la pestaña **Actions › Instalador de Windows › Run workflow** se arma el `.exe` en los servidores de GitHub; queda para descargar en *Artifacts*. El flujo está en `.github/workflows/instalador-windows.yml` (también corre al subir una etiqueta `v1.0.0`).

Con comandos: `npm install` y luego `npm run dist` (instalador) o `npm run dist:dir` (carpeta con `Trazo.exe` sin instalar, para probar).

## Paso 1: instalar y arrancar (para programar)

Requisitos: **Windows 10/11 x64** y **Node.js 22 o superior** (https://nodejs.org).

```powershell
# 1. Crear la carpeta del proyecto (o descomprimir el zip) y entrar
cd trazo

# 2. Instalar dependencias (Electron 44, TypeScript, esbuild)
npm install

# 3. Compilar y abrir la app
npm start
```

Otros comandos:

| Comando | Qué hace |
|---|---|
| `npm start` | Compila y abre la ventana |
| `npm run dev` | Recompila al guardar (en otra terminal, `npx electron .` para abrir) |
| `npm test` | Pruebas del motor (matrices, clics, cajas, historial, tiradores) |
| `npm run typecheck` | Revisa los tipos de TypeScript sin compilar |
| `npm run build` | Solo compila a `dist/` |
| `npm run dist` | Instalador de Windows en `release/` (electron-builder) |
| `npm run dist:dir` | La app sin instalador, en `release/win-unpacked/` |

Si empiezas desde cero en vez de usar el zip, estos son los comandos que crean el mismo proyecto:

```powershell
mkdir trazo; cd trazo
npm init -y
npm install --save-dev electron@^44 typescript@^5.9 esbuild@^0.25 @types/node@^24
# luego copia package.json (scripts), tsconfig.json, scripts/build.mjs y src/ de este proyecto
```

## Estructura

```
trazo/
├── package.json            Scripts y dependencias ("main" apunta a dist/main/main.js)
├── tsconfig.json           TypeScript estricto para los tres procesos
├── scripts/build.mjs       Compila main, preload y renderer con esbuild (< 1 s)
├── scripts/test.mjs        Compila y ejecuta las pruebas (node --test)
├── tests/                  Pruebas del motor
├── assets/icon.png         Ícono de la ventana (provisional)
└── src/
    ├── main/main.ts        PROCESO PRINCIPAL: crea la ventana (maximizada, oscura,
    │                       barra de título integrada). Único con acceso al sistema.
    ├── main/fonts.ts       Fuentes de Windows y de Google Fonts (buscar, descargar,
    │                       guardar en caché e instalar en Windows)
    ├── main/files.ts       Abrir, guardar, importar, exportar, recientes y autoguardado
    ├── main/print.ts       Imprimir a tamaño exacto (diálogo de impresión de Windows)
    ├── preload/preload.ts  PUENTE SEGURO: expone window.trazo a la interfaz (IPC).
    ├── shared/api.ts       Contrato main ↔ interfaz: canales IPC, tipos y colores.
    ├── engine/             MOTOR DE DIBUJO (sin interfaz, sin Electron):
    │   ├── units.ts          mm / cm / pulgadas / px y ppp de exportación
    │   ├── document.ts       Documento, página, sangrado y tamaños de placa
    │   ├── viewport.ts       Zoom y desplazamiento (pantalla ↔ milímetros)
    │   ├── matrix.ts         Matrices afines: mover, escalar, rotar, reflejar
    │   ├── shapes.ts         Rectángulo, elipse y polígono; cajas y detección de clic
    │   ├── selection.ts      Tiradores de escala y rotación
    │   ├── history.ts        Deshacer / rehacer
    │   ├── text.ts           Texto: líneas, medidas, alineación, cursor
    │   ├── path-geom.ts      Curvas Bézier: trazado, cajas exactas, clic
    │   ├── path.ts           Nodos, manijas, convertir a curvas, mano alzada
    │   ├── font.ts           Lector de fuentes TrueType, OpenType (CFF) y colecciones TTC
    │   ├── boolean.ts        Soldar / recortar / intersectar y contorno (exactos, en micras)
    │   ├── fit.ts            Reajuste a pocas curvas suaves (Schneider)
    │   ├── shape-ops.ts      Operaciones sobre figuras de Trazo
    │   ├── merge.ts          Placas en serie: tablas, campos, fotos, nombres de archivo
    │   ├── arrange.ts        Grupos, PowerClip, alinear y distribuir
    │   ├── snap.ts           Imán: ajuste a guías, objetos y página
    │   ├── crop.ts           Recortar fotos (y quitar el recorte)
    │   ├── object-tree.ts    Árbol del administrador de objetos
    │   ├── color.ts          Conversión CMYK ↔ RGB ↔ hexadecimal
    │   ├── trace.ts          Vectorizar: imagen → curvas (colores, contornos, Bézier)
    │   ├── pdf-import.ts     Abrir PDF (de CorelDRAW) como diseño editable
    │   ├── file-format.ts    Formato .trz (guardar y abrir, con validación)
    │   ├── svg-export.ts     Exportar a SVG
    │   ├── draw.ts           Dibuja los objetos (lo comparten pantalla y exportación)
    │   ├── export.ts         Imagen para imprimir: ppp, sangrado, espejo, marcas de corte
    │   ├── raster-meta.ts    Escribe los ppp dentro de PNG y JPG
    │   ├── pdf.ts            PDF de una página, sin pérdida
    │   └── preflight.ts      Revisión antes de imprimir
    │   ├── canvas-renderer.ts Dibuja página, guías, objetos y selección (Canvas 2D, HiDPI)
    │   └── rulers.ts         Reglas con marcas que se adaptan al zoom
    └── renderer/           INTERFAZ (proceso de renderizado):
        ├── index.html        Página con política de seguridad (CSP) estricta
        ├── main.ts           Arma la distribución y los atajos de teclado
        ├── state.ts          Estado global con suscripciones (sin librerías)
        ├── editor.ts         Comandos de edición; todo cambio pasa por el historial
        ├── interaction.ts    Ratón sobre el lienzo: dibujar, seleccionar, transformar
        ├── text-edit.ts      Escribir sobre el lienzo (acentos, ñ, pegar, deshacer)
        ├── fonts.ts          Fuentes disponibles; consigue sola las que falten
        ├── session.ts        Nuevo, abrir, guardar, importar, pegar, soltar, autoguardado
        ├── images.ts         Fotos y logos: tamaño, decodificación y resolución (ppp)
        ├── exporter.ts       Genera PNG, JPG, PDF e impresión
        ├── path-tools.ts     Pluma, mano alzada y herramienta Forma
        ├── node-edit.ts      Comandos de nodos (barra, teclado y ratón)
        ├── text-curves.ts    Texto → curvas con la fuente real
        ├── shape-commands.ts Soldar, recortar, intersectar, contorno sobre la selección
        ├── merge.ts          Placas en serie: fotos, vista previa y generación
        ├── styles/app.css    Tema oscuro
        └── ui/               Barra de menús, estándar, propiedades, caja de
                              herramientas, paleta, área de trabajo y barra de estado
```

**Por qué tres procesos.** Electron separa el **proceso principal** (Node: archivos, ventanas, impresión) del **proceso de renderizado** (la interfaz, como una página web). La interfaz corre aislada (`contextIsolation`, `sandbox`, sin `nodeIntegration`) y solo puede pedir lo que el preload expone. Así un archivo malicioso abierto en el editor no puede tocar tu sistema.

**Cómo se guardan los objetos.** Cada objeto guarda su forma en coordenadas propias (en mm) y una **matriz** que la coloca en la página. Mover, escalar, rotar y reflejar es multiplicar matrices: se encadenan sin perder precisión y el grosor del contorno no se deforma al estirar. El documento es inmutable (cada cambio crea objetos nuevos y comparte el resto), por eso deshacer es barato: hasta 200 pasos.

**Por qué el motor va aparte.** `src/engine/` no sabe nada de la interfaz ni de Electron. Hoy dibuja con **Canvas 2D acelerado por GPU**, que es fluido para miles de objetos. Cuando lleguen las operaciones pesadas (soldar, recortar e intersectar formas, contornos, vectorizar imágenes), esas partes se escribirán en **Rust compilado a WebAssembly** dentro de `engine/` sin tocar la interfaz.

## Novedades 1.8.2

- **Nueva pantalla de inicio "La luz":** el camaleón persigue una luciérnaga bajo la lluvia (en primera persona), llega a un claro lleno de luciérnagas y en el charco todo toma color. La primera vez se ve completa y con sonido; después, solo el final. Se salta con clic, Esc, Enter o Espacio. *Ayuda › Ver la animación de inicio* la repite.
- **Instalador de un clic:** doble clic y se instala solo y abre la app (Windows); también AppImage (Linux) y dmg (Mac) con GitHub Actions.

## Novedades 1.8.1

- **Paquetes de plantillas (.inkpack):** *Archivo › Exportar paquete de plantillas* guarda todas tus plantillas (con categoría y miniatura) en un solo archivo para respaldar o pasarlas a otra computadora; *Archivo › Importar paquete de plantillas* (o arrastrar el .inkpack a la ventana) las agrega, reemplazando o saltando las que ya tienes.
- **Dividir en placas automático:** encuentra cada placa sola (figuras grandes que no se enciman), aunque haya placas de distinto tamaño en la misma página.
- **Guardar páginas como plantillas:** cada página al tamaño de su placa, sin repetir diseños iguales, y diplomas/agradecimientos separados solos en su categoría.
- **Convertir textos en campos en todas las páginas** de una vez.

## Novedades 1.8

- **De PDF de Corel a plantilla en minutos:** *Diseño › Dividir en placas* (cada placa en su página, a su tamaño; a las placas blancas se les pone un fondo para los acabados) y *Texto › Convertir textos en campos* (propone cuál es Nombre, Carrera y Generación).
- **Revisar nombres:** acentos comunes ("Ramirez" → "Ramírez"), mayúsculas ("ana lopez" → "Ana López") y espacios de más; se corrige uno por uno o todos de un clic.
- **📦 Material del pedido:** láminas por acabado y hojas o metros de papel, para copiar y mandar.
- **Acabados:** los grises oscuros (como "Universidad Central de Querétaro") también pasan a blanco en negro y bronce; los colores de los logos se respetan.
- **Mapas de bits › Quitar fondo:** logos con fondo blanco o liso, sin internet, con vista previa.
- **Biblioteca de elementos:** *Objeto › Guardar como elemento* (Logos, Escudos, Marcos, Adornos, Textos) y *Ventana › Biblioteca de elementos* para ponerlos con un clic.
- **Fuentes favoritas:** estrella ☆ en el selector de fuentes; las favoritas salen hasta arriba. Placas en serie avisa si a la plantilla le falta una fuente.

## Novedades 1.7

- **Nombres que caben solos:** en placas en serie, si un nombre no cabe, primero se parte en 2 líneas (por el espacio más parejo) y, si aun así no cabe, se achica hasta el 70 %. Mantiene el centro. La pantalla de revisar dice qué se acomodó.
- **Mostrar solo si…** (menú Objeto): un objeto sale solo en las placas cuya columna contiene un valor. Sirve para el **logo según la carrera**: dos logos encimados, cada uno con su condición ("Industrial", "Contaduría|Administración").
- **Acomodo en hoja:** salida "Acomodo en hoja" con papel carta, A4, tabloide o rollo (17″ a 64″), separación, marcas de corte y espejo. Calcula cuántas caben (también acostadas) y cuántas hojas salen.
- **Ayuda › Reportar un problema:** guarda una página .html con lo que pasó, captura de la ventana y registro de errores (y el diseño, si se marca).
- La pantalla de inicio se quita sola aunque algo falle al arrancar.

## Novedades 1.6 · Placas en serie de un jalón

- **Arrastra tu Excel (.xlsx) o CSV** a la app (o Archivo › Placas en serie…, Ctrl+M). Se lee directo, sin copiar y pegar.
- **4 pasos:** Lista → Plantilla (por categoría) → Revisar → Imprimir.
- **Plantillas por categoría:** Graduación, Diplomas, Panorámicas, Agradecimientos, Reconocimientos (o las tuyas). Se elige al guardar la plantilla y al guardar páginas de un PDF.
- **Acabados:** el mismo diseño en Blanco, Negro, Bronce… La columna *Acabado* de la lista dice cuál lleva cada placa ("Negra" o "negro" también sirven). Archivo › Acabados de la plantilla… para cambiar colores y la textura del fondo (bronce, dorado, plata o cobre cepillado, o la imagen real de tu lámina).
- **Revisar como "Estudio oscuro":** vista de hojas (2 en 2), cuadrícula o lista; filtros por acabado; buscador; panel con la placa en grande, la misma placa en cada acabado y sus datos para corregir; "Aprobar y siguiente".
- **Avisos:** acabado que no existe, dato vacío y **nombres que se salen de la placa**.
- **Salida "2 por hoja":** un PDF A4 horizontal con dos placas por hoja, en espejo.

## Lo que ya funciona

- Ventana **maximizada en modo oscuro nativo**, con los menús en la barra de título y los botones de Windows (minimizar, maximizar, cerrar) integrados a la derecha.
- **Distribución completa:**
  - Arriba: menús, barra estándar (archivo, deshacer, importar/exportar, imprimir, zoom, guías) y barra de propiedades.
  - A la izquierda: caja de herramientas.
  - Al centro: lienzo con reglas, pestañas de documento y navegador de páginas.
  - A la derecha: paleta de colores.
  - Abajo: barra de estado.
- **Lienzo:**
  - Placa de 20 × 25 cm por defecto, con sombra.
  - Guía de **sangrado** (roja, 3 mm por fuera) y de **margen seguro** (azul, 5 mm por dentro), que se encienden y apagan desde la barra estándar.
- **Navegación:**
  - Ctrl + rueda: zoom hacia el cursor (del 2 % al 25 600 %).
  - Rueda: desplazamiento vertical; Mayús + rueda: horizontal.
  - Para mover la vista: barra espaciadora + arrastrar, botón central o herramienta Mano.
  - Mayús + F4: ajustar a la página.
  - Herramienta Zoom: clic acerca, Mayús + clic aleja.
- **Reglas** en la unidad elegida, con marcas que se adaptan al zoom y una marca amarilla en la posición del cursor.
- **Barra de propiedades según la herramienta:**
  - Página: tamaños de placa (13 × 18, 15 × 20, 20 × 25, 20 × 30, 28 × 35 cm, Carta, Oficio, Tabloide, A4), ancho y alto, vertical u horizontal, unidades y sangrado.
  - Muestra cuántos píxeles tendrá la imagen al exportar a 300 ppp.
  - Rectángulo, elipse y polígono, y Texto (fuente, tamaño, negrita, alineación).
- **Paleta:**
  - Clic: relleno. Clic derecho: contorno.
  - Incluye dorado, oro viejo, plata y bronce para placas.
- **Atajos de herramientas:** F5 mano alzada, F6 rectángulo, F7 elipse, F8 texto, F10 forma, Z zoom, H mano, V selección, P pluma, Y polígono, I cuentagotas, G relleno.

### Paso 2: dibujar y transformar

- **Dibujar** con Rectángulo (F6), Elipse (F7) y Polígono (Y): arrastra. Ctrl: cuadrado o círculo. Mayús: desde el centro. Los objetos nuevos nacen sin relleno y con contorno negro de 0.2 mm (cámbialo con la paleta sin nada seleccionado).
- **Seleccionar** (V):
  - Clic en un objeto. Mayús + clic: añade o quita.
  - Arrastrar en vacío: marco (selecciona lo que quede completamente dentro).
  - Ctrl+A: todo. Esc: nada.
- **Transformar con los tiradores:**
  - Arrastrar un objeto lo mueve (Ctrl: solo en horizontal o vertical).
  - Las esquinas escalan en proporción y los lados estiran. Mayús: desde el centro. Pasar al otro lado lo refleja.
  - **Clic otra vez** sobre lo seleccionado: aparecen las flechas de rotación (Ctrl: de 15° en 15°). Otro clic vuelve a escalar.
  - Esc durante un arrastre lo cancela.
- **Barra de propiedades del objeto:**
  - Posición del centro (X, Y), ancho y alto con candado de proporción, y ángulo.
  - Reflejar horizontal y vertical.
  - Radio de esquinas (rectángulo), número de lados (polígono) y grosor del contorno (0 = sin contorno).
  - Orden y eliminar.
- **Paleta:** con objetos seleccionados, clic cambia su relleno y clic derecho su contorno.
- **Teclado:**
  - Flechas: mueven 1 mm (Mayús: 10 mm; Ctrl: 0.1 mm).
  - Supr: eliminar.
  - Ctrl+D: duplicar. Ctrl+C / Ctrl+X / Ctrl+V: copiar, cortar, pegar.
  - Mayús+RePág / AvPág: al frente / al fondo. Ctrl+RePág / AvPág: uno adelante / atrás.
  - **Ctrl+Z deshacer, Ctrl+Y (o Ctrl+Mayús+Z) rehacer**, también con los botones de la barra estándar (el tooltip dice qué se deshace).

### Paso 3: texto y fuentes

- **Escribir:** herramienta Texto (F8), clic en la página y escribe.
  - Enter hace una nueva línea. Esc, Ctrl+Enter o un clic fuera terminan.
  - Funcionan los acentos y la ñ del teclado en español, pegar (Ctrl+V), seleccionar con Mayús + flechas y Ctrl+Z dentro del texto.
  - Un texto que se deja vacío se descarta.
- **Editar:** clic en un texto con la herramienta Texto, o doble clic con Selección. El cursor queda donde hiciste clic.
- **Barra de propiedades del texto:** fuente, tamaño en puntos, negrita, cursiva y alineación (izquierda, centro, derecha).
  - Con un texto seleccionado, los cambios se aplican a él.
  - Sin selección, cambian la letra de los textos nuevos.
  - El texto se mueve, escala, rota, refleja y colorea igual que las figuras. El dorado de la paleta funciona también en letras.
- **Selector de fuentes con buscador:**
  - Arriba, las fuentes de tu equipo, cada una escrita con su propia letra.
  - Abajo, las de **Google Fonts** que no tienes (más de 1 500 familias, libres también para trabajos que se venden).
- **Si una fuente falta, Trazo la busca y la pone sola:**
  - Al elegirla en el buscador o al escribir su nombre, se busca en Google Fonts, se descarga (normal, cursiva, negrita y negrita cursiva) y se aplica.
  - Lo mismo pasa con un texto que trae una fuente que no tienes (por ejemplo, un diseño hecho en otra PC).
  - Lo descargado queda guardado y se carga solo al abrir Trazo, también sin internet.
  - Con **«Instalar en Windows»** (al pie del selector) la fuente queda instalada para tu usuario, sin permisos de administrador, y aparece también en Word, Corel y demás (hay que reiniciarlos).
  - Si no existe en ningún lado, la barra de estado lo avisa y no se cambia nada.

### Paso 4: archivos e imágenes

- **Guardar y abrir diseños `.trz`:**
  - Ctrl+S guarda; Ctrl+Mayús+S, «Guardar como»; Ctrl+O abre; Ctrl+N, documento nuevo.
  - Las fotos y logos van **dentro** del archivo: lo puedes mandar por WhatsApp o USB y abre igual en otra PC. Las fuentes que falten allá se descargan solas (paso 3).
  - **Archivo › Recientes** muestra los 10 últimos diseños.
  - El título de la ventana y la pestaña muestran **•** cuando hay cambios sin guardar.
- **No perder trabajo:**
  - Al cerrar, crear o abrir con cambios sin guardar, Trazo pregunta: Guardar, No guardar o Cancelar.
  - Cada minuto guarda una **copia automática** aparte (no pisa tu archivo). Si se va la luz o Trazo se cierra de golpe, al abrirlo ofrece recuperarla.
  - Guardar es seguro: escribe un archivo temporal y lo cambia al final; si algo falla a medias, el anterior queda intacto.
  - Un archivo dañado no rompe Trazo: abre lo que se puede leer y avisa de lo que se omitió.
- **Importar fotos y logos** (PNG, JPG, WebP, GIF y SVG):
  - Ctrl+I o el botón de la barra estándar (puedes elegir varias a la vez).
  - **Arrastra** archivos del Explorador al lienzo: quedan donde los sueltas. Un `.trz` arrastrado se abre.
  - **Pega con Ctrl+V** una imagen copiada (de una captura de pantalla, del navegador o de WhatsApp Web).
  - Las fotos entran a su tamaño real a 300 ppp, o más chicas si no caben en la placa. Las fotos de celular salen bien orientadas.
  - Los SVG se ven nítidos a cualquier zoom.
- **Resolución de la foto** en la barra de propiedades: dice a cuántos ppp se imprimirá con el tamaño que le diste.
  - En verde, **buena** (250 ppp o más).
  - En amarillo, **aceptable** (150 a 249).
  - En rojo, **baja: se verá borrosa** (menos de 150). Hazla más chica o consigue una foto más grande.
- **Exportar SVG** (Ctrl+E): vectorial, a la medida de la placa con sangrado. Se abre en Corel, Illustrator, Inkscape o el navegador.
- **Menús** Archivo, Editar y Objeto con sus atajos. Los demás menús se llenan en los siguientes pasos.

### Paso 5: exportar e imprimir para sublimar

Ctrl+E (exportar) o Ctrl+P (imprimir) abren la misma ventana.

- **Vista previa exacta** de lo que sale: con espejo, sangrado y marcas. Usa el mismo dibujo que la pantalla.
- **Formatos:**
  - **PNG**: sin pérdida, el recomendado para sublimar. Admite fondo transparente.
  - **JPG**: más ligero.
  - **PDF**: para la imprenta o el RIP de la impresora; una página sin pérdida a la medida exacta.
  - **SVG**: vectorial, para seguir editando en otro programa.
- **Resolución:** 150, 200, **300 (recomendado)**, 600 o 720 ppp.
  - Los ppp quedan **escritos dentro** del PNG y del JPG. Así Photoshop, Word o el programa de la impresora los abren a la medida real (sin eso suponen 72 o 96 ppp y la placa sale de otro tamaño).
- **Espejo** para papel de transferencia: activado por defecto. Al planchar, queda al derecho.
- **Sangrado** incluido (3 mm por lado) y **marcas de corte** opcionales en las esquinas.
- **Revisión antes de imprimir:**
  - Fotos que saldrán borrosas (menos de 150 ppp) o justas (menos de 250).
  - Textos fuera del margen seguro.
  - Fondos que tocan el borde pero no cubren el sangrado (filo blanco al cortar).
  - Objetos fuera de la página.
  - Clic en un aviso: se cierra la ventana y queda seleccionado ese objeto para corregirlo.
- **Imprimir directo:** abre el diálogo de impresión de Windows con el papel a la medida exacta, sin márgenes. Elige tu impresora de sublimación y deja la **escala en 100 %** (no "Ajustar").
- Las opciones se recuerdan para la próxima vez, y la carpeta de exportación también.

### Paso 6: curvas

- **Pluma (P):**
  - Clic: nodo de esquina. Clic y arrastrar: nodo suave, con manijas.
  - Clic en el primer nodo: cierra la curva. Enter, Esc o doble clic: termina.
  - Retroceso borra el último nodo. Ctrl: ángulos de 15° en 15°.
  - Mientras dibujas, un tramo punteado muestra cómo quedará el siguiente.
- **Mano alzada (F5):** dibuja arrastrando. El trazo se suaviza solo con pocos nodos, y las esquinas marcadas se respetan. Si terminas cerca de donde empezaste, la curva se cierra.
- **Forma (F10):** edita los nodos de una curva.
  - Clic en un nodo para elegirlo (Mayús: varios) o arrastra un marco.
  - Arrastra nodos y manijas.
  - Doble clic en la línea: **añade** un nodo. Doble clic en un nodo: lo **borra**.
  - Flechas: mueven los nodos elegidos. Supr: los borra. Ctrl+A: todos los nodos. Esc: ninguno.
  - Barra de nodos:
    - Añadir y eliminar nodos.
    - Tramo recto o curvo.
    - Tipo de nodo: **cúspide** (esquina), **suave** (manijas alineadas) o **simétrico** (además, del mismo largo).
    - Cerrar la curva o separarla en un nodo.
    - Grosor del contorno.
  - En pantalla, los nodos de esquina son cuadros y los suaves, círculos.
- **Convertir a curvas (Ctrl+Q):** rectángulos (también redondeados), elipses y polígonos pasan a curvas con sus mismos nodos, para deformarlos. Está también en el menú Objeto y en la barra.
- Las curvas cerradas se rellenan con la regla **par-impar**: los huecos (como el de una O o un marco) quedan vacíos. Las abiertas no se rellenan.
- Se guardan en el `.trz`, se exportan a SVG como `<path>` y se imprimen igual que se ven.

### Paso 7: dar forma y texto a curvas

- **Texto a curvas (Ctrl+Q):** las letras salen del archivo real de la fuente (de Windows o descargada de Google), en el mismo lugar y tamaño exactos. Funciona con TrueType, OpenType y colecciones. Si la fuente no tiene negrita o cursiva, se simula como en pantalla.
- **Soldar:** une varias figuras (o textos) en una sola silueta.
- **Recortar:** al objeto de más atrás se le quita la forma de los de delante (por ejemplo, calar un texto en una placa).
- **Intersectar:** crea una figura con lo que tienen en común.
- **Contorno (Ctrl+F9):** borde alrededor (o dentro) de un texto o logo, con esquinas redondas, distancia en mm y color. Ideal para un borde blanco o dorado detrás del nombre sobre la foto.
- Están en el menú **Objeto** y en la barra de propiedades al seleccionar varios objetos.
- El motor se escribió en TypeScript (no hizo falta Rust): un contorno sobre texto tarda unos 0.2 s y soldar 300 figuras, medio segundo.

### Paso 8: placas en serie

Un diseño, una placa por cada graduado (**Archivo › Placas en serie…**, Ctrl+M).

1. **Datos:** copia la tabla en Excel o Google Sheets (con títulos en la primera fila: Nombre, Generación, Foto…) y pégala, o abre un CSV. Se guardan dentro del `.trz`.
2. **Campos:**
   - Escribe `{{Nombre}}` dentro de cualquier texto, o haz clic en la columna para agregarlo.
   - **Ancho máx.** (barra de propiedades del texto): si un nombre es más largo, la letra se achica sola para caber.
   - **Foto de** (barra de propiedades de una imagen de ejemplo): cada placa toma la foto de esa columna (el nombre del archivo, con o sin extensión). Elige la carpeta de fotos: la foto llena el marco sin deformarse (en fotos verticales recorta más abajo, porque la cara suele estar arriba).
3. **Vista previa** en el lienzo, placa por placa (◀ ▶). Un clic en el lienzo vuelve al diseño.
4. **Generar:**
   - Un PNG, JPG o PDF por placa en la carpeta que elijas, o **un solo PDF** con una placa por página.
   - Con espejo, sangrado y la resolución elegida.
   - Nombre de cada archivo con campos (`{{Nombre}}`, `{{#}}` = número). Nunca pisa un archivo existente.
   - Avisa qué fotos no encontró (esas placas usan la foto de ejemplo).

### Paso 9: organizar, PowerClip, degradados y transparencia

- **Agrupar** (Ctrl+G) y **desagrupar** (Ctrl+U): un clic en cualquier parte elige todo el grupo; Ctrl+clic elige solo una pieza.
- **PowerClip:** selecciona la foto y la figura que hace de marco (la figura encima) y pulsa el botón PowerClip. La foto queda recortada a la forma: un círculo, un óvalo, una estrella, un texto convertido a curvas… Se mueve, gira y escala todo junto. Ctrl+clic elige la foto de dentro para acomodarla. **Objeto › Sacar contenido del PowerClip** la vuelve a dejar suelta.
- **Alinear y distribuir** (botón en la barra de propiedades, menú Objeto o teclas con la herramienta Selección):
  - `L` izquierda, `R` derecha, `T` arriba, `B` abajo, `E` centro horizontal, `C` centro vertical, `P` centro de la página.
  - Con un solo objeto se alinea con la página; con varios, entre ellos.
  - `Mayús+H` / `Mayús+V`: mismo espacio entre tres o más objetos.
- **Relleno y transparencia** (botón junto a Alinear):
  - Sólido, degradado **lineal** (con ángulo) o **radial**, de un color a otro. Ideal para letras doradas.
  - **Transparencia** de 0 a 100 %.
  - **Desvanecer:** el objeto pasa de opaco a transparente (abajo, arriba, izquierda o derecha), por ejemplo una foto que se funde con el fondo.
  - Todo se ve igual en pantalla, en PNG/JPG/PDF y en el SVG (con degradados, máscaras y recortes estándar de SVG).
- **Cuentagotas** (`I`): clic en cualquier punto del lienzo y ese color pasa al relleno de lo seleccionado (Mayús+clic: al contorno). Sin selección, queda como color para los objetos nuevos.
- Soldar, recortar e intersectar respetan el PowerClip (la foto de dentro pasa a la figura nueva) y la revisión previa ya no avisa de la parte de la foto que queda oculta fuera del marco.

### Paso 10: guías, imán, recortar fotos y administrador de objetos

- **Guías:** arrastra desde la regla de arriba (guía horizontal) o la de la izquierda (vertical). Se mueven arrastrándolas con la herramienta Selección; soltarlas sobre la regla las quita. No se imprimen, se guardan en el `.trz` y se deshacen con Ctrl+Z. **Ver › Borrar todas las guías.**
- **Imán** (botón en la barra estándar o Alt+Q): al mover, dibujar, escalar o recortar, los bordes y centros se pegan a:
  - guías,
  - bordes y centro de la página y la línea de sangrado,
  - bordes y centros de los demás objetos.
  Mientras algo está pegado se ve una línea rosa. En **Ver** eliges a qué se pega.
- **Recortar fotos** (herramienta Recortar, tecla `K`, o el botón de recortar en la barra de una imagen): arrastra el área que quieres conservar, ajústala con los tiradores o muévela, y pulsa Enter (o doble clic, o *Aplicar recorte*). Esc cancela. La foto no pierde calidad ni se borra nada: **Quitar recorte** devuelve la foto completa.
- **Administrador de objetos** (Ventana, Ctrl+F7 o el botón de capas): todos los objetos de adelante hacia atrás, con los grupos y los PowerClip que se abren con la flechita.
  - Ojo: ocultar (no se ve ni se imprime).
  - Candado: bloquear (no se puede elegir ni mover desde el lienzo; ideal para el fondo).
  - Doble clic en el nombre para cambiarlo.
  - Arrastra una fila para cambiar el orden.
- La resolución de una foto recortada se calcula bien (antes no tomaba en cuenta el recorte de las fotos de placas en serie).

### Paso 11: texto en arco, texto de párrafo, varias páginas y color CMYK

- **Texto en arco** (botón de arco y párrafo en la barra del texto): una barrita o los grados exactos. Positivo = arco hacia arriba (∩, el nombre de la escuela arriba del escudo); negativo = hacia abajo (∪). Al hacer doble clic para escribir se ve derecho, con el cursor; al terminar vuelve al arco. Se exporta igual a PNG, JPG, PDF y SVG, y se puede convertir a curvas.
- **Texto de párrafo:** con la herramienta Texto, **arrastra** un marco (un clic sigue siendo texto artístico). Las líneas se cortan solas entre palabras. El ancho se cambia en la misma ventanita; vacío lo vuelve texto artístico.
- **Varias páginas** (abajo del lienzo y menú **Diseño**): insertar, duplicar, eliminar, mover y cambiar nombre (doble clic en la pestaña; clic derecho para más opciones). RePág / AvPág cambian de página. Deshacer regresa a la página donde se hizo el cambio. **Diseño › Mover la selección a la página siguiente/anterior.**
  - Exportar **PDF** puede llevar **todas las páginas** (una placa por página, sin pérdida). PNG, JPG, SVG e imprimir usan la página que se ve.
  - Placas en serie trabaja con la página que se ve.
- **Selector de color CMYK** (doble clic en el color de relleno o contorno de la barra de estado, el botón **+** al final de la paleta, o **Objeto › Color de relleno…**): CMYK, RGB y hexadecimal sincronizados, con antes y después. **Agregar a la paleta** guarda el color (con nombre) al final de la paleta; Mayús+clic en él lo quita.

### Paso 12: sombras, vectorizar logos e instalador

- **Sombra paralela** (botón de sombra en la barra de propiedades, o **Efectos › Sombra paralela**): dirección, distancia, difuminado, color y opacidad. También "alrededor" (resplandor). Sale igual en pantalla, PNG/JPG/PDF y SVG.
- **Vectorizar imagen** (botón en la barra de una imagen, o **Mapas de bits › Vectorizar…**): un logo o escudo en PNG/JPG pasa a curvas, nítido a cualquier tamaño.
  - *Blanco y negro* (con umbral) o *Colores* (2 a 8; el programa encuentra los colores principales).
  - Suavizado, quitar manchas e ignorar el fondo blanco; vista previa en vivo junto al original.
  - Las capas de color quedan apiladas (sin rendijas entre colores) y agrupadas encima; la imagen original queda oculta (se ve en el administrador de objetos).
  - Funciona mejor con logos de colores planos; las fotos se ven mejor como imagen.
- **Instalador para Windows** (ver arriba): `.exe` con accesos directos, asociación de archivos `.trz` e ícono.

### 1.1: plantillas y placas para revisar una por una

- **Biblioteca de plantillas:** *Archivo › Guardar como plantilla…* guarda el diseño (con sus campos, fotos de ejemplo y miniatura). *Archivo › Nuevo desde plantilla…* muestra todas con su vista previa; clic para empezar un diseño nuevo con ella (la plantilla no se modifica). Se guardan en la carpeta de datos de Trazo.
- **Una página por placa:** en *Placas en serie* (Ctrl+M), con la tabla de Excel pegada, el botón **Una página por placa** crea una página por alumno con su nombre y su foto.
- **Ver todas las páginas** (botón *Ver todas* abajo, o *Diseño › Ver todas las páginas*): miniaturas de todas las placas con avisos (⚠ foto borrosa, nombre fuera del margen…), buscador por nombre y filtro "solo las que tienen avisos". Clic en una para corregirla: los cambios solo afectan a esa placa.
- **Exportar:** PDF con todas las páginas o **una imagen PNG/JPG por página** en una carpeta, con el nombre de cada alumno. La página "Plantilla" (la que aún tiene `{{Nombre}}`) se omite sola.

### 1.2: abrir tus diseños de CorelDRAW (vía PDF)

Los `.cdr` de CorelDRAW 2024 no se pueden leer directo de forma fiel (Corel no publica su formato; el lector libre que usan Inkscape y LibreOffice pierde los rellenos de color de esa versión). El PDF que exporta Corel sí trae todo, y Trazo lo abre **editable**:

1. En CorelDRAW: **Archivo › Publicar en PDF…** › **Configuración…**
   - General: *Documento actual* (todas las páginas).
   - Objetos: ✅ *Incrustar fuentes*; ❌ *Exportar todo el texto como curvas* (desmarcado: así los nombres siguen siendo texto).
2. En Trazo: **arrastra el PDF** a la ventana, o **Archivo › Abrir PDF de CorelDRAW…**

Se abre con todas sus páginas: curvas y logos con sus colores (agrupados), fondos, imágenes y **textos editables** con su fuente, tamaño, color, contorno, interlineado y alineación (los nombres centrados siguen centrados al cambiarlos). Guárdalo como `.trz` o como plantilla (*Archivo › Guardar como plantilla…*) y cambia los nombres hoja por hoja.

- Las fuentes tienen que estar instaladas en Windows (las de tus diseños vienen con Windows y Office). Si falta alguna, Trazo avisa cuál.
- Si arrastras un `.cdr`, Trazo te recuerda cómo exportarlo a PDF.
- Probado con un archivo real de 32 páginas: se abre en unos 8 s y queda igual al PDF.
- Los `.trz` guardan las curvas en forma compacta (formato de archivo versión 2; los de versiones anteriores se siguen abriendo).

### 1.3: muchas plantillas desde tus PDF

- Al arrastrar un PDF de **varias páginas** (o **varios PDF a la vez**) se abre una ventana con las miniaturas de todas las páginas. Marca las que quieras (clic en la miniatura; botones *Todas* / *Ninguna*) y:
  - **Guardar como plantillas:** cada página marcada queda como **su propia plantilla**, con el nombre que escribas abajo de su miniatura.
  - **Abrir las seleccionadas:** solo esas páginas, como un diseño editable.
- Un PDF de una sola página se abre directo.
- *Archivo › Guardar como plantilla…* con varias páginas: **Solo esta página** (marcado) o todas juntas.
- Con un PDF de Corel de 32 placas: en un par de minutos tienes una plantilla por estilo ("Diploma negro Ingeniería", "Madera Administración"…), lista en *Archivo › Nuevo desde plantilla…*

### 1.4: tema claro

- **Ver › Tema claro (blanco)** o el botón de sol/luna en la barra de arriba: toda la interfaz (paneles, menús, reglas, lienzo y los botones de la ventana) pasa a blanco; otra vez para volver a oscuro. Se recuerda para la próxima vez.

## Ideas para después

- Texto que sigue cualquier trazo (no solo un círculo).
- Abrir archivos `.cdr` directamente (hoy: exportar a PDF desde Corel, ver 1.2).
- Perfiles de color ICC para pruebas de color exactas.
