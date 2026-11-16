# AGENTS.md — Reglas globales de Fullstack DevTools

> Lectura obligatoria antes de tocar código. Si el código contradice este documento, gana el
> código: actualiza este archivo en el mismo cambio.

Documentación de apoyo: `README.md` (producto, seguridad y limitaciones conocidas),
`docs/decisions.md` (ADR con el porqué de cada decisión) y
`BACKEND_DEVTOOLS_DESKTOP_SPEC.md` (especificación original). La spec es anterior a buena parte
de la implementación y diverge en piezas importantes: el mapa es SVG propio a mano, no usa React
Flow ni dagre, no hay receptor OTLP ni terminal `node-pty`/`xterm` ni almacén SQLite de sesión. No
reintroduzcas esas dependencias solo porque la spec las mencione.

## 1. Mapa del repositorio

- Monorepo con npm workspaces. Node >= 22.22.0, ESM, TypeScript 5.9.3 `strict` con
  `noUncheckedIndexedAccess`. Dependencias con versión exacta.
- `apps/desktop/main/` — proceso principal: ventanas, IPC, sistema de archivos, procesos, CDP,
  captura y saneado.
- `apps/desktop/preload/` — cuatro puentes: `preload.cjs` (IDE), `browser-chrome.cjs`,
  `inspection-panel.cjs` y `unified.cjs` (mapa). Se compilan con esbuild a `dist/preload`.
- `apps/desktop/renderer/` — UI IDE en React 19 + Vite (`dist/renderer`).
- `packages/core/protocol/` — tipos, constantes de canales y esquemas Zod compartidos.
- `packages/browser/network-capture/` — normalización, clasificación y saneado del tráfico.
- `packages/analysis/routes/` — índice estático de rutas (JS/TS y Python).
- `packages/analysis/sql-analyzer/` — análisis estático de SQL.
- `apps/desktop/e2e/` — Playwright en modo Electron.
- `npm run build:main` (esbuild) + `npm run build:renderer` (Vite) = `npm run build`. La app
  empaquetada no lleva `node_modules`; los paquetes `@bdt/*` se consumen como fuente TypeScript y
  se integran en el bundle.

## 2. Fronteras de proceso y ventanas

| Superficie            | Contenido                                                                            | Preload                                      | Partición                    |
| --------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------- |
| IDE principal         | `BrowserWindow` con React; editor Monaco editable con Ctrl+S                         | `preload.cjs`                                | por defecto                  |
| Ventana del navegador | `WebContentsView` de la app inspeccionada + barra de dirección + panel de inspección | `browser-chrome.cjs`, `inspection-panel.cjs` | `bdt-inspector`, `bdt-panel` |
| Ventana del mapa      | `BrowserWindow` con `UNIFIED_HTML` (data URL); mapa y datos unificados               | `unified.cjs`                                | `bdt-inspect`                |

- La app inspeccionada no tiene preload, IPC, Node ni acceso al sistema de archivos. Corre con
  `sandbox`, `contextIsolation` y `nodeIntegration: false`; CDP se adjunta solo desde el main. El
  inspector por clic vive en un mundo aislado (`bdt-inspector-world`) y se recrea en cada
  navegación.
- El panel de inspección va fijo a la derecha de la ventana del navegador. El mapa es una ventana
  aparte para poder redimensionarla sin romper el layout del navegador.
- El tooltip de procedencia de la página vive en `click-inspector.ts` (mundo aislado) y es
  `pointer-events: none` mientras sigue al puntero: nunca debe interceptar el ratón ni el hover del
  elemento de debajo. Ctrl lo fija (`tipFrozen`), y solo entonces acepta puntero, scroll y clics;
  la esquina superior derecha muestra `bloquear` y el pie cambia a la ayuda de bloqueo. Fijo, cada
  `archivo:línea` del código es clicable y emite `reveal` para abrir el editor en ese rango
  (ADR-071). El estado de Ctrl se lee en el mundo de la página y en el del mapa, no en el main.
- IPC: canales con nombre fijo agrupados por prefijo (`workspace:*`, `file:*`, `browser:*`,
  `browser-panel:*`, `browser-chrome:*`) definidos en `@bdt/protocol`. Todo payload se valida con
  Zod `strictObject` en el main, y cada handler comprueba `sender` y `senderFrame` (main frame).
  Los resultados son `IpcResult<T>` (`ok` o `error.code` con prefijo `BDT_E_`).
