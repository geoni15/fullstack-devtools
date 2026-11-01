# Decisiones de arquitectura

Registro breve de decisiones tomadas durante la implementación. Cada entrada indica contexto,
decisión y consecuencia.

## ADR-001 — npm workspaces y bundle sin dependencias de ejecución

**Contexto:** la spec exige monorepo con paquetes internos y empaquetado con electron-builder.
**Decisión:** usar npm workspaces (sin pnpm/yarn) y compilar `main`, `preload` y `renderer` con
bundlers (esbuild y Vite). `@bdt/protocol` se consume como fuente TypeScript y se integra en el
bundle; la app empaquetada no lleva `node_modules`.
**Consecuencia:** build reproducible y paquete pequeño; `@bdt/protocol` no puede importarse desde
Node sin pasar por un bundler, lo cual es aceptable porque solo lo consumen procesos empaquetados.

## ADR-002 — TypeScript 5.9.3 en lugar de 7.x

**Contexto:** la última estable es TypeScript 7.0.2, pero `typescript-eslint@8.72.1` declara
`typescript >=4.8.4 <6.1.0`.
**Decisión:** fijar TypeScript 5.9.3.
**Consecuencia:** se mantienen lint y typecheck con la misma versión; revisar cuando
`typescript-eslint` soporte 7.x.

## ADR-003 — Protocolo propio `bdt-app://` para el renderer en producción

**Contexto:** `file://` dificulta CSP estricta y la carga de workers de Monaco.
**Decisión:** registrar el esquema privilegiado `bdt-app` y servir `dist/renderer` mediante
`protocol.handle`, con guarda de rutas, MIME explícito y cabecera CSP.
**Consecuencia:** origen estable (`bdt-app://app`), workers y source maps funcionan; toda petición
fuera de `dist/renderer` devuelve 404. En desarrollo se usa `http://127.0.0.1:5173` con la misma
CSP declarada en el HTML.

## ADR-004 — Sin plugin de React Fast Refresh

**Contexto:** `@vitejs/plugin-react` inyecta un preámbulo inline que exige `script-src
'unsafe-inline'`.
**Decisión:** usar el transformador JSX de esbuild (Vite nativo). La recarga en caliente funciona,
sin Fast Refresh de componentes.
**Consecuencia:** CSP estricta sin `unsafe-inline` para scripts; en F0 no afecta al flujo.

## ADR-005 — Una sola raíz abierta y rechazo de la raíz del sistema