- Los preloads exponen una API congelada y concreta. Nunca expongas `ipcRenderer` en bruto ni
  añadas canales fuera del protocolo.
- Límites de payload ya establecidos (no los amplíes sin necesidad): dirección 2048, selector
  2048, rutas 4096, línea <= 10 000 000, URL 2048, cwd 1024, highlight <= 512 objetivos.

## 3. Seguridad y datos (no negociable)

- Acceso a archivos solo dentro de las raíces abiertas, validando con `realpath`, rechazando la
  raíz del sistema, `..`, NUL y enlaces que escapen. Toda lectura/escritura pasa por
  `main/src/fs/root-guard.ts`.
- La escritura es explícita y por una sola ruta: `file:save` → `fs/atomic-write.ts`
  (`saveTextFile`), con root-guard, archivo existente obligatorio —no se crean archivos nuevos—,
  conflicto por `mtimeMs` (`BDT_E_FILE_CONFLICT`) y temporal + `rename` conservando el modo.
  `launch-settings` usa el mismo helper. El mapa y el panel acoplado guardan por ese canal con
  `isInspectorUiSender`; la página inspeccionada no lo alcanza (ADR-076).
- Red solo en `127.0.0.1`; orígenes de frontend y backend distintos y sin credenciales en la URL.
  El inspector de Node exige loopback y puerto coincidente.
- Navegación con lista blanca: `bdt-app://app`, el origen de desarrollo exacto y los orígenes
  configurados. `window.open`, `<webview>`, descargas y permisos denegados por defecto. CSP
  estricta en la UI y en las superficies data URL.
- Enmascarado en el proceso principal antes de mostrar o guardar: cabeceras y query sensibles
  (`authorization`, `cookie`, `set-cookie`, `x-api-key`, y nombres con `password`, `token`,
  `secret`, `jwt`, `session`). Los cuerpos JSON se muestran completos, claves sensibles incluidas,
  limitados a 16 000 caracteres y solo en memoria.
- Excepción explícita y deliberada: la rejilla SQL del mapa y los cuerpos JSON muestran los valores
  reales sin enmascarar para auditar el dato (hashes, contraseñas, nulos, formatos). Siguen solo en
  memoria y nunca se escriben en disco ni se exportan. No extiendas esa excepción a cabeceras,
  query, secretos de la auditoría de seguridad ni a exportaciones.
- Capturas y trazas viven en memoria. Sin telemetría. No añadas escrituras automáticas al
  proyecto inspeccionado ni escaneos que no haya pedido el usuario.
- Con la inspección desactivada, la app debe quedar inerte: nada de escaneos automáticos de página
  ni de dominios CDP `Debugger`/`CSS` fuera del toggle, y tampoco conexión al inspector de Node del
  backend ni drenajes de SQL/JSON cada 400 ms. La captura N2 del backend se liga al interruptor de
  inspección (`setInspection`), no al cierre del mapa (ADR-068).

## 4. Modelo de datos y evidencia

- El grafo es la fuente de verdad; la UI solo lo lee. No inventes relaciones en la interfaz que no
  existan en el snapshot.
- `FlowNodeType`: file, structure, asset, element, handler, request, route, function, query,
  table, database. `FlowEdgeType`: TRIGGERS, SENDS, MATCHES, HANDLES, QUERIES, READS, WRITES,
  USES, SUBMITS, NAVIGATES, PROVENANCE, RENDERS, CONTAINS.
- Evidencia real implementada: `STATIC` y `RUNTIME`. Correlación: `direct` o `heuristic`. No
  presentes algo STATIC como ejecutado y no llames "muerto" a lo no observado. Una correlación solo
  es `direct` si la ubicación del iniciador coincide exactamente con la del manejador o del sitio
  (`archivo:línea`, y columna donde aplique) y la nota cita esa ubicación; el nombre suelto o la
  ventana temporal son `heuristic` (ADR-069). No fuerces normalizaciones de URL que inventen
  coincidencias: lo que no casa por source maps o transpilación queda heurístico.
- Los IDs son opacos y estables. Un `requestId` se conserva desde CDP; los sitios SQL usan
  `archivo:línea:columna:hash`; la identidad JSON combina `requestId|origin|jsonPath`. No generes
  IDs nuevos si ya existe un identificador compartido.
- Cada modo de inspección enseña **solo su categoría**, en el tooltip de la página y en el panel
  acoplado: HTML/CSS → elemento, atributos y estilos calculados; Frontend → manejador y su código;
  Backend → ruta y su código; JSON → peticiones y cuerpos; SQL → consultas asociadas al elemento
  con sus filas reales. No mezcles categorías ni repitas el contenido de otro modo; si un modo no
  tiene dato, lo dice («sin SQL asociado a este elemento…») en lugar de rellenar con lo demás
  (ADR-070). El modo vive solo en el main y llega a las dos superficies por `InspectionPanelState`.
- `FlowSnapshot.revision` cambia en cada reconstrucción y gobierna el re-render del mapa. El mapa
  recibe tres flujos por `browser-panel:*`: `mapData` (`FlowMapState`), `jsonData` (`FlowJsonState`)
  y `requestData` (`FlowRequestState`, el detalle completo de cada petición capturada). Los cuerpos
  —JSON y de petición— se envían una sola vez (`bodyOmitted` / `requestBodyOmitted` +
  `responseBodyOmitted` y caché en el preload); no los reenvíes en cada refresco.

## 5. Captura (N0 y N2)

- Red: CDP `Network.*` → `RequestBuffer`. Clasificación por origen normalizado (backend primero,
  frontend después, resto externo). Iniciadores con líneas y columnas convertidas a base 1.
- JSON del backend: hooks inyectados (`JSON.parse`, `JSON.stringify`, `fetch`, `http`/`https`)
  con drenaje cada 400 ms, búfer de 2000 entradas, cuerpos saneados y recortados a 16 000
  caracteres; un cuerpo truncado se oculta, no se muestra crudo. Cada movimiento conserva tipo,
  dirección, método, ruta, estado, hora, repeticiones y pila.
- SQL: hooks de `pg`, `mysql2`, `sqlite3` y `better-sqlite3` con drenaje cada 400 ms; se capturan
  sentencias (no parámetros) y muestras acotadas. Lo estático y lo observado se etiquetan por
  separado.
- Node Inspector opcional: conexión 4 s, comandos 5 s, máximo 200 breakpoints. Si no está
  conectado, la UI lo dice; nunca simula evidencia de ejecución. Solo se conecta con la inspección
  activada: `disconnect()` cierra el socket y detiene los drenajes sin marcar `disposed` ni vaciar
  `routes`; al reactivar, la conexión es nueva y no recupera el historial previo (ADR-068).

## 6. Estructura del mapa de flujo

- `flow-layout.ts` es puro y determinista. Modos: `chronological`, `structural`, `hierarchical`.
  Orden de columnas: file, structure, asset, element, handler, request | route, function, query,
  table, database. El hueco frontend→backend lo fija `boundaryGap`: `exchangeGapWidth()` (1444 px)
  cuando hay zona de intercambio y `LAYER_GAP` (176 px) cuando no la hay; el resto de huecos
  176 px; margen 48 px. Compacto y normal usan la misma caja de nodo de 48 px con tres líneas; el
  compacto solo empaqueta más denso (ADR-073, ADR-074).
- Anchos de columna medidos por contenido. Se ajustan arrastrando los separadores de la cabecera
  del eje; doble clic restablece; rango 44-720 px. No añadas botones globales de ancho. La fila de
  intercambio aporta tres etiquetas al eje —`PETICIONES`, `⇄ JSON` y `RUTAS`— alineadas con sus
  tres columnas y sin separador: su ancho lo fija la geometría del hueco, no el contenido.
- Composición SVG de `#map-svg`: `defs` (marcadores) + un `<g>` viewport con capas en orden
  branches → trunks → enlaces del middleware → nodes → routes. Respetar ese orden: los enlaces
  deben quedar bajo los nodos.
- Recorte por visor: rejilla espacial de 512 px, margen 280 px, montaje/desmontaje con `rAF`.
  Aristas agrupadas por corredores (tronco + ramas) cuando hay >= 2 pares origen→destino.