**Contexto:** §9.1 exige raíces explícitas y prohíbe acceso total al disco.
**Decisión:** F0 mantiene un único espacio de trabajo; al abrir otro se cierra el watcher anterior.
Se rechaza elegir `C:\` (o cualquier raíz de volumen).
**Consecuencia:** API simple y segura; multi-raíz, si llega, será una fase posterior.

## ADR-006 — Validación de rutas con `realpath` y sin seguir enlaces

**Contexto:** `..` no basta para impedir escapes por enlaces simbólicos.
**Decisión:** validar segmentos, resolver con `realpathSync.native` y comprobar que el destino real
sigue dentro de la raíz real. El árbol omite enlaces simbólicos.
**Consecuencia:** lectura fuera de la raíz y junctions que escapan se rechazan con
`BDT_E_PATH_ESCAPE`. Los enlaces internos tampoco se listan en F0.

## ADR-007 — Ignore list fija en F0

**Contexto:** el respeto a `.gitignore` pertenece al análisis de F3.
**Decisión:** ignorar `node_modules`, `.git`, salidas de build, cachés y entornos virtuales mediante
una lista fija compartida por árbol y watcher.
**Consecuencia:** el explorador no se satura en F0; la lectura de `.gitignore` se añadirá en F3.

## ADR-008 — Límites de lectura y de árbol

**Decisión:** archivos de hasta 2 MiB y UTF-8 sin bytes nulos; árbol de hasta 20 000 entradas y
20 niveles, con indicador `truncated`.
**Consecuencia:** se informa al usuario mediante error tipado o «vista truncada»; nunca se bloquea
la UI.

## ADR-009 — Fuses de Electron al empaquetar

**Decisión:** tras el empaquetado se desactivan `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`,
`EnableNodeCliInspectArguments` y `GrantFileProtocolExtraPrivileges`; se activan
`OnlyLoadAppFromAsar` y `EnableEmbeddedAsarIntegrityValidation`.
**Consecuencia:** el binario empaquetado no permite inyectar Node ni inspectores por entorno,
obliga a cargar la app desde `asar` y verifica su integridad. El estado de los fuses se comprueba
leyendo el binario con `getCurrentFuseWire` de `@electron/fuses`. En F0 solo se empaqueta Windows.

## ADR-010 — Playwright en modo Electron para e2e

**Contexto:** Playwright documenta soporte experimental de Electron y solo inyecta su cargador si
resuelve `electron` por sí mismo (sin `executablePath`).
**Decisión:** declarar `electron` también en la raíz del workspace (misma versión exacta, deduplicada)
para que Playwright lo resuelva; lanzar sin `executablePath`. Cada ejecución usa un
`--user-data-dir` temporal para no chocar con el bloqueo de instancia única de una app abierta. El
directorio de la app se normaliza sin separador final porque Playwright compone la línea de
comandos para `cmd.exe` y una barra final escaparía la comilla.
**Consecuencia:** el e2e depende del binario local de Electron y de una sesión gráfica; se ejecuta
con `ELECTRON_RUN_AS_NODE` eliminado del entorno. Es la única dependencia de prueba marcada como
experimental por Playwright.

## ADR-011 — Monaco con workers completos

**Decisión:** registrar workers de editor, TypeScript, JSON, CSS y HTML; tema propio `bdt-dark`
plano. Se importan como `monaco-editor/<ruta>.worker.js?worker` sin el prefijo `esm/vs` porque el
mapa de `exports` de Monaco 0.57 ya apunta a `esm/vs`.
**Consecuencia:** resaltado y servicios básicos de lenguaje disponibles en solo lectura; mayor
tamaño de build, aceptable para una app de escritorio.

## ADR-012 — Paneles de fases futuras sin datos simulados

**Decisión:** las pestañas de inspector, timeline, terminal y problemas existen con estados vacíos
explícitos («llega en F1/F2/F4»). No se muestran datos inventados ni se activan controles sin
función.
**Consecuencia:** la UI respeta la regla de divulgación de nivel y evita aparentar capacidades no
implementadas.

## ADR-013 — `WebContentsView` en lugar de `<webview>`

**Contexto:** §9 exige que la web inspeccionada no tenga acceso a IPC, Node ni archivos.
`<webview>` está desaconsejado por Electron y amplía la superficie de ataque.
**Decisión:** incrustar la página con `WebContentsView` creada en el proceso principal, sin preload,
con `contextIsolation`, `sandbox`, `nodeIntegration:false` y `webviewTag:false`. Usa una partición
en memoria (`bdt-inspector`), por lo que no persiste cookies ni caché en disco. Ventanas nuevas,
descargas, permisos y navegación fuera de los orígenes configurados se deniegan.
**Consecuencia:** la página es un proceso aislado sin puente con la app; el renderer solo controla
su rectángulo mediante `browser:bounds`. Verificado en e2e: `require`, `process` y `window.bdt` son
`undefined` dentro de la vista y el número de hijos de `contentView` vuelve a cero al desconectar.

## ADR-014 — Solo loopback y orígenes distintos para frontend y backend

**Contexto:** la captura N0 es para desarrollo local; aceptar hosts remotos abriría SSRF y fugas de
datos.
**Decisión:** `browser:configure` exige URLs `http(s)` con host `127.0.0.1`, `localhost` o `::1`,
sin credenciales embebidas, y rechaza que frontend y backend compartan origen.
**Consecuencia:** el backend debe ser alcanzable por loopback (CORS incluido). Cada petición se
clasifica como frontend, backend o externa por origen exacto, y la distinción se muestra en la
timeline.

## ADR-015 — CDP con cebado en `about:blank` y tiempo límite

**Contexto:** `Network.enable` no responde en un target que aún no ha navegado, dejando la conexión
en «Conectando…» indefinidamente.
**Decisión:** cargar `about:blank` antes de adjuntar `webContents.debugger` y habilitar `Network` y
`Debugger` con un límite de 5 s por comando. La pila asíncrona se activa con profundidad 8 y las
pausas del depurador se omiten y se reanudan automáticamente.
**Consecuencia:** la conexión falla con `BDT_E_BROWSER_CONNECT_FAILED` en lugar de colgarse, y un
adjunto fallido se desmonta por completo.

## ADR-016 — Minimización de datos N0 y enmascarado en origen

**Decisión:** no se almacenan parámetros SQL ni valores completos de cabeceras y URL. Las cabeceras
con nombres sensibles (`authorization`, `cookie`, `set-cookie`, `x-api-key`, y las que contienen
`password`, `token`, `secret`, `jwt`, `session`) se guardan como `[enmascarado]`; los valores de
query con esos nombres también se enmascaran en la URL y en la ruta. Los cuerpos de petición y
respuesta solo se conservan si son JSON de objeto o array, con las mismas claves sensibles
enmascaradas y un tope de 16 000 caracteres (ADR-031). Hay topes de 500 peticiones, 40 cabeceras
por petición y 2048 caracteres por URL.
**Consecuencia:** la timeline nunca muestra secretos; el e2e comprueba que el token inyectado no
aparece en el detalle. El enmascarado ocurre en el paquete `@bdt/network-capture`, antes de cruzar
el IPC, no en la UI.

## ADR-017 — Posición de la vista gobernada por el renderer

**Contexto:** `WebContentsView` no participa del layout de React y no puede posicionarse con CSS.
**Decisión:** el renderer observa con `ResizeObserver` el hueco reservado (`app-frame-host`) y envía
x, y, ancho, alto y visibilidad por `browser:bounds`; el principal recorta el rectángulo a los
límites de la ventana y oculta la vista con dimensiones cero o pestaña inactiva. Al desmontar se
envía `visible:false`.
**Consecuencia:** la página embebida queda exactamente encima de su hueco y desaparece al cambiar de
pestaña o desconectar. Nota Windows: `BrowserWindow.capturePage()` no incluye el contenido de la
vista; para capturarla hay que usar `view.webContents.capturePage()` o una captura del sistema.

## ADR-018 — Iniciador con pila asíncrona y source maps diferidos

**Decisión:** cada petición guarda el tipo de iniciador y hasta 8 marcos `http(s)` con línea y
columna en base 1; la profundidad asíncrona de CDP se conserva en un indicador. La resolución de
source maps queda para F2, por eso `mapped` siempre es `false`.
**Consecuencia:** la timeline ya atribuye peticiones a funciones concretas del código desplegado
(por ejemplo `cargarClientes`), sin prometer nombres de fuente originales hasta F2.

## ADR-019 — Navegador en ventana separada por defecto y barra de direcciones

**Contexto:** el requisito es que el navegador sea una ventana normal de Windows, fuera del IDE,
con barra de enlace, manteniendo disponible el modo integrado anterior.
**Decisión:** la UI ofrece `window` (por defecto) y `embedded`. En modo ventana se crea un
`BrowserWindow` (1360×880, título «Navegador · Backend DevTools») cuya webContents principal es una
barra HTML `data:` con preload `browser-chrome.cjs` en sandbox; la página inspeccionada vive en un
`WebContentsView` hijo debajo de una franja de 64 px. La barra muestra la URL real, atrás/adelante,
recarga e inspección ON/OFF. Solo se navega a los orígenes configurados; las órdenes se validan por
remitente y marco principal. Al redimensionar se recalcula el rectángulo de la vista y al cerrar la
ventana se desconecta la sesión. El panel de inspección es otro `WebContentsView` del mismo host,
fijo a la derecha de la página (ADR-025).
**Consecuencia:** el navegador es una ventana independiente normal y el modo integrado sigue
funcionando con el mismo motor de captura. La barra no comparte preload con la página. El e2e
verifica la barra, el bloqueo de destinos externos, la ausencia de Node/`bdt` en la página y el
cierre de la ventana al desconectar.

## ADR-020 — Inspector por clic en mundo aislado, recreado en cada navegación

**Contexto:** hay que atribuir un clic a la función del frontend sin exponer IPC ni Node a la
página. `Page.addScriptToEvaluateOnNewDocument` con `worldName` mostró una carrera: en algunas
cargas el mundo aislado no llegaba a crearse. Además, en Electron 45 `DOMDebugger.getEventListeners`
no devuelve el objeto `handler`, solo su ubicación.
**Decisión:** al recibir `Page.frameNavigated` del marco principal se crea el mundo aislado con
`Page.createIsolatedWorld`, se registra el binding `bdtInspectorClick` solo en ese contexto y se
evalúa un listener de captura para `click`, `submit` y `Escape`. Si el clic no trae coordenadas
(activación por teclado o `element.click()`), se usa el centro del rectángulo del elemento. Cuando
CDP no entrega el nombre del listener, se lee el código del script en la ubicación reportada y se
extrae el identificador; también se consultan las pistas de React/Vue (`__reactProps$`,
`__reactEventHandlers$`, `_vei`). La página no recibe preload ni objeto alguno de la app.
**Consecuencia:** el listener es invisible para la página y se reinstala de forma determinista tras
recargas y navegaciones. Los listeners anónimos se muestran como tales, sin inventar nombres. El
e2e verifica el elemento (`button`/`Cargar`), el manejador `cargarClientes` y que con Devtool OFF
no se abre ninguna tarjeta.

## ADR-021 — Tarjeta de inspección flotante y aislada (sustituida por ADR-025)

**Decisión:** la tarjeta es una `BrowserWindow` sin marco, 470×440, siempre encima, con preload
`browser-card.cjs` en sandbox y HTML `data:` con CSP `default-src 'none'`. El contenido se pinta
con `textContent`, nunca con HTML de la página. Se coloca junto al punto del clic, se oculta con
Cerrar o Escape y se destruye al desconectar. Solo atiende `browser-card:ready` y
`browser-card:close`, validando el remitente.
**Consecuencia:** es una ventana flotante normal de Windows, sin privilegios sobre la página, y no
puede inyectar marcado desde el contenido inspeccionado. Cerrar la tarjeta no corta la captura.

## ADR-022 — Correlación clic → petición → endpoint con relojes sincronizados

**Decisión:** la ventana de inspección es de 3 s con 150 ms de tolerancia. Los eventos de red usan
el reloj monotónico de CDP y el clic usa el reloj de pared, así que se calcula un desfase con cada
`Network.requestWillBeSent` y se compara en la misma base. Se descartan los preflight CORS
(`OPTIONS` con `Access-Control-Request-Method`). Al abrir una sesión se revisa todo el búfer para no
perder peticiones que llegaron antes que la señal del binding; la ventana de 3 s solo clasifica y
ordena la correlación, no descarta peticiones. La correlación es `directa`
solo si el nombre de la función iniciadora coincide con el manejador resuelto; en caso contrario es
`heurística` y así se etiqueta. Cuando el manejador se resuelve después, se recalifican las
peticiones ya registradas. La coincidencia con una ruta estática añade la evidencia `STATIC` y el
nivel N1; la captura y el manejador del frontend aportan `RUNTIME`. Si dentro de la ventana se
observa una pausa del inspector de Node en el punto de parada de esa ruta, se adjunta la ejecución y
el nivel pasa a N2 (ADR-026).
**Consecuencia:** la tarjeta muestra la petición y la función del backend con evidencia explícita y
sin prometer correlación exacta cuando no la hay. N1 solo aparece si hay una ruta estática
coincidente; N2 solo si además se observó ejecución.

## ADR-023 — Índice estático acotado para Express, Fastify, FastAPI y Flask

**Contexto:** el backend puede estar en Node o Python y no se debe ejecutar ni modificar el
proyecto para descubrir rutas.
**Decisión:** el paquete `@bdt/routes-index` analiza el árbol abierto con `web-tree-sitter` 0.27.1 y
gramáticas locales de JavaScript y Python. Reconoce `app.get/post/put/patch/delete` de Express,
los métodos equivalentes de Fastify, y los decoradores `@app.get/@app.post/...` de FastAPI y
`@app.route` de Flask. Se ignoran `node_modules`, `.git` y archivos sensibles; los topes son 600
archivos, 512 KiB por archivo, 12 MiB en total y 60 s de validez antes de reconstruir. Cada
resultado es una ruta estática con archivo, línea de inicio, línea final del cuerpo y `resolved`; los
prefijos dinámicos quedan sin resolver con una nota.
**Consecuencia:** se cubren los patrones más comunes, no todos (routers montados con prefijos
calculados, metaprogramación o frameworks no listados). La tarjeta etiqueta el resultado como
`STATIC` y explica cuándo no hay coincidencia, sin afirmar ejecución del backend.

## ADR-024 — Node en ejecución y source maps quedan fuera de esta fase (sustituido por ADR-026)

**Contexto:** se pidió ver «lo que ejecuta Node.js». La instrumentación del runtime del backend
(adjuntar el inspector de Node, trazar la función que atiende la petición y sus efectos) pertenece
a F4 según el plan, y la resolución de source maps del frontend sigue pendiente.
**Decisión:** esta fase no se adjunta al proceso Node del backend ni se presentan nombres de
código fuente originales. La tarjeta usa `STATIC` para la ruta y el manejador del backend, y
`RUNTIME` solo para lo observado en el navegador (clic, manejador del frontend, petición). No se
inventan APIs de depuración ni se afirma ejecución del backend.
**Consecuencia:** queda una limitación visible y honesta: el usuario ve el endpoint y la función
que lo declara, no la traza de su ejecución. F4 añadirá la evidencia de runtime del backend; los
source maps se abordarán por separado.

## ADR-025 — Panel de inspección fijo a la derecha, con código numerado

**Contexto:** la tarjeta flotante resultaba incómoda y no mostraba la función ni las líneas del
backend. Se pidió un panel fijo a la derecha de la ventana del navegador y acceso a los archivos del
proyecto para leer el código del manejador.
**Decisión:** el panel es un `WebContentsView` hijo del mismo `BrowserWindow` que la página, no otra
ventana. Se coloca a la derecha del rectángulo de la página: si la inspección está activa y el host
mide al menos 640 px, ocupa `min(430, max(300, 36 %))`; la página se encoge para dejarle sitio. Con
la inspección OFF o un host estrecho, el panel se oculta y la página usa todo el ancho. Usa la
partición `bdt-panel`, preload `inspection-panel.cjs` en sandbox y HTML `data:` con CSP
`default-src 'none'`; pinta con `textContent` y no expone IPC de la app. El snippet del manejador se
lee con el guardián de raíz (`realpath`, rechazo de `..` y enlaces que escapan, 2 MiB, UTF-8) y se
muestra con números de línea, desde `line` hasta `endLine`, con la línea de registro de la ruta
aparte. El tope es 80 líneas y las líneas de más de 320 caracteres se recortan con aviso.
**Consecuencia:** no hay ninguna ventana flotante; el panel se mueve y redimensiona con el
navegador. No se concede acceso al disco completo: solo se leen archivos dentro de la raíz abierta.
Los archivos sensibles siguen sin indexarse para explicaciones.

## ADR-026 — Inspector de Node opcional para evidencia N2

**Contexto:** se pidió ver qué función del backend se ejecuta y en qué línea, por ejemplo
`index.js` en la línea X. El plan deja el lanzamiento del backend y OTLP para F4, pero §6.5 permite
adaptadores de inspección del lenguaje.
**Decisión:** la conexión acepta un puerto de inspector opcional. El adaptador consulta
`/json/list` en `127.0.0.1`, valida que el WebSocket sea de bucle local y del mismo puerto, abre el
protocolo CDP, habilita `Debugger` y registra puntos de parada solo en las líneas de manejadores
resueltos del índice estático (JS/TS, sin `node_modules`) y, desde ADR-028, en las líneas de llamadas
SQL literales dentro de esos manejadores. No modifica el proyecto: el backend se
inicia con `node --inspect=PUERTO` fuera de la app o la propia app lo arranca con esa bandera
(ADR-027). Cuando se pausa en un punto propio, captura archivo,
línea, columna y función del marco, lee un contexto del archivo con el guardián de raíz y reanuda de
inmediato. Las pausas ajenas no se tocan. La ejecución se asocia a la inspección solo si cae en la
ventana del clic y su punto de parada corresponde al endpoint observado; entonces la tarjeta pasa a
N2 con evidencia `RUNTIME`. Si el puerto no responde, el panel lo explica y conserva el análisis
estático.
**Consecuencia:** la línea mostrada es la realmente ejecutada por Node, no una suposición. Siguen
fuera de alcance los source maps (las líneas de TypeScript compilado son las del código ejecutado) y
el runtime de Python, que se queda en N1. El e2e levanta un backend Node real, hace clic en el
frontend y comprueba función, archivo, línea ejecutada y nivel N2.

## ADR-027 — Arranque automático del backend con `--inspect`

**Contexto:** pedir al usuario que ejecute `node --inspect=PUERTO` en otra terminal rompe el flujo:
tiene que elegir puerto, arrancar el proceso y acordarse de cerrarlo. Se pidió que la app lo haga.
**Decisión:** la conexión acepta un comando opcional (`node backend/server.js`) y un directorio de
trabajo relativo a la raíz abierta. El comando se tokeniza en JS (comillas simples o dobles, sin
escapes de barra invertida, sin prefijos de entorno) y se ejecuta con `shell: false`; solo se acepta
un ejecutable `node`/`node.exe`. La entrada y el `cwd` se resuelven con el guardián de raíz
(`realpath`, sin `..`, sin enlaces que escapen, archivo y directorio existentes). Si no se indica
puerto de inspector, la app reserva uno libre en `127.0.0.1`; siempre añade
`--inspect=127.0.0.1:PUERTO` y rechaza comandos que ya traigan `--inspect` u opciones de Node. El
proceso hereda el entorno y recibe `PORT` con el puerto del backend configurado. La app espera hasta
15 s a que `/json/list` responda antes de crear las vistas; los primeros 8 KiB de salida se guardan
solo para el mensaje de error. El proceso se detiene al desconectar, cerrar la ventana o salir de la
app (SIGTERM y SIGKILL a los 2 s); si muere después de arrancar, el error se muestra en la conexión.
Sin comando, se mantiene el modo externo de ADR-026 y el puerto de inspector es opcional.
**Consecuencia:** el flujo completo es un solo paso y el backend no queda huérfano. El requisito es
tener Node.js instalado y en el PATH; no se soportan gestores de paquetes (`npm run dev`), prefijos
de variables ni otros intérpretes. No se escribe nada en el proyecto: solo se lee para validar rutas
y se lanza un proceso hijo, revisado contra §9 (sin shell, sin puertos remotos, sin escribir en el
proyecto; la salida del proceso solo se usa para el mensaje de error local).

## ADR-028 — Consultas SQL estáticas y observadas por línea (alcance acotado)

**Contexto:** se pidió ver las peticiones SQL de cada manejador. El nivel N3 del plan exige esquema
de base de datos y consultas observadas; obtener esquema requiere credenciales de desarrollo y no
estaba en esta fase. §6.4 admite extraer solo literales y plantillas sin interpolación, y marcar
`dynamicSql` cuando el texto se construye en ejecución.
**Decisión:** `@bdt/sql-analyzer` (node-sql-parser 5.4.0, ejecutado localmente) analiza el SQL
literal y devuelve operación, tablas leídas/escritas, columnas con su uso, dialecto, `parse` y
`SELECT *`. El índice de rutas extrae las llamadas SQL del cuerpo del manejador con tree-sitter:
métodos directos (`query`, `execute`, `exec`, `executemany`, `raw`, `unsafe`, `prepare`, etc.),
métodos condicionales (`get`, `all`, `run`, `fetchone`, …) solo cuando el receptor parece de base de
datos, y plantillas etiquetadas. Una plantilla con interpolación o un argumento calculado se marca
dinámico sin inventar el texto; los literales que el analizador no puede interpretar y no exponen
tablas se descartan para evitar falsos positivos. El panel muestra cada consulta como **POSIBLE**
(evidencia `STATIC`); con el inspector de Node conectado se añade un punto de parada en la línea de
la llamada, pero solo si esa línea contiene una única consulta. Cuando Node se pausa en ella, la
consulta pasa a **OBSERVADA** (`RUNTIME`) y se asocia al clic por la ventana de inspección y la ruta,
igual que N2. La observación no eleva el nivel a N3: sin esquema no hay expansión de `SELECT *` ni
validación de columnas.
**Consecuencia:** se ve la operación, las tablas y las columnas que el código declara, y se distingue
lo literal de lo dinámico. No se conecta a ninguna base de datos, no se piden credenciales, no se
evalúan expresiones y no se guardan parámetros ni valores: solo líneas ejecutadas y texto del
código. Varias llamadas en una misma línea quedan sin confirmar con una nota. Python se analiza en
estático porque el inspector disponible es el de Node. Límites conocidos: SQL repartido en helpers
fuera del cuerpo del manejador no se detecta, el dialecto se infiere por heurística y el análisis
puede fallar con sintaxis específica (queda como `fallback` con nota).

## ADR-029 — Registro cronológico único, pestaña de peticiones y captura SQL de drivers

**Contexto:** la observación por línea de ADR-028 solo ve la consulta cuando Node se pausa en el
punto de parada, así que se pierde todo el SQL ejecutado en helpers, bucles, otras líneas o código
sin puntos propios. Además, las peticiones HTTP compartían panel con el resto de la información y no
había una vista única de lo que hace la página en orden temporal. Se pidió captar «todo» el SQL,
separar las peticiones en su propia pestaña y tener un registro completo con filtros por peticiones,
frontend, backend y SQL.
**Decisión:** tres piezas.
(1) **Registro cronológico** (`Registro` es la pestaña por defecto del panel inferior): la app
principal mantiene un búfer circular en memoria de 1000 eventos y lo envía por lotes cada 150 ms al
renderer, que los fusiona por `id` y ordena por marca de tiempo. Cada evento tiene categoría
(`frontend`, `request`, `backend`, `sql`), tono (`info`, `ok`, `warning`, `error`), título, detalle,
método/ruta y archivo:línea opcionales. Se registran navegaciones, navegaciones internas, fallos de
carga, recarga, pérdida del proceso renderer, clics y envíos de formulario (con o sin Devtool de
inspección activo; el panel de la tarjeta sigue dependiendo del interruptor), arranque y salida del
backend lanzado, cambios de estado del inspector, ejecuciones de manejadores, líneas SQL ejecutadas y
ejecuciones SQL capturadas en el driver. Los filtros `Todo`, `Peticiones`, `Frontend`, `Backend` y
`SQL` muestran solo su categoría con contador, para que el usuario decida qué parte ver. Las
peticiones HTTP siguen en la pestaña `Peticiones` con su propia insignia de recuento, ya separadas
del registro.
(2) **Captura SQL de drivers:** al conectar el inspector, la app inyecta una sola vez (idempotente
vía `globalThis.__bdtSqlCapture`) un envoltorio en el proceso del backend que intercepta los drivers
soportados: `pg` (`Client.prototype.query`), `mysql2` (`query`/`execute`), `mysql` (`query`),
`sqlite3` (`run`/`all`/`get`/`each`/`exec` y sentencias preparadas) y `better-sqlite3` (`exec`,
`pragma` y sentencias preparadas). El módulo se resuelve desde `process.argv[1]`/`cwd` con
`require`, `process.mainModule.require` y `createRequire`; cada driver se envuelve solo si se puede
cargar. El gancho guarda únicamente el texto SQL (≤2000 caracteres) y hasta 4 marcos de pila de
código de la app (sin `node_modules`, `node:` ni rutas internas), deduplica 20 ms por driver+SQL y
usa un búfer circular de 300 entradas que el inspector drena cada 400 ms con
`Runtime.evaluate`. El SQL capturado se asocia a la tarjeta de inspección activa: se marca la
consulta estática coincidente como **OBSERVADA** (`RUNTIME`) o se añade una consulta de runtime con
la línea del marco de la app. Sigue siendo evidencia N2, no N3: no hay esquema.
(3) **Seguridad y límites:** no se capturan parámetros, valores enlazados, resultados ni
credenciales; no se escribe nada en el proyecto ni se persiste el registro (vive en memoria y se
limpia al recargar, borrar o desconectar). Las URLs registradas pasan por el mismo enmascarado de
ADR-025. El gancho corre dentro del proceso que el usuario ya inspecciona, no añade IPC ni Node a la
página inspeccionada y no abre puertos nuevos. Prisma no es capturable porque ejecuta en su motor
Rust; el registro muestra ese límite al activarse la captura. Los cambios de estado del panel
(conectado/no disponible) también quedan en el registro, sin exponer datos sensibles.
**Consecuencia:** el registro refleja en orden lo que ocurre en la página y permite aislar cada capa
con un filtro; las peticiones tienen su pestaña propia; y el SQL se ve aunque se ejecute fuera de las
líneas con punto de parada. El e2e usa un backend Node real con `--inspect` y un módulo `pg` local
falso, y comprueba el registro cronológico, los filtros, la pestaña de peticiones y que la actividad
`SQL SELECT` aparece solo por la captura del driver. Límites conocidos: solo drivers soportados
(ORM con motor propio como Prisma queda fuera), SQL dinámico se muestra tal cual se ejecuta sin
parámetros, y un búfer lleno descarta lo más antiguo.

## ADR-030 — Peticiones de fondo y selección por petición en la tarjeta de inspección

**Contexto:** en una aplicación real con formularios largos, un pie fijo para agregar registros
depende de datos y selectores que se cargan de fondo al montar el módulo, antes de que el usuario
haga clic en una fila. La tarjeta solo asociaba la primera petición que terminaba después del clic
—en la práctica, una petición que disparaba el propio pie— y descartaba todo lo anterior; al hacer
clic sobre contenido ya cargado no mostraba ninguna petición. El usuario lo describió como que la
devtool creía que todo lo observable estaba en ese pie. Un intento previo de convertir el panel en
una superposición no resolvía la detección y se descartó: el panel vuelve al reparto de ancho de
ADR-025.
**Decisión:** la tarjeta incorpora dos capas. (1) **Flujo completo:** al abrirse vuelca todo el
búfer de peticiones al backend de la sesión, sin tope ni deduplicación y en orden cronológico de
inicio, y sigue añadiendo las nuevas al recibirse `Network.requestWillBeSent`, no al terminar, para
no perder las lentas. La ventana de 3 s solo etiqueta `CLIC` frente a `FONDO`; no corta la lista ni
deja de admitir peticiones posteriores. Se incluyen tanto las del origen del backend como las que
coinciden con una ruta estática indexada, de modo que un proxy de desarrollo no oculta llamadas.
(2) **Función por petición:** cada petición resuelve su propia ruta estática y la tarjeta pinta
`manejador · archivo:línea · framework` en su fila. Las filas son botones: al seleccionar una, la
sección inferior (endpoint, código, SQL y ejecución N2) muestra esa petición. La selección
automática prefiere una petición `CLIC` con correlación directa, luego la primera `CLIC` y, si el
clic no generó ninguna, la última de fondo; cualquier selección manual queda fijada. La evidencia
sigue separada: STATIC solo marca la ruta resuelta y RUNTIME lo observado; N2 sigue exigiendo una
pausa del inspector en el manejador seleccionado.
**Consecuencia:** un clic sobre contenido ya cargado ya no aparece vacío: la lista y la sección
inferior muestran todo lo que la página pidió al backend, incluida la carga inicial del módulo, y el
pie deja de ser la única lectura posible. El búfer de red, el registro de actividad y la lista del
panel no tienen tope (antes 500, 1000 y 12); el coste es memoria y renderizado proporcional a toda
la sesión, aceptado explícitamente por el usuario. No se modifica la aplicación inspeccionada, los
cuerpos JSON se capturan enmascarados y acotados (ADR-031) y el panel no se superpone: mantiene el
reparto de ancho de ADR-025.

## ADR-031 — Código del manejador frontend, cuerpos JSON y resaltado sin dependencias

**Contexto:** la tarjeta mostraba el nombre del manejador del clic pero no su cuerpo, y las
peticiones solo exponían URL, estado y cabeceras: el usuario no veía qué datos envió el frontend ni
qué devolvió el backend. Además, el panel usaba texto plano para todo el código y las consultas
dinámicas mostraban un marcador «SQL dinámico: texto no capturado» que no aportaba información.
**Decisión:** (1) **Frontend:** en React y Vue el manejador se obtiene con
`Function.prototype.toString` desde el mundo aislado; en listeners directos se lee el script con
`Debugger.getScriptSource` y se recorta una ventana de 12 líneas de contexto (máximo 80) alrededor
de la ubicación del listener. El bloque se envía como `InspectionCodeBlock` con archivo, rango y
líneas, y se pinta bajo el manejador. (2) **JSON:** se captura `request.postData` y, tras
`loadingFinished`, `Network.getResponseBody` solo para respuestas JSON. Se aceptan objetos y arrays,
se enmascaran claves sensibles de forma recursiva, se limita a 16 000 caracteres y se mantiene solo
en memoria; la UI indica si el cuerpo quedó recortado. (3) **Resaltado:** un tokenizador propio en
el preload del panel (JS/TS, Python, SQL y JSON) pinta tokens como nodos `span` con la paleta
dark+ de VS Code; no se usa `innerHTML` ni se cargan librerías externas, respetando la CSP
`default-src 'none'`. (4) **SQL dinámico:** se dejan de crear entradas sin texto; las consultas
capturadas por el driver siguen mostrándose como observadas. (5) **Textos:** se eliminan leyendas,
avisos y notas largas del panel y del detalle de peticiones.
**Consecuencia:** el panel explica el clic completo (handler → petición → backend → SQL) con código
legible y cuerpos JSON en ambos sentidos. El código del frontend es el compilado que ejecuta el
navegador, sin source maps; los cuerpos no se persisten ni se envían al proveedor de IA y las
claves sensibles siguen ocultas. Esta captura es una excepción explícita al valor por defecto de
§9.10 solicitada por el usuario: siempre enmascarada, acotada a 16 KB y solo en memoria. El coste
es un tokenizador acotado por línea y hasta 16 KB por cuerpo en memoria, sin tocar la aplicación
inspeccionada.


## ADR-032 — Hora local por petición y secuencia cronológica al seleccionarla

**Contexto:** las peticiones mostraban estado y duración, pero no el instante en que ocurrieron, y
al seleccionar una solo se veían su endpoint y sus cuerpos. El usuario pidió ver la hora
(hora/minutos/segundos) de cada petición y, al hacer clic en una concreta, todo lo que hizo esa
petición en orden cronológico. `CapturedRequest.startedAt` usa el reloj monotónico de CDP
(`Network.requestWillBeSent.timestamp`), útil para comparar ventanas pero no para mostrar la hora.
**Decisión:** (1) **Hora real:** se añade `wallStartedAt` (epoch en ms) a `CapturedRequest` e
`InspectionRequest`. El controlador lo toma de `wallTime` de CDP y, si no está disponible, del reloj
del sistema al recibir el evento; el búfer lo redondea y lo propaga. La tarjeta superior y la tabla
de Peticiones del IDE muestran `HH:MM:SS` local en cada fila. (2) **Secuencia:** al seleccionar una
petición se pinta una lista cronológica con hora por paso: `FRONTEND` (función iniciadora de CDP),
`HTTP` (método y ruta enviados), `BACKEND` (pausa del inspector) y `SQL` (consultas observadas)
cuando la petición resuelve al mismo manejador que la tarjeta y el evento cae dentro de su ventana
de inicio–fin; cierra con `RESPUESTA` (código y duración) o «Pendiente». La tabla del IDE limita la
secuencia a lo que conoce en N0: iniciador, envío y respuesta. Los pasos estáticos de la ruta no se
incluyen en la secuencia para no presentarlos como ejecución; la resolución estática sigue en su
sección y la evidencia STATIC/RUNTIME no cambia.
**Consecuencia:** cada petición se ubica en el tiempo y su detalle responde qué hizo y en qué orden
sin inventar pasos. Las consultas y pausas del inspector se atribuyen por manejador y ventana
temporal, de modo que una petición de fondo que terminó antes del clic no hereda el SQL del clic;
en peticiones concurrentes al mismo manejador la atribución es aproximada y la UI no la presenta
como correlación exacta. El coste es un campo numérico adicional y una lista corta por selección.

## ADR-033 — Cinco modos de inspección por hover

**Contexto:** la inspección existente exigía un clic por elemento y mezclaba en una sola tarjeta
propiedades, manejador, peticiones, backend y SQL. El usuario pidió cinco modos explícitos —HTML/CSS,
Frontend, Backend, Petición y Base de datos— seleccionables en el panel, y que al pasar el mouse se
muestre solo la información del modo activo, sin cambiar de página ni tocar la aplicación
inspeccionada.
**Decisión:** (1) **Selector:** el encabezado del panel fija cinco pestañas planas; la elección se
envía por `BROWSER_PANEL_CHANNELS.setMode` al proceso principal, que es el único que la guarda y la
reexpone en cada snapshot del panel. Al cambiar de modo se oculta el tooltip y se vuelve a resolver
el elemento bajo el cursor, sin esperar a que se mueva. (2) **Señal de hover:** el mundo aislado
escucha `mousemove` con captura y emite `hover` solo cuando cambia el elemento destino, con
limitación de 60 ms; `mouseout` hacia fuera de la ventana, scroll, blur, Escape y apagar la
inspección ocultan el tooltip. Cada resolución lleva un número de secuencia para que una respuesta
asíncrona antigua no pise a una más reciente. (3) **Resolución:** con CDP se obtienen etiqueta,
atributos, tamaño y estilos calculados del elemento; el manejador de eventos, la cadena de
componentes React/Vue y el código se reutilizan de la inspección por clic. Las peticiones se
infieren de forma estática del `action` de formularios, `href`, atributos `data-url` y del cuerpo del
manejador (`fetch`, `axios`, XHR), se deduplican y se contrastan con el búfer de red para mostrar la
última observación real. Backend y SQL salen del índice estático de rutas y del analizador SQL ya
existentes. (4) **Contenido por modo:** HTML/CSS muestra etiqueta, selector, tamaño y estilos
calculados agrupados; Frontend muestra evento, manejador, componentes y una ventana de código;
Backend muestra método, ruta, archivo y función; Petición muestra destino, disparador y la última
petición observada con hora, estado y duración; Base de datos muestra las rutas resueltas y el SQL
estático con sus tablas. (5) **Presentación en página:** un host `bdt-hover-tip` con Shadow DOM
cerrado y hoja de estilos construible dibuja el tooltip junto al cursor, y un `bdt-hover-box`
translúcido marca el rectángulo del elemento; ambos se posicionan por CSSOM, respetan la CSP
`default-src 'none'` y nunca usan `innerHTML`. El clic sigue abriendo la tarjeta completa del panel.
(6) **Honestidad de evidencia:** lo inferido se rotula `ESTÁTICO` o «no ejecutado» y solo la
observación de red real se presenta como ejecución; N2/N3 no cambian y siguen exigiendo pausas y
consultas observadas.
**Consecuencia:** recorrer la página con el mouse responde, según el modo elegido, qué elemento es,
qué lo controla, a qué endpoint iría, cuál fue la última petición real y qué SQL hay detrás, sin
modificar la aplicación inspeccionada ni añadir dependencias. Las peticiones y consultas inferidas
son aproximadas: la UI las distingue del runtime y no las usa para subir de nivel. El tooltip vive
en el árbol de la página inspeccionada, pero aislado en Shadow DOM y sin acceso a Node, IPC ni
archivos; se elimina al desactivar la inspección. El coste es un listener de `mousemove` limitado a
60 ms y una consulta CDP por cambio de elemento.

## ADR-034 — Procedencia del texto en los modos Frontend, Backend, JSON y Base de datos

**Contexto:** los modos por hover respondían qué elemento era, qué lo controlaba y qué SQL había
detrás, pero ante un texto renderizado —por ejemplo «Saldo disponible: 12 500 extraído desde la base
de datos»— no decían de qué cuerpo JSON salió, qué objeto y ruta lo contenían, qué funciones lo
retornaron ni qué base de datos lo sirvió. El usuario pidió esa procedencia en los modos Frontend,
Backend, JSON (antes «Petición») y Base de datos.
**Decisión:** (1) **Búsqueda en cuerpos JSON:** `findJsonTextMatches` recorre los cuerpos capturados
(máximo 80 cuerpos, 8 000 nodos, profundidad 14) buscando el texto del elemento normalizado;
devuelve la ruta `$...`, la ruta contenedora, la clave, el valor y un extracto del contenedor. Se
busca primero en respuestas, de la más reciente a la más antigua, y solo si no hay coincidencia se
prueba con cuerpos de petición; una coincidencia parcial requiere al menos 8 caracteres y el texto
buscado al menos 3. Si el texto visible fue transformado (montos con separadores o una frase que
contiene el valor), una segunda pasada busca números equivalentes y valores de texto largos dentro
del texto del elemento; esas coincidencias se rotulan `(aprox.)`. La caché de parseo por `WeakMap` y
una caché de hover de 1,2 s acotan el coste.
(2) **Petición y ruta:** la coincidencia resuelve el `CapturedRequest` en el búfer y la ruta estática
por método y camino; el backend muestra la función y el archivo del manejador observado, o las
candidatas estáticas rotuladas `ESTÁTICO`. (3) **Funciones del frontend:** además del manejador del
elemento, se muestra la pila de iniciadores de CDP de la petición (`initiator.frames`): las
funciones que dispararon la petición que transportó el texto, con archivo y línea. (4) **Props
React/Vue:** la inspección del elemento recorre las props de los componentes de la cadena (React
`memoizedProps`/`pendingProps`, Vue `props`/`vnode.props`) hasta profundidad 3 y devuelve las que
contienen el texto, incluidas las que transportan el mismo número aunque esté formateado, con
componente, framework y ruta de prop. (5) **Base de datos:** un análisis
estático de las fuentes del proyecto detecta motor y nombre de base de datos desde configuración
(Prisma, Sequelize, Mongoose, SQLite, variables de conexión); se prefiere el archivo más cercano a la
ruta resuelta y, si el nombre solo aparece como valor por defecto de una variable de entorno
(`process.env.DB_NAME || "miapp"`), se rotula «(valor por defecto)». Nunca se leen `.env` ni
se muestran credenciales, hosts o cadenas de conexión: solo motor, nombre y archivo. Las columnas y tablas siguen saliendo del analizador SQL existente.
(6) **Presentación:** el modo «Petición» pasa a llamarse «JSON»; cada modo pinta en la tarjeta sus
filas de procedencia y el objeto JSON contenedor se muestra como bloque de código resaltado.
(7) **Honestidad:** solo la petición observada se rotula como tal; las rutas, SQL y configuración de
base de datos detectados en fuentes se rotulan `ESTÁTICO` y no cuentan como ejecución.
**Consecuencia:** un texto visible se puede rastrear hasta su cuerpo JSON, su petición, las funciones
del frontend que la originaron, el manejador del backend y el motor/base de datos declarado en el
proyecto, sin tocar la aplicación inspeccionada ni enviar datos a terceros. La procedencia es
heurística: si el texto fue transformado en el cliente, proviene de un cuerpo no capturado, quedó
recortado o se construyó dinámicamente, la tarjeta lo indica en lugar de inventar un origen. El coste
es una búsqueda acotada por hover con caché y una inspección de props limitada en profundidad.

## ADR-035 — Procedencia tolerante a cuerpos recortados y datos crudos del componente

**Contexto:** la procedencia de ADR-034 solo encontraba textos cuando el cuerpo JSON capturado
parseaba completo y el texto visible coincidía con un valor. En aplicaciones reales, las respuestas
de tablas grandes superan los 16 000 caracteres, el cuerpo se guarda recortado a mitad de token y
`JSON.parse` falla; además, muchas celdas muestran valores formateados o se alimentan de props y
estado que no coinciden literalmente con el JSON, de modo que los modos Frontend, Backend, JSON y
Base de datos quedaban vacíos aunque la petición existiera.
**Decisión:** (1) **Parseo tolerante:** `parseBody` intenta `JSON.parse` y, si el cuerpo está
recortado, reconstruye el prefijo válido más largo posible: un escaneo único registra cierres de
objeto/arreglo, fin de cadenas y fin de números, descarta la cola incompleta y cierra los
contenedores abiertos; se prueban como máximo 16 fronteras, de la más reciente a la más antigua, y
el resultado se cachea por `WeakMap`. La coincidencia se rotula «cuerpo recortado» y sigue siendo
evidencia observada del prefijo, nunca del cuerpo completo.
(2) **Huellas de datos del componente:** además de las props que contienen el texto, la inspección
recoge valores crudos de props anidados (profundidad 3, 30 claves/ítems, máximo 80 valores), del
estado de hooks de React (`memoizedState`, 24 hooks) y del estado de Vue (`setupState`, `data`),
saltando nodos DOM, promesas, elementos React, claves sensibles y claves internas. El proveedor
puntúa objetos y arreglos por cuántos valores coinciden; exige dos coincidencias o un valor fuerte
(cuatro dígitos o texto con espacio de ocho caracteres) y prefiere el objeto de fila sobre el
arreglo contenedor. La coincidencia se rotula «por datos» y se trata como aproximada.
(3) **Texto transformado:** la comparación ignora mayúsculas, acentos y espacios repetidos, acepta
números con separadores de miles y decimales en cualquier convención y, como último recurso,
valores del JSON contenidos en el texto visible o viceversa. Todo lo aproximado se rotula
«(aprox.)» o «(parcial)».
(4) **Captura de respuestas grandes:** `sanitizeJsonBody` serializa enmascarando con presupuesto en
lugar de clonar el árbol completo; el cuerpo guardado sigue limitado a 16 000 caracteres y solo en
memoria, pero se aceptan hasta 4 000 000 de caracteres de entrada para no descartar respuestas
grandes antes de recortarlas. Las claves sensibles se sustituyen por `[enmascarado]` durante la
escritura, antes de cualquier recorte. Las respuestas XHR/Fetch se intentan capturar aunque el MIME
no declare JSON; el saneador solo acepta objetos y arreglos JSON válidos.
(5) **Rutas con prefijo montado:** si el camino de la petición no coincide exacto con una ruta
estática, `matchRoute` prueba sufijos del camino (por ejemplo `/api/books` contra una ruta `/books`
montada con `app.use('/api', …)`) y, en último término, sufijos de la ruta contra el camino (por
ejemplo una ruta `/api/books` cuando el cliente llama `/books` con `baseURL`). La coincidencia se
marca en la nota de la ruta para no presentarla como exacta.
(6) **Base de datos sin nombre declarado:** si el proyecto no declara un nombre de base de datos
pero el SQL analizado sí revela el dialecto, el modo Base de datos muestra el motor
(MySQL/PostgreSQL/SQLite) y aclara que el nombre no está declarado; nunca se leen `.env` ni
credenciales.
**Consecuencia:** el hover encuentra la petición y la ruta aunque el texto visible esté formateado o
provenga de una respuesta recortada, y los cuatro modos muestran procedencia con evidencia
etiquetada. Sigue siendo heurística: una fila sin ningún valor capturado en los primeros 16 KB o en
las props/estado del componente se informa como sin coincidencia, sin inventar origen. El coste es
un escaneo acotado con caché de parseo y una inspección de estado limitada por profundidad, cantidad
y tamaño de valores.

## ADR-036 — Arranque automático desde package.json y captura sin límites

**Contexto:** la app exigía escribir a mano el comando «node archivo» del backend y no arrancaba el
frontend; en proyectos reales con varios `package.json` eso obligaba a adivinar script, directorio y
puerto. Por otra parte, los topes internos de archivos, cuerpos y peticiones hacían que algunas
peticiones o textos no aparecieran nunca en la inspección, y recargar la página borraba el registro
anterior, justo cuando el usuario quería conservar todo lo observado.
**Decisión:** (1) **Detección de arranque:** al abrir un proyecto se recorren todos los `package.json`
(saltando `node_modules`, build, cachés y enlaces simbólicos) y se puntúan por dependencias,
herramientas y scripts. El frontend se deduce por frameworks y herramientas (React, Vue, Angular,
Svelte, Next, Nuxt, Astro, Vite, etc.) y el backend por frameworks, drivers de base de datos y
utilidades de servidor (Express, Fastify, NestJS, MySQL, Prisma, etc.). Se elige el mejor candidato
que produzca un arranque utilizable, no solo el que puntúe más.
(2) **Comando y puerto:** si el script del backend invoca `node`, `nodemon`, `tsx`, `ts-node` o
`ts-node-dev` con un archivo de entrada, se lanza directamente `node [opciones] archivo` para poder
inyectar `--inspect`; en caso contrario se usa `npm run <script>` sin inspector. El frontend se lanza
con `npm run <script>`. Los puertos salen del propio script (`--port`, `PORT=`), de la configuración
del framework o del archivo de entrada, y como último recurso del puerto por defecto del framework
(Vite 5173, React 3000, Angular 4200, etc.). La evidencia de cada decisión se muestra al usuario.
(3) **Ciclo de vida:** antes de lanzar se comprueba si la URL ya responde; si responde, no se inicia
nada. Un proceso `node` espera al inspector o a la URL; uno `npm` espera a la URL. Ambos reciben
`PORT` y se detienen al desconectar, matando el árbol completo en Windows (`taskkill /T /F`). Si el
frontend y el backend comparten comando y directorio, se lanza una sola vez. Las direcciones siguen
restringidas a bucle local y los comandos se validan dentro de la raíz real del proyecto.
(4) **Sin límites de captura:** se eliminan los topes de archivos y bytes del índice de rutas, los
topes de cuerpos/objetos/ítems del análisis de procedencia JSON, el rechazo por tamaño bruto del
cuerpo, los topes de sitios SQL por manejador, los topes de «recientes» del inspector de Node y los
topes de consultas por tarjeta. Se conserva el presupuesto de 16 000 caracteres del cuerpo
enmascarado en memoria (ADR-031) y los topes de presentación (profundidad y número de resultados),
que acotan la interfaz sin descartar peticiones.
(5) **Registro acumulativo:** recargar la página solo recarga la vista; no vacía peticiones, actividad
ni SQL. «Limpiar» sigue siendo la única acción explícita que borra el registro.
**Consecuencia:** con solo abrir la carpeta del proyecto la app rellena script, directorio y puerto de
frontend y backend, arranca lo que falte y lo detiene al desconectar, sin exigir configuración manual.
La detección es heurística: si el proyecto usa un arranque no reconocido, puertos definidos solo en
`.env` (nunca leídos) o variables de entorno externas, el usuario puede corregir los campos antes de
conectar. Quitar los topes aumenta el trabajo por hover y por recarga, pero elimina los huecos donde
antes «no aparecía nada»; la interfaz sigue acotada por presupuestos de presentación.

## ADR-037 — Hover sin límites de movimientos ni de ancestros

**Contexto:** el selector por hover solo resolvía hasta 12 ancestros (`MAX_ANCESTORS`), aplicaba un
throttle de 60 ms a `mousemove` y recortaba filas, valores, líneas de código, peticiones estáticas y
listeners del tooltip. Con árboles de componentes profundos el manejador quedaba fuera de la cadena
inspeccionada y el elemento bajo el cursor no mostraba nada; al mover el mouse rápido se perdían
movimientos y, al soltar sobre un botón pequeño, el resultado podía no aparecer. El usuario pidió
explícitamente que se vean todos los movimientos y todos los ancestros, sin topes.
**Decisión:** (1) **Cadena completa:** `ANCESTORS_FUNCTION` recorre todos los ancestros, incluidos los
hosts de shadow DOM, hasta la raíz, con un `Set` que evita ciclos. `nodesAt` ya no recorta la lista.
(2) **Todos los movimientos:** el script de página emite una señal de hover en cada `mousemove`, sin
ventana de 60 ms, sin deduplicación por elemento y sin timers pendientes.
(3) **Sin recortes de presentación:** el tooltip muestra todas las filas, todos los valores, todas las
líneas de código, todas las peticiones estáticas detectadas, todos los frames de iniciador, todos los
listeners y todos los atributos/componentes recibidos. El tooltip es desplazable para poder ver el
contenido completo.
(4) **Coalescencia sin pérdida del reposo:** el proceso principal recibe cada señal y resuelve una a la
vez; si llegan más mientras se resuelve, conserva la última pendiente en lugar de encolar cientos de
resoluciones obsoletas. Así el elemento donde el cursor se detiene siempre se resuelve y se muestra.
Las resoluciones en vuelo se invalidan al cerrar el hover, cambiar de modo o recargar.
(5) **Liberación de objetos CDP:** cada resolución usa un `objectGroup` propio y lo libera al terminar;
los `handler.objectId` de `DOMDebugger.getEventListeners` se liberan tras leerlos. Sin esto, la cadena
completa por cada movimiento acumularía handles remotos en sesiones largas.
**Consecuencia:** el hover refleja cualquier elemento, a cualquier profundidad, y ningún dato se
recorta por un tope fijo. El coste por movimiento es mayor: cada señal hace lectura de nodo, estilos y,
en modos distintos de HTML/CSS, listeners y búsqueda de manejador. La coalescencia acota el trabajo a
una resolución activa más la última pendiente. Los cuerpos de red siguen con el presupuesto enmascarado
de ADR-031; el hover no guarda cuerpos ni añade entradas al registro.

## ADR-038 — Selección exacta del elemento bajo el puntero

**Contexto:** el hover resolvía el nodo bajo el cursor con `DOM.getNodeForLocation`, enviando
`event.clientX/clientY` (coordenadas de viewport). El código de Blink (`InspectorDOMAgent::
getNodeForLocation`) interpreta x/y como coordenadas de **documento**: las multiplica por el factor
de zoom y las convierte a coordenadas de frame restándoles el desplazamiento del documento
(`DocumentToFrame`). Con la página desplazada, el nodo resuelto quedaba por encima del puntero: los
textos solo se acertaban en el borde superior, los contenedores no se detectaban y a veces se
seleccionaba un elemento lejano. Los clics usaban el mismo mecanismo y arrastraban el mismo error.
**Decisión:** (1) **Referencia directa en la página:** el script de página guarda el elemento
exacto bajo el cursor en `globalThis.__bdtHoverTarget` (y `__bdtClickTarget` al hacer clic o enviar
un formulario) y lo emite en la señal. La resolución pide esa referencia con `Runtime.evaluate` en
el contexto aislado que emitió la señal (el `executionContextId` de `Runtime.bindingCalled`) y
ejecuta la cadena de ancestros sobre ese `objectId`; las coordenadas dejan de intervenir en el caso
normal.
(2) **Hijos y shadow DOM:** el objetivo es el `event.target` del evento real, no una consulta por
coordenadas; además se desciende por shadow roots abiertos con `shadowRoot.elementFromPoint` en las
mismas coordenadas del evento. Así el elemento resuelto es el más profundo que hay bajo el puntero.
(3) **Respaldo por documento:** si la referencia no está disponible (contexto destruido, señal
antigua), se usa `DOM.getNodeForLocation` con `pageX/pageY` —coordenadas de documento—, que es el
espacio que espera el protocolo.
(4) **Clics y formularios:** usan la misma referencia directa, de modo que la función del manejador
se busca en la cadena real del elemento pulsado.
**Consecuencia:** el hover y el clic seleccionan siempre el elemento que se ve bajo el puntero,
también con la página desplazada, con zoom o dentro de shadow DOM abierto. La selección ya no
depende del espacio de coordenadas ni del rectángulo dibujado. El script de página conserva una
referencia al último elemento señalado hasta el siguiente movimiento o el fin del hover; es una
referencia en la página inspeccionada, no un dato enviado ni almacenado por la app.

## ADR-039 — Mapa de flujo global de la sesión

**Contexto:** la inspección mostraba una tarjeta por clic y la reemplazaba con el siguiente; no había
historial de clics, modelo de grafo ni forma de ver de conjunto la cadena elemento → frontend →
petición → ruta → función → SQL → tabla/BD. El registro y el buffer conservan todo el tráfico, y el
índice estático todas las rutas, pero el panel acoplado solo recibía la tarjeta actual. El usuario
pidió «un diagrama de flujo de todo».
**Decisión:** (1) **Vista Mapa en el panel acoplado:** se abre con un botón «Mapa» en la cabecera,
ocupa el ancho completo del host, oculta la página y, al volver, restaura el split de 300–430 px. No
es un sexto modo de inspección y no cambia el hover ni los cinco modos. (2) **Historial de trazas:**
`FlowLedger` guarda una proyección mínima e ilimitada de cada tarjeta (elemento, manejador, peticiones
`after-click`, ruta, SQL y ejecución), sin código ni cuerpos. Se actualiza en `updatePanel` y se vacía
con «Limpiar», al desconectar y al cerrar. (3) **Snapshot agregado:** `buildFlowSnapshot` combina todas
las trazas, todo el tráfico backend o que casa con una ruta, todas las rutas estáticas y las bases de
datos detectadas; agrupa por IDs deterministas, fusiona evidencia STATIC/RUNTIME y ocurrencias, y se
reconstruye con un throttle de 1 s solo mientras el mapa está abierto. (4) **Evidencia honesta:** las
aristas afirman solo lo que el código puede probar: TRIGGERS, SENDS, MATCHES, HANDLES, QUERIES,
READS/WRITES y USES. No hay aristas petición→SQL ni petición→función: la asociación de SQL y de la
ejecución N2 es por ruta y ventana de 3 s. Las aristas sólidas son directas o exactas; las discontinuas
son heurísticas. La base de datos se infiere del código o del dialecto SQL y no se verifica.
(5) **Sin recortes en los datos:** el ledger y el snapshot conservan todos los clics, peticiones y rutas;
los filtros de búsqueda, de evento y de alcance solo atenúan. Las peticiones externas y preflight se
excluyen del dibujo pero se cuentan en el pie. (6) **UI propia:** SVG generado con `createElementNS` y
`textContent`, layout por capas con orden por baricentro, pan/zoom y ajuste; sin librerías nuevas ni
`innerHTML`. (7) **Cadena de tecnologías:** el snapshot incluye `stack` con el frontend detectado en la
página (React, Vue, Angular, Svelte, Astro, Solid, Remix, Next.js o Nuxt), el backend de las rutas
indexadas (Express, Fastify, FastAPI o Flask) y el motor de base de datos inferido de las pistas y
dialectos SQL. El mapa
muestra una tira fija HTML → frontend → backend → base de datos con flechas que solo se encienden con
evidencia RUNTIME, y las capas del SVG repiten la tecnología detectada. Si falta el backend, la tira
distingue entre «sin proyecto abierto» y «sin rutas indexadas». (8) **Inventario de página:** al
abrir el mapa, un script de solo lectura en el mundo principal enumera todos los controles
interactivos del documento y de las shadow roots abiertas —botones, enlaces, campos, formularios,
`details`/`summary`, `contenteditable` y el documento— con selector, `href` y `action` sin query ni
hash, formulario al que pertenecen, estado y manejadores declarados. Cada control es un nodo STATIC;
sus destinos declarados (`href`, `action`/`formaction`) se dibujan como NAVIGATES/SUBMITS
heurísticos aunque no haya tráfico, y sus manejadores declarados como TRIGGERS STATIC. (9) **Todas
las interacciones:** el inspector registra clic, doble clic, menú contextual, envío, entrada,
cambio, foco, pérdida de foco, teclas de control, hover y scroll sobre el control más cercano, y los
cambios del DOM para refrescar el inventario. `InteractionLedger` agrega por control y evento sin
límites; entrada y scroll se funden en ventanas de 200/500 ms y el hover nunca correlaciona
peticiones. Las peticiones se asocian en el constructor al evento más prioritario ocurrido hasta 3 s
antes o 500 ms después, y la nota de la arista lo declara heurístico. El mapa muestra el conteo de
eventos por nodo, un rail de interacciones de la sesión y un filtro por evento que solo atenúa la
vista. No se capturan valores de campos ni teclas pulsadas. (10) **Listas acotadas y búsqueda con
enfoque:** cada apartado de lista del mapa —rail de interacciones, resultados del buscador y listas
del detalle— renderiza como máximo 20 elementos y carga el siguiente bloque al llegar al final del
scroll, sin descartar datos del snapshot. La búsqueda muestra resultados clicables; al pulsar un
control se enfoca su subgrafo alcanzable (destinos declarados STATIC y tráfico observado RUNTIME),
se ajusta la vista y el detalle enumera las rutas y peticiones alcanzables. El mapa tiene dos modos:
«Todo el tráfico» y «Solo lo que interactuaste», que muestra solo el subgrafo alcanzable desde nodos
con evidencia RUNTIME —el resto desaparece y el subgrafo se vuelve a apilar y ajustar—. El enfoque por
búsqueda prevalece sobre el modo, restablece el filtro de evento y se quita con «Quitar enfoque» o con
un clic en el vacío.
**Consecuencia:** el mapa responde qué elemento dispara qué petición, qué ruta y función la atienden,
y qué SQL y tablas toca, incluidas rutas sin tráfico. Con muchas rutas el primer build analiza el SQL
de todo el índice y el SVG completo puede degradar; el throttle, el zoom y los filtros lo acotan sin
descartar datos. El historial es de sesión y no persiste. La vista no prueba causalidad entre
petición, función y SQL, ni la base de datos real; el detalle y la leyenda lo dicen. La detección del
frontend ejecuta un script de solo lectura en el mundo principal de la página, con tiempo límite de
1,5 s y caché por URL; no modifica el DOM ni envía datos. La cadena muestra tecnologías detectadas,
no una topología completa de módulos ni de conexiones. El mapa ya no depende de que el usuario haga
clic: todos los controles aparecen aunque no se hayan usado, y todas las interacciones de la sesión
se agregan sin recortes, incluidas las que no generan tráfico. El inventario se refresca con un
throttle de 800 ms solo mientras el mapa está abierto y se descarta al navegar; un control eliminado
del DOM puede sobrevivir como nodo RUNTIME de la sesión. El inventario no desciende a iframes ni a
shadow roots cerradas. El filtro por evento atenúa nodos y cadenas sin demostrar que ese evento las
causara. El enfoque por búsqueda dibuja todas las rutas alcanzables desde el control —incluidas las
declaradas sin tráfico—, pero no prueba que se ejecuten hasta que se interactúa con él. Las listas
del mapa renderizan 20 filas por bloque y cargan más al desplazarse; el resto de datos permanece en
el snapshot y los filtros no lo descartan.

## ADR-040 — Procedencia de valores formateados y enfoque compacto del mapa

**Contexto:** la procedencia de ADR-034/035 encontraba el texto si el JSON contenía exactamente lo
visible, pero los precios y otros importes se renderizan en el cliente con moneda, separadores y
decimales (`RD$ 1,500.00`, `1.500,00 €`). El cuerpo capturado solo contiene el número crudo
(`sale_price: 1500`), de modo que el hover no podía decir de qué campo, petición y ruta salía el
precio. Por separado, al pulsar un nodo del mapa los nodos ajenos solo se atenuaban y conservaban sus
posiciones: la cadena enfocada quedaba dispersa entre nodos lejanos.
**Decisión:** (1) **Coincidencia numérica con pistas de campo:** `findJsonTextMatches` acepta las
rutas de los valores crudos que recibe el componente React/Vue (`props.filteredProducts[3].sale_price`)
como pistas. Extrae la clave hoja, normaliza mayúsculas y separadores (`sale_price` = `salePrice`) y,
si el texto visible contiene una moneda Unicode o un número con separadores, busca en respuestas y
cuerpos enviados los valores numéricos o cadenas numéricas equivalentes al número formateado. La
puntuación prioriza la clave hoja, luego la respuesta sobre el cuerpo enviado y la petición más
reciente; las coincidencias numéricas se fusionan con las de datos del componente y se deduplican por
petición, origen y ruta JSON. El tooltip de Frontend y JSON muestra el dato React/Vue que transporta
el número, la ruta del backend, las tablas SQL leídas/escritas y la base de datos inferida; todo valor
cuya representación difiere del JSON se rotula `(aprox.)` y el pie explica que la coincidencia es por
valor. (2) **Enfoque compacto del mapa:** al pulsar un nodo, el alcance visible es la unión de sus
ancestros y descendientes alcanzables. Se construye un snapshot parcial solo con esos nodos y las
aristas cuyos dos extremos pertenecen al alcance, se ejecuta `layoutFlow` de nuevo y se dibuja y ajusta
ese subgrafo; los nodos ajenos desaparecen en lugar de atenuarse y el espacio se recompone por capas.
El detalle, el rail y el snapshot completo conservan todos los datos. «Quitar enfoque», el clic en el
vacío y el cambio de modo restauran el layout completo. Los resultados del buscador conservan su
semántica de rutas alcanzables hacia delante; el resto de clics usa ancestros y descendientes.
**Consecuencia:** un precio formateado se puede rastrear hasta su campo numérico, su petición, la
función del backend, las tablas SQL y la base de datos sin coincidencia literal en el JSON. La
coincidencia sigue siendo aproximada: varios registros pueden compartir el mismo importe y la tarjeta
enumera las alternativas en lugar de elegir una sola fuente como verdad. El mapa muestra una cadena
compacta al enfocar, pero esa cadena no prueba causalidad ni ejecución: conserva las etiquetas
STATIC/RUNTIME de cada nodo y arista. Recalcular el layout por clic es lineal respecto al subgrafo y
no descarta datos del snapshot.

## ADR-041 — Trazado en ejecución: identidad de respuesta, render y pila de la petición

**Contexto:** ADR-040 resolvía precios formateados comparando el número visible con los cuerpos
capturados y usando la ruta de la prop como pista, pero seguía siendo una coincidencia por valor: no
decía qué función React devolvía el texto al HTML ni qué subfunción ejecutaba la petición, y dos
campos con el mismo importe quedaban empatados. La herramienta es de uso general: el mecanismo no
puede depender de nombres de campos ni de una aplicación concreta.
**Decisión:** (1) **Hooks de red en el mundo principal:** `RUNTIME_NETWORK_SOURCE` parchea `fetch`,
`Response.json/text/clone`, `XMLHttpRequest` y `JSON.parse`; cada cuerpo parseado se etiqueta en un
`WeakMap` con la petición que lo entregó (método, ruta, host, estado, hora) y su ruta JSON. Los hooks
se instalan con `Page.addScriptToEvaluateOnNewDocument` y se evalúan de inmediato antes de que la app
cargue. (2) **Identidad del componente:** `RUNTIME_PROVENANCE_CALL` recorre los fibers React
(`__reactFiber$`, props y hooks) o la cadena Vue (`__vueParentComponent`) desde el nodo bajo el mouse;
los objetos etiquetados que aparecen en props o estado son las respuestas reales que alimentaron ese
texto. Las claves de fila (fiber key, `id`/`data-*`, segmentos de `href`, parámetros `id`) seleccionan
el registro exacto; sin ellas la tarjeta enumera las alternativas. (3) **Campo y petición:** el texto
visible se compara con los valores del objeto (texto exacto, número y variantes con separadores) y cada
campo encontrado conserva su ruta en el componente, su ruta JSON y la petición asociada. El vínculo es
por identidad y parseo, no por coincidencia global en el búfer. (4) **Función de render:** cada fiber
aporta el sitio JSX que lo creó. React 18 expone `_debugSource` (archivo, línea y columna 1-based);
React 19.0 no expone ni `_debugSource` ni `_debugStack`; React 19.1 añadió `fiber._debugStack`, el
`Error` que `jsxDEV` crea en cada llamada JSX, cuyo segundo marco es la función del usuario que invocó
`jsxDEV`, es decir, la función que devolvió ese texto al árbol. Ese marco apunta al módulo transformado
que sirve el bundler, no al fuente, así que el inspector lee el módulo con `Debugger.getScriptSource` y
decodifica su source map inline (`sourceMappingURL` en `data:`), incluyendo VLQ y `sourcesContent`,
para obtener archivo, línea, columna y texto originales. El mapeo se hace en el proceso principal, sin
peticiones ni dependencias extra. La expresión JSX del nodo bajo el mouse pesa más que el cuerpo del
componente al elegir el campo: la clave hoja que aparece en esa línea (`sale_price` ≡ `salePrice`) gana
sobre otro campo con el mismo número (`average_cost`). También se leen las líneas de los fibers
ancestros para resolver el caso en que el valor se formatea en un componente hijo. Cuando no hay
archivo ni línea (producción minificada, source map externo, React 19.0), se busca la definición del
componente en el workspace (`WorkspaceSymbols`) y se muestra como **Definición**, nunca como línea
ejecutada. (5) **Pila de la petición:** al ejecutarse `fetch` o XHR se captura `new Error().stack` completa, con
`Error.stackTraceLimit` elevado y sin recorte; los marcos http(s) se asocian a la respuesta etiquetada y
se muestran como la subfunción que llamó al backend. (6) **Cadena:** el tooltip ordena Render → Código →
Dato → Respuesta → Pila → Petición → Ruta → SQL → Base de datos. Si el cuerpo se sirvió antes de
instalar los hooks, queda la coincidencia por valor de ADR-040 rotulada como respaldo. (7) **Mapa:**
cada hover en un modo distinto de HTML registra en un ledger propio la cadena que mostró el tooltip:
elemento, petición capturada (si existe), ruta resuelta (aunque no haya respuesta capturada), campo,
componente, archivo y línea. El grafo la proyecta como arista `PROVENANCE` del elemento a su petición
(RUNTIME, directa si el vínculo es por identidad, heurística si es por contenido del JSON) o, cuando no
hay petición capturada, del elemento a la ruta ejecutada (STATIC + RUNTIME, directa), más `RENDERS` del
componente que lo renderizó al elemento. La conexión usa la evidencia del hover, no la ventana de 3 s de
un clic, de modo que la misma cadena del tooltip (componente → dato → petición → ruta → SQL → BD) se
dibuja en el mapa para datos que llegaron al cargar la página.
**Consecuencia:** un texto formateado se explica por lo que se ejecutó: un objeto parseado de una
respuesta concreta dentro del componente que lo renderiza, la función y la línea JSX que lo pintan y la
pila que originó la petición. No depende de nombres de campo ni de una app concreta. La línea original
requiere un build de desarrollo que sirva source maps inline (Vite lo hace por defecto) y `sourcesContent`
para mostrar el texto exacto; si el workspace contiene otra copia del proyecto, el texto servido manda y
la copia no se presenta como si fuera la que se ejecuta. Cuando el mapeo no es posible, la identidad y la
petición siguen verificadas y la definición del componente se rotula como tal. La ruta, el SQL y la base
de datos se derivan del índice estático de la petición ejecutada: son evidencia estática de esa ruta, no
SQL observado salvo captura N2 o de driver. Si varios registros comparten valores y no hay clave de fila,
expresión identificable ni source map, la tarjeta enumera alternativas y lo advierte. Los hooks viven
solo en memoria y no capturan valores de inputs ni cabeceras sensibles. En el mapa, la arista de
procedencia se dibuja con la misma evidencia que el tooltip: identidad en ejecución, coincidencia de
contenido o ruta ejecutada sin respuesta capturada, cada una rotulada con su correlación (directa o
heurística); nunca una procedencia inventada.

## ADR-042 — Resolución automática de controles y contención DOM en el mapa

**Contexto:** ADR-041 conectaba en el mapa la cadena que mostraba el tooltip, pero solo después de un
hover sobre el elemento. Los controles que aparecían por una interacción de contenedor —`<html>`,
`<header>` y similares— quedaban como tarjetas sin flechas, y el resto del inventario solo mostraba sus
destinos declarados. El usuario pidió que el diagrama completo se vea sin depender de que ocurra un
evento.
**Decisión:** (1) **Barrido sin interacción:** al abrir el mapa, el controlador programa una resolución
secuencial en segundo plano (600 ms después del primer build, sin bloquear la UI) sobre todos los
controles del inventario y todas las referencias de interacción, incluidos los contenedores; omite el
documento. `ClickInspector.resolveRef(ref, true)` reconstruye el nodo desde su selector y su clave de
página en el mundo aislado, lo re-resuelve en el mundo principal para que las props de React/Vue sean
visibles y reutiliza el mismo `elementInfo`, `runtimeProvenance` y `findHandler` del hover. El barrido se
cancela al cerrar el mapa, navegar, limpiar la sesión o desactivar la inspección; los controles ya
resueltos se recuerdan por clave para no repetir el trabajo. (2) **Manejadores sin evento:** un nuevo
`RuntimeHandlerLedger` guarda el manejador click/submit resuelto en el DOM, con su fuente, archivo y
línea. El grafo lo proyecta como nodo `handler` y arista `TRIGGERS` RUNTIME directa desde el elemento; el
manejador declarado STATIC equivalente se omite cuando ya hay resolución en ejecución. (3) **Cadena de
procedencia sin evento:** el barrido registra en el ledger de procedencia la misma cadena del tooltip
—identidad en ejecución, coincidencia de contenido o ruta ejecutada— de modo que `PROVENANCE` y
`RENDERS` se dibujan para datos que llegaron antes de abrir el mapa. (4) **Manejador → petición por
nombre:** si una petición capturada registra como función iniciadora el mismo nombre del manejador
resuelto, se dibuja `SENDS` RUNTIME heurística; nunca sobrescribe una arista ya existente y la nota
declara que la asociación es por nombre y sin evento registrado. (5) **Contención DOM:** los nodos de
elemento que siguen sin ninguna arista se enlazan con `CONTAINS` al nodo de elemento conectado más
cercano —el ancestro de selector más largo o, si no lo hay, el descendiente de selector más corto;
`document` contiene a todos—. La arista es RUNTIME directa, recorre los aislados en orden de inserción
para encadenar contenedores y su nota dice «Contención en el DOM; no implica flujo de datos». (6) **Modo
«Solo lo que interactuaste»:** el alcance se siembra solo con elementos que tienen eventos o trazas,
manejadores con trazas y el resto de nodos RUNTIME (peticiones, rutas ejecutadas, SQL observado). Los
elementos resueltos únicamente por el barrido no cuentan como interactuados y no siembran el subgrafo,
aunque sí pueden aparecer como alcanzables desde un control usado.
**Consecuencia:** el mapa dibuja la cadena de cada control sin exigir hover ni clic, incluidos los
contenedores que antes quedaban sueltos, y mantiene las etiquetas de evidencia y correlación del resto
del grafo. El barrido consume CPU y CDP en proporción al número de controles y a los cuerpos capturados:
en páginas grandes el dibujo se completa progresivamente y las listas siguen acotadas a 20 filas por
bloque. La contención es jerarquía del documento, no flujo de datos, y puede dibujar curvas largas entre
capas. El vínculo por nombre de función iniciadora es heurístico y puede reunir peticiones de la misma
función ejecutadas en momentos distintos. El barrido no modifica la página ni captura valores de campos.

## ADR-043 — Mapa en ventana propia, resaltado en página, cronología, recorte por visor y troncos

**Contexto:** ADR-039 abrió el mapa dentro del panel acoplado, ocultando la página; al crecer el grafo,
el SVG completo se montaba de una vez y las aristas convergentes se dibujaban una por origen. El usuario
pidió (1) el mapa fuera de la ventana por defecto, (2) que al pulsar un nodo se resalte el elemento de la
página como el hover, (3) orden cronológico con hora, minutos y segundos, (4) no renderizar lo que no está
a la vista y (5) unir las líneas que van al mismo destino en un solo tronco para no sobrecargar la CPU.
**Decisión:** (1) **Ventana propia:** `FlowMapWindow` crea un `BrowserWindow` separado con partición,
preload y sesión endurecida propios, y carga solo el marcado del mapa. El controlador sigue siendo la
única fuente de verdad: empuja el mismo `FlowMapState` a esa ventana y el panel conserva la tarjeta de
inspección. «Mapa» en la cabecera y en la fila de modos abre la ventana; «Cerrar mapa», la X o `Escape`
la cierran. Cerrar la ventana, desactivar la inspección, desconectar o limpiar la sesión detiene el
refresco del inventario y la resolución automática. (2) **Resaltado en página:** al elegir un nodo, el
mapa envía por IPC `{ key, selector }`; el proceso principal valida que venga de la ventana del mapa y lo
evalúa en el mundo aislado del inspector con `__bdtMapHighlight`. El helper reutiliza el recuadro del
hover (`bdt-hover-box`), resuelve la referencia por clave y selector y, si el nodo no es un elemento,
sube por las aristas entrantes hasta el elemento con selector más cercano. Centra el elemento con
`scrollIntoView` y lo ilumina con dos pulsos de 2,6 s. No modifica el DOM ni captura valores.
(3) **Cronología:** `layoutFlow` ordena los nodos de cada capa por `firstSeen`; los nodos sin hora
conocida (STATIC) van al final. Cada tarjeta muestra `HH:MM:SS` de primera aparición y el subtítulo se
acorta para dejar sitio. Tooltips, rail de interacciones, rutas y peticiones del detalle usan el mismo
reloj local y orden ascendente; el hover estampa `Visto` o el rango `Visto: inicio → fin`.
(4) **Recorte por visor:** el SVG se divide en tres capas (ramas, troncos, nodos). En cada frame de
pan/zoom/resize se calculan los límites del mundo visible a partir de la transformación y se añade un
margen de 280 px de pantalla convertido a unidades del mundo; solo se montan los nodos y aristas que
intersectan esos límites y se desmontan los que salen. Los `Map` de vistas montadas hacen O(1) el alta y
la baja; un `requestAnimationFrame` agrupa los cambios y un `ResizeObserver` cubre el redimensionado de
la ventana. Los filtros y la selección se guardan en caché y se reaplican al montar, de modo que ocultar
o atenuar no recalcula el grafo. (5) **Troncos convergentes:** las aristas que avanzan hacia la derecha
se agrupan por destino. Si un destino recibe varias fuentes, cada fuente dibuja una rama sin punta hasta
un punto de unión situado 44 px a la izquierda del destino, a la altura media de las fuentes; desde ese
punto sale una sola flecha con punta hacia el destino. Las aristas hacia atrás o dentro de la misma capa
se dibujan por separado. Las ramas conservan su tooltip por arista y el tronco declara cuántos orígenes y
conexiones agrupa, con evidencia fusionada y hora del último avistamiento.
**Consecuencia:** la página y el mapa pueden verse a la vez; pulsar un nodo señala el control real sin
cerrar el mapa. El orden y las horas hacen legible la secuencia de la sesión, y el recorte mantiene
acotado el DOM aunque el snapshot crezca: solo se paga por lo visible más el margen. El tronco reduce
drásticamente el número de trazos cuando muchas fuentes apuntan a la misma ruta o tabla. El recorte no
descarta datos: nodos y aristas reaparecen al desplazar, alejar o redimensionar. El resaltado depende de
que el elemento siga en la página y de que la inspección esté activa; si el selector ya no resuelve, no
se resalta nada. La unión de líneas es una simplificación visual: comparte destino, no demuestra
causalidad, y las etiquetas STATIC/RUNTIME y directa/heurística se conservan. El mapa ya no ocupa el
panel; el botón «Mapa» abre una ventana que puede quedar detrás o delante de la del navegador según el
gestor de ventanas.