- Superposiciones HTML fuera del SVG que siguen el pan/zoom (tarjetas de nodo, rejilla de
  intercambio, eje, tooltip, menú, estado): deben aplicar exactamente el mismo
  `translate(x, y) scale(k)` que el viewport (`syncOverlayTransforms`).
  No uses `will-change: transform` en capas con texto escalado (el raster viejo se ve borroso);
  si el texto queda borroso tras el zoom, fuerza un repintado a la escala actual.
- En no compacta, `#map-cards` / `#map-cards-world` pintan el contenido de cada nodo visible como
  tarjeta HTML (`variant: 'node'` de `infoCard`, proveedor `canvas:<id>`); el SVG conserva
  geometría, fondo, contorno de selección e interacción. Plegada = tres líneas con altura fija por
  CSS; desplegada = `cardForNode` completo con altura medida (`expandedHeights`) y una sola pasada
  de corrección, porque el ancho no cambia al desplegar. Las tablas no montan tarjeta: su
  despliegue es la rejilla SQL del SVG. En compacta no hay capa de tarjetas y el detalle sigue en
  el tooltip y el panel (ADR-073).
- LOD de texto: `TEXT_MIN_ZOOM = 0.4`. Por debajo, `.is-zoom-out` oculta el texto SVG, deja
  transparente el texto de la fila de intercambio (`.mw-grid *`) y oculta la capa de tarjetas
  (`#map-cards.is-zoom-out { visibility: hidden }`, no `display`, para no romper la medición),
  manteniendo los bloques. Cualquier texto nuevo dentro del mapa debe seguir esta regla.
- La fila de intercambio solo existe en modos de columnas. Es `.mw-grid`, una rejilla de tres
  columnas dentro del hueco (`left = gapStart + 40`, `top = FLOW_MARGIN`, ancho = suma de columnas
  más huecos) con `justify-content: start`, `column-gap: 32px` y `align-items: start`: petición
  frontend a la izquierda, JSON en el centro, petición backend a la derecha. La columna central
  conserva el ancho 320-500 px y la posición centrada que tenía la banda; las laterales son de
  400 px (mínimo 280) y solo aparecen si el hueco deja sitio —si no, la fila se degrada a la columna
  JSON sola—. El margen entre cada grupo y la zona de intercambio es 40 px y la separación interna
  es siempre 32 px, también cuando las laterales se degradan.
  El contenedor es `pointer-events: none` y solo las tarjetas son `auto`, para que arrastrar el mapa
  siga funcionando en el hueco. Su altura se suma a la altura del layout antes de `fitView`.
- Una fila por intercambio, no por movimiento: se emparejan los movimientos JSON con los nodos
  `request` visibles (`middlewareEndpoints`) y se añaden filas para los nodos `request` sin
  movimiento JSON, salvo cuando hay una celda SQL seleccionada. El orden es por hora. Las tarjetas
  laterales son fichas `infoCard` completas con sus secciones plegables (cabeceras, cuerpos, pila
  del iniciador, SQL de la ruta) y comparten `sectionExpanded` con el detalle del nodo.
  Los cuerpos JSON se muestran formateados con 2 espacios (el texto original solo si no es JSON
  válido). La petición se elige por `requestIds` del nodo y, si no, por método y camino con la hora
  más cercana al movimiento: esa asociación es heurística y se rotula con fila «Asociación» y chip
  HEURÍSTICO; nunca se presenta como directa. El destino backend preferido es el nodo `route`
  (coincidencia por método y camino, o arista `HANDLES` ruta → función); la función solo es el
  último recurso. Cada fila dibuja hasta cuatro enlaces SVG dentro del viewport —nodo → tarjeta y
  tarjeta → JSON en cada lado— y recalcula al cambiar layout, filtros o expansión. Los nodos
  `request` y `route` siguen en sus columnas: la fila no los sustituye.
- Con una celda SQL seleccionada, todo cuerpo JSON se poda a las ramas que contienen el valor de la
  celda, conservando los ancestros; los movimientos sin coincidencia se eliminan de todas las
  superficies y solo queda el mensaje de vacío. La poda por valor es heurística y no debe
  presentarse como linaje demostrado.
- Toda representación repetida —nodo, corredor, celda, movimiento JSON, etapa de la cadena,
  detalle, tooltip, raíl, fila de intercambio, resultado del buscador e interacción— se construye con
  `infoCard` → `InfoCardModel` → `renderInfoCard`/`mountInfoCard`. Cada superficie registra su
  proveedor en `infoProviders` con un id estable expuesto en `data-card-id`. No escribas HTML de
  tarjeta a mano: añade filas, secciones plegadas y pie al modelo. Las tarjetas laterales de la fila
  usan ids propios por fila (`req:` y `route:`) y las de la capa de nodos `canvas:<id>`, para no
  pisar el proveedor `node:` del SVG, y se purgan en cada reconstrucción.
- Orden de medición: `renderMiddleware` se ejecuta antes de `fitView` en `renderGraph` para que la
  altura de la rejilla cuente en el ajuste. No lo muevas después sin recalcular la altura.
- Render incremental por firmas: `snapshot.revision`, `jsonRailSignature`,
  `middlewareSignatureOf`, `infoCardSignature`. Si añades una vista costosa, dale una firma propia
  en vez de repintar en cada evento. Los estados de expansión viven en `expandedNodes` (nodos
  desplegados) y `sectionExpanded` (secciones, con claves prefijadas `json:`, `sql:`, `code:`,
  `req:`, `route:`); cada firma filtra por su prefijo para no repintar una superficie cuando se
  abre una sección de otra. La firma de la fila de
  intercambio incluye la geometría del hueco, el compacto, la celda elegida y las secciones
  abiertas; `applyFlowRequestState` la invalida al llegar detalle nuevo de peticiones. La tarjeta
  que contiene el editor con foco no se reconstruye: se sincroniza en sitio
  (`syncFocusedCodeEditor`) y conserva el `scrollTop`.
- Filtros y modos de alcance ocultan y vuelven a disponer el layout; no se limitan a bajar la
  opacidad. Lo mismo con los filtros de tipo/evento y con el de estado HTTP. El enfoque, «Solo
  esos» y el estado también filtran los movimientos JSON: `scopeForView` cruza
  `focusScope`/`trafficScope` con `statusScope()` y con el subgrafo del evento, y
  `jsonMovementVisible` exige que el dueño o un extremo esté dentro del alcance.
- El filtro de estado (`#map-status-filter`) usa claves `code:<n>`, `cat:2xx`…`cat:5xx`,
  `cat:other`, `pending`, `err` y `none` derivadas de `requestStatusView`, y `statusScope()` es la
  unión de `involvedScope(id, 'both')` de todas las peticiones que casan: el mismo aislamiento que
  «Ver interacciones», con contadores vivos. La clave sobrevive a las revisiones aunque no haya
  coincidencias (contador 0 y «Quitar filtro»); se limpia al abrir el mapa (ADR-077).
- El peso de cada nodo es real: `FlowNode.weight` lo calcula `NodeWeightMeter` como post-paso de
  `refreshFlow` —bytes UTF-8 del rango o del archivo, muestra observada en tablas y bases, cuerpos
  en peticiones— con nota del origen y caché por `mtimeMs`. Si no se puede medir, `bytes: null` y
  nota: nunca «0 B» inventado (ADR-075).
- Nodos `table`: rejilla SQL completa dentro del mismo SVG, con altura alimentada por
  `tableIndex`; en compacto se reduce a la cabecera. No crees una vista de datos paralela.
- Interacción: clic selecciona y resalta la cadena; clic derecho abre el menú contextual; `Escape`
  cierra tooltip fijo → menú → búsqueda → ventana; arrastrar desplaza y la rueda hace zoom. El
  tooltip se muestra mientras Shift está pulsado y Ctrl lo fija o lo suelta en pulsación corta;
  fijo, la esquina superior derecha de la tarjeta muestra un div con el texto exacto `bloquear`,
  acepta puntero y sobrevive al re-render. El estado de Shift se toma también de `event.shiftKey`
  en cada `pointermove` —no dependas del foco de teclado de la ventana— y el hover se sigue desde
  `#map`, no solo desde el SVG, para cubrir tarjetas de nodo, tarjetas de la fila de intercambio,
  raíl JSON e interacciones con `data-card-id`. «Ver interacciones» conserva «Solo esos»:
  `applyScopeView` cruza el alcance del nodo con el subgrafo del evento; no borres el filtro al
  enfocar. No añadas topes artificiales a la evidencia mostrada (ancestros, movimientos,
  peticiones); si un límite es de captura o memoria, muéstralo rotulado.
- El código de las tres superficies se edita sobre el archivo completo, nunca sobre el bloque
  recortado de `readCodeBlock`: la sección «Código» está plegada siempre —también sin compacta—,
  carga por `file:read` y guarda por `file:save` con Ctrl+S. Ctrl alterna el bloqueo del tooltip
  solo en pulsación corta (`ctrlPending`), para que Ctrl+S no lo dispare. Los cambios sin guardar
  se avisan en la sección y en la caja de estado, y cerrar el mapa con buffers sucios emite
  `map-close-blocked` con «Guardar y cerrar» / «Descartar y cerrar» / «Cancelar». Un cambio en
  disco ofrece «Recargar» o «Guardar encima», nunca sobrescritura silenciosa (ADR-076).
- El mapa agrupa por ruta: no prometas asociar una petición concreta a una consulta SQL ni un
  grafo de llamadas. La SQL y la ejecución N2 se asocian por ruta y ventana de 3 s.

## 7. Lenguaje visual

- Diseño plano: sin `border-radius`, sin bordes decorativos, sin sombras, sin gradientes y sin
  emojis. Separa superficies con color plano. El foco se marca con un contorno de 2 px.
- Paleta IDE: fondo `#0e1116`, panel `#14181f`, elevado `#1b2029`, texto `#d7dde7`, apagado
  `#8a94a6`, acento `#58a6ff`, peligro `#f85149`. Lienzo del mapa `#0b1017`, raíles `#10161e`.
- Colores de estado del mapa: envío azul (`#58a6ff`), recepción verde (`#3fb950`), gateway ámbar
  (`#d29922`), servidor morado (`#bc8cff`), lectura `#7ee2a8`, escritura `#e3b341`, éxito
  `#9fe3b8`, aviso `#ffd7a8`, error `#ffb4a8`.
- Tipografía: `Segoe UI, system-ui` 13 px para UI; `Cascadia Mono, Consolas` para código y datos.
  Etiquetas en mayúsculas de 8-11 px con `letter-spacing` 0.04-0.1em.
- Toda la copia visible va en español; identificadores, tipos y APIs en inglés. Comentarios solo
  cuando explican el porqué, en español.
- La vista compacta es el modo por defecto para ahorrar recursos. No la cambies a no ser que se
  pida.
- El mapa es SVG renderizado por Chromium. No asumas GPU moderna ni añadas rutas WebGL/D3D ni
  afirmes aceleración por GPU; debe funcionar en hardware de gama baja.

## 8. Flujo de trabajo

- Responde en español. Si el usuario numera los puntos, contesta punto por punto con el mismo
  número.
- Verificación mínima: `npm run typecheck` y `npm run lint`; añade `npm run build:main` si tocaste
  main o preload. No ejecutes tests ni `npm run verify` (incluye tests) salvo petición explícita:
  el usuario ejecuta la suite. No afirmes que algo "funciona" sin indicar qué se comprobó y qué
  no (por ejemplo, comportamiento visual en Electron).
- Un cambio, un propósito. Si el arreglo es sistémico, hazlo holístico y elimina la ruta vieja; no
  dejes dos mecanismos conviviendo.
- No especialices la herramienta en una aplicación concreta. Detección genérica, adaptadores y
  evidencia real. No añadas nombres de proyectos privados a docs, fixtures ni demos.
- Repo público (MIT): nada de rutas personales, secretos, capturas con datos reales ni
  información interna en el código o la documentación.
- Antes de cambiar una estructura global (protocolo, IPC, captura, layout, capas del mapa, tema),
  mira quién la consume en ambos lados y actualiza el consumidor en el mismo cambio.
- Si tomas una decisión de arquitectura, registra un ADR breve en `docs/decisions.md` y actualiza
  este archivo si cambia una regla global.

## 9. Checklist rápido

- [ ] ¿El dato es STATIC/RUNTIME correcto y la correlación está rotulada?
- [ ] ¿El saneado ocurre en el main antes de cruzar a la UI?
- [ ] ¿La capa nueva sigue el pan/zoom y el LOD del mapa?
- [ ] ¿Los filtros ocultan y re-disponen, no solo atenúan?
- [ ] ¿La evidencia mostrada sale del mismo snapshot que el resto de vistas?
- [ ] ¿El diseño es plano y la copia en español?
- [ ] ¿Typecheck y lint pasan? ¿Build si tocaba main/preload?
