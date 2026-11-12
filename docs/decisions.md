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

**Revisión:** la detección de drivers y el mecanismo de carga del punto (2) quedaron sustituidos por
ADR-058 —registro de adaptadores, escaneo del caché de módulos y `process.getBuiltinModule`—, que
además amplía los drivers, conserva los últimos 2000 eventos y ya no depende del esquema `require`
del punto de entrada. El propósito y los límites de evidencia N2 siguen vigentes; el registro
cronológico sigue mostrando solo texto SQL, y las muestras de filas que añadieron ADR-055/ADR-057 son
exclusivas del mapa y de la ventana «Datos».

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

## ADR-044 — Tooltip del mapa bajo demanda, dirección por color y foco por menú contextual

**Contexto:** el mapa usaba `<title>` nativo en cada nodo y arista: aparecía siempre, sin estilo y con
retardo del sistema, y no se podía desactivar. Además todas las aristas compartían la misma geometría y
solo cambiaban de color por evidencia STATIC/RUNTIME, así que no se distinguía un envío de una respuesta,
un gateway HTTP o una llamada al servidor. El clic izquierdo sobre un nodo enfocaba de inmediato toda su
cadena, ocultaba el resto, re-apilaba y ajustaba la vista, de modo que explorar dos nodos encadenaba
re-layouts completos y no dejaba ver solo las conexiones del nodo elegido.
**Decisión:** (1) **Tooltip bajo demanda:** se eliminan los `<title>` nativos y se dibuja un tooltip HTML
propio en `#map-tip`, con el mismo texto enriquecido del nodo o de la arista. Está apagado por defecto;
el botón «Tooltip» lo fija y, mientras no esté fijo, mantener Shift lo muestra solo mientras la tecla
sigue pulsada. El botón indica el estado con `aria-pressed` y una tecla `Shift` al lado; el tooltip se
oculta al cerrar la ventana, al re-renderizar, al salir del SVG o al desactivarlo. Las aristas añaden una
ruta invisible de 12 px para que el hover no dependa del grosor del trazo. (2) **Dirección por color y
geometría:** cada arista recibe una clase de flujo `send`, `receive`, `gateway`, `server` o `neutral`.
Envío (azul) sale por la derecha; recibo (verde) sale por la izquierda y entra al nodo anterior por su
lado derecho, invirtiendo los extremos cuando la arista original avanza de izquierda a derecha
(`PROVENANCE`); gateway (ámbar) es toda arista que entra en un nodo `request`; servidor (violeta) cubre
ruta, función, SQL, tabla y motor; estructura (gris) son `CONTAINS` y las aristas entre elementos, sin
punta porque describen jerarquía. Las aristas de una sola dirección llevan `↑` o `↓` en el margen; las
de ida y vuelta llevan punta en ambos extremos y no llevan glifo. La ida y vuelta no se inventa: gateway
la muestra solo si la petición tiene `outcome` o `statusCode`; servidor, solo si la arista tiene evidencia
RUNTIME y el nodo de origen está en el cierre directo de alguna petición con respuesta capturada. Las
conexiones pendientes o sin respuesta quedan unidireccionales, las heurísticas siguen discontinuas y las
solo estáticas se atenúan. Los troncos se agrupan por destino y clase de flujo, de modo que no se mezclan
colores, y cada rama conserva su propia condición de ida y vuelta. (3) **Selección frente a foco:** el
clic izquierdo marca el nodo, muestra su detalle, lo resalta en la página y ilumina toda su cadena
—ancestros y descendientes alcanzables— atenuando el resto; no oculta, no re-apila y no mueve la cámara.
El clic derecho abre `#map-menu` con «Ver interacciones» —que sí aísla ancestros y descendientes,
recompacta y ajusta—, «Resaltar en la página» y «Quitar selección» —o «Quitar enfoque» cuando hay foco
activo—. El clic en el vacío quita la selección y el enfoque y restaura el grafo completo; «Quitar
enfoque» hace lo mismo desde el menú. El menú se cierra con `Escape`, rueda, clic fuera o pérdida de foco. El
buscador y su acción de enfocar conservan el comportamiento anterior.
**Consecuencia:** el mapa deja de mostrar carteles al pasar el cursor y el detalle aparece solo cuando el
usuario lo pide con el botón o con Shift, sin texto adicional en el trazo. La dirección se lee por color,
por el lado del que sale la línea y por la flecha del margen; las conexiones de ida y vuelta solo se
dibujan cuando hay una respuesta observada, así que una petición pendiente no finge un regreso. El clic
izquierdo permite saltar de un nodo a otro sin re-layouts ni pérdida de contexto, y el foco completo queda
explícito en el menú contextual. El tooltip fijado se reinicia al reabrir el mapa; el menú y el tooltip
no capturan el puntero del SVG, y el foco por menú sigue dependiendo de las aristas del grafo, no de
tráfico demostrado.

## ADR-045 — Tooltip del visor bajo demanda, cadena completa, estado en errores y filtro exclusivo por evento

**Contexto:** el tooltip del visor de la página seguía apareciendo con cada hover, mientras que el del
mapa ya era bajo demanda; el usuario aclaró que el cambio pendiente era el del visor. Además, el clic
izquierdo del mapa iluminaba solo las conexiones directas del nodo, el clic en el vacío borraba el
enfoque logrado desde el menú contextual, las peticiones fallidas perdían su código de estado en el
subtítulo del mapa, en el hover del visor y en la cronología, y el filtro por evento solo atenuaba el
resto del grafo sin ofrecer una vista exclusiva como «Ver interacciones».
**Decisión:** (1) **Tooltip del visor bajo demanda:** el recuadro de procedencia del hover de la página
queda apagado por defecto. La barra del navegador añade un botón «Tooltip» con la tecla `Shift` al lado,
que lo fija y se sincroniza con el estado del controlador mediante un canal de la barra; mientras no
esté fijo, mantener Shift lo muestra solo mientras la tecla sigue pulsada. El script de la página
conserva el último dato de hover y decide su visibilidad con `__BDT_HOVER_TIP_PINNED__` y el estado real
de Shift, sin depender de que el hover se repita: al soltar Shift se oculta y al pulsarlo se muestra el
último dato vigente. La captura de procedencia para el mapa sigue igual; solo cambia la visibilidad.
El tooltip del mapa no se modifica. (2) **Cadena completa:** el clic izquierdo calcula el alcance con
`involvedScope(id, 'both')` —ancestros y descendientes estrictos— y lo usa para iluminar nodos y
aristas, atenuando el resto sin ocultar ni re-apilar. Al pulsar un nodo con el mapa enfocado, el enfoque
se conserva mientras se navega con clic izquierdo. (3) **Salida del enfoque:** el clic en el vacío
llama a `clearSelection()`: quita nodo, detalle, resaltado de página y `focusScope`, y restaura el
alcance general —o el subgrafo del evento si «Solo esos» está marcado— re-apilando y ajustando la vista;
«Quitar enfoque» del menú contextual y el botón del estado producen la misma salida. (4) **Estado en errores:** el
subtítulo de la petición en el mapa, el estado observado del hover y la cronología priorizan
`statusCode` cuando existe; `failed` sin código se muestra como `ERR` y `error`, y `pending` como `…`.
(5) **Filtro exclusivo por evento:** el selector de eventos conserva su comportamiento por defecto —solo
ilumina los nodos alcanzables desde el evento elegido— y añade la casilla «Solo esos». Marcada, el
alcance del mapa se intersecta con el subgrafo del evento, los nodos ajenos se ocultan y el subgrafo
restante se re-apila y ajusta, como «Ver interacciones». Se desactiva el foco al activarla, se limpia la
selección si el nodo elegido queda fuera y, al desmarcarla o quitar el evento, se restaura el alcance
anterior.
**Consecuencia:** el visor deja de tapar la página con carteles al pasar el cursor; el botón y Shift
ofrecen el detalle cuando se necesita, y el estado del botón refleja el del controlador. El clic
izquierdo muestra de una vez toda la cadena del nodo, que es la ruta completa hasta base de datos y no
solo el tramo inmediato. El clic en el vacío sale del enfoque y devuelve el grafo general, y «Quitar
enfoque» ofrece la misma salida desde el menú y el estado. Las respuestas con error conservan su código
en las tres vistas. La casilla
«Solo esos» es una vista más del grafo: no altera la captura ni los datos, y desmarcarla restaura el
alcance previo. El tooltip fijado del visor persiste entre navegaciones hasta apagarlo, y el estado de
Shift se lee del teclado de la página, por lo que soltarlo fuera de la ventana puede dejar el tooltip
visible hasta el siguiente evento de teclado o de puntero.

## ADR-046 — Estado de ciclo de vida, buscador por estado, consola, Shift global y contadores

**Contexto:** las peticiones mostraban códigos sueltos, pero no distinguían «enviada y esperando»,
«enviada y el servidor no respondió», «recibida con error» o «recibida correctamente pero el backend no
se capturó»; además el estado no era buscable en el mapa, el panel ni la cronología. No existía una
vista de consola: los `console.log`, advertencias, errores y excepciones de la página y la salida del
backend solo eran visibles abriendo las herramientas del navegador o la terminal. Shift solo se leía del
teclado de la página inspeccionada, así que al enfocar un botón del panel o de la barra el tooltip dejaba
de responder hasta volver a hacer clic en la página. La casilla «Solo esos» se marcaba solo cuando el
modelo terminaba de reconstruirse, lo que en cargas grandes parecía que no funcionaba. El texto del SVG
se podía seleccionar, y los nodos no indicaban cuántas veces se había interactuado con cada elemento,
manejador, ruta o consulta.

**Decisión:** (1) **Modelo de estado:** `packages/core/protocol/src/status.ts` define
`RequestStatusView` a partir de `outcome`, `statusCode`, `error` y `backendObserved`. Ocho clases
—informativa, correcta, redirección, error del cliente, error del servidor, sin respuesta, pendiente y
sin estado—, con tono, código (`200`, `ERR`, `···`, `—`), frase de razón en español, etiqueta y fase.
La fase distingue el punto del ciclo: «Enviada · esperando respuesta del servidor», «Enviada · el
servidor no respondió», «Enviada · sin estado reportado», «Recibida · respuesta provisional», «Recibida
· ejecución del backend capturada» o «Recibida · ejecución del backend no capturada», entre otras. El
mismo modelo produce un texto normalizado de búsqueda que incluye código, frase, categoría (`4xx`,
`5xx`), clase, fase, `outcome` y evidencia del backend. El mapa lo usa en el subtítulo y en la búsqueda
de nodos; el panel, en el filtro de peticiones y en la tarjeta; la cronología, en la columna de estado y
en su buscador. (2) **Consola:** el protocolo añade `ConsoleEntry` —hora, origen `frontend`/`backend`,
nivel, texto, URL o archivo y línea/columna— y los eventos `console` y `console-cleared`. En la página,
el controlador habilita `Runtime` y `Log` por CDP y escucha `Runtime.consoleAPICalled`,
`Runtime.exceptionThrown` y `Log.entryAdded`; los registros de `Log` con origen `javascript` se omiten
porque las excepciones ya llegan por `Runtime.exceptionThrown`. En los procesos lanzados por la app, la
salida `stdout`/`stderr` se acumula por líneas, se limpia de secuencias ANSI y llama a `onOutput`; cada
línea del backend queda como entrada `backend` y la del frontend lanzado como `frontend`. El renderer
fusiona las entradas por hora y las muestra en la pestaña «Consola» con filtros «Todo», «Frontend» y
«Backend», y con «Solo problemas» para advertencias, errores y excepciones; la pestaña muestra un
contador de problemas y la lista se autodesplaza solo si el usuario está al final. La consola se vacía
al limpiar la sesión y al desconectar. (3) **Shift global:** el proceso principal registra
`before-input-event` en cada `webContents` de la aplicación —ventana principal, barra del navegador,
panel de inspección, vista de la página y ventana del mapa— y mantiene un único estado de Shift; al
cambiar, actualiza `__BDT_SHIFT_HELD__` en el mundo aislado del inspector y envía el estado a la ventana
del mapa por el canal `browser-panel:shift`. `blur` y `destroyed` lo sueltan, y desconectar lo reinicia.
El tooltip del visor ya no depende del foco de la página: responde igual con el foco en el panel o en
los botones HTML/CSS, Frontend o Backend; esto sustituye la lectura de Shift limitada al teclado de la
página descrita en ADR-045. (4) **«Solo esos» inmediata:** el cambio de la casilla y del
selector de evento actualiza el estado visual al instante y programa el recálculo pesado 32 ms después,
de modo que el navegador pinta la marca antes de re-apilar. El filtro de evento se conserva mientras el
modelo se reconstruye y solo se descarta cuando un modelo terminado ya no contiene ese evento. El pie del
mapa muestra un indicador con animación de transformación —«Actualizando mapa…» durante la construcción
y «Aplicando filtro…» durante el recálculo—, sin bloquear la interacción. (5) **Texto no copiable en el
mapa:** el CSS desactiva la selección en `#map-svg` y sus descendientes; el detalle, el rail de
interacciones y las listas laterales la mantienen activa, así que el texto copiable es el del panel. (6)
**Contadores:** cada nodo conserva `occurrences` y una etiqueta según su tipo —elemento: «Interacciones»;
manejador: «Ejecuciones»; ruta: «Peticiones recibidas»; función: «Peticiones manejadas»; consulta:
«Ejecuciones»; tabla y base de datos: «Consultas ejecutadas»—. Las tablas y bases de datos suman las
ejecuciones de las consultas que las leen o escriben. El tooltip, el detalle y las notas muestran el
recuento cuando es mayor que uno.

**Consecuencia:** el estado de una petición se lee igual en el mapa, el panel y la cronología, y se
puede buscar por código (`404`), frase («No encontrado»), categoría (`4xx`), «pendiente», «ERR» o
evidencia del backend. Una respuesta correcta sin ejecución capturada se distingue de una ejecución
observada, y una petición enviada sin respuesta no se confunde con un error HTTP. La consola reúne en
orden cronológico los mensajes de la página y la salida de los procesos, con filtros por origen y una
vista de problemas; las líneas del backend se muestran mientras la app las lanza, y las excepciones no
se duplican. Shift funciona con independencia del foco, aunque al perder el foco de la ventana el estado
se suelta y el tooltip se oculta. La casilla responde al primer clic y el indicador del pie hace visible
el trabajo pendiente. Los recuentos describen actividad observada de la sesión, no llamadas internas que
el runtime no exponga; no alteran el grafo ni la captura, y las etiquetas de evidencia siguen
distinguiendo STATIC de RUNTIME.

## ADR-047 — Enlaces de código al editor y casilla «Solo esos» sin evento elegido

**Contexto:** el panel, el mapa, el registro de actividad, la consola y la cronología mostraban
`archivo:línea` como texto plano. Para revisar la función había que copiar la ruta, buscarla a mano en el
explorador y localizar la línea. Además, la casilla «Solo esos» del mapa solo se habilitaba cuando el
selector tenía un evento elegido: sin evento quedaba deshabilitada y forzada a desmarcarse, así que los
clics no producían ningún cambio y parecía rota.

**Decisión:** (1) **Contrato:** el protocolo añade `CodeLocationRequest` —ruta, línea y `endLine`
opcional— y `CodeLocation` normalizada, con los canales `code:reveal` (renderer → main),
`code:reveal-location` (main → renderer) y `browser-panel:reveal-location` (panel o mapa → main). (2)
**Normalización en main:** `apps/desktop/main/src/code-location.ts` resuelve rutas relativas al proyecto,
convierte URL `http(s)` de `localhost`, `127.0.0.1` o `::1` a su ruta de proyecto y rechaza rutas que
escapan del workspace, archivos inexistentes y orígenes externos. El proceso principal restaura y enfoca
la ventana principal, y solo entonces emite `code:reveal-location`; si la ubicación no se puede resolver,
devuelve `null` y no mueve la ventana. (3) **Editor:** el renderer abre o activa la pestaña del archivo,
cambia a la vista de archivo y pasa al editor un objetivo con `line`, `endLine` y un `nonce` que fuerza el
re-render. Monaco crea una decoración de línea completa para el rango y lo centra con
`revealLinesInCenter`; el rango nunca excede las líneas del modelo. (4) **Enlaces:** el panel convierte en
enlaces la ubicación del manejador, el `archivo:línea` de cada petición, los pasos BACKEND y SQL de la
secuencia, la ejecución, el encabezado de cada bloque de código y cada consulta; el mapa hace lo propio en
la fila «Ubicación», en las rutas alcanzables y en los resultados del buscador —que pasan de `<button>` a
`div` con rol y teclado para poder anidar el enlace—; la ventana principal usa `CodeLink` en el registro,
la consola y los frames de la cronología. El enlace lleva el rango de la función cuando el índice estático
o el bloque de código lo conocen: la ejecución y las SQL toman el rango del manejador cuando la línea cae
dentro de él, y si no, el del bloque de código; las ubicaciones sueltas resaltan solo su línea. (5)
**Casilla «Solo esos»:** deja de deshabilitarse y de desmarcarse sin evento. Al marcarla se limpia el
enfoque y, si no hay evento elegido, se selecciona el primero disponible; si todavía no hay eventos, la
casilla queda marcada y el mapa muestra un aviso, y en cuanto la reconstrucción encuentra eventos el
filtro toma el primero. Al elegir explícitamente «Todos los eventos» en el selector, la casilla se
desmarca. El cambio sigue aplicándose de inmediato y el recálculo pesado se programa como en ADR-046.

**Consecuencia:** cualquier `archivo:línea` resoluble del proyecto es un punto de salto al editor con la
función completa marcada, sin copiar rutas; las ubicaciones externas o inexistentes no abren una pestaña
errónea. El resaltado es una decoración de lectura y no modifica el archivo. La casilla «Solo esos»
responde al primer clic, con o sin evento seleccionado, y no queda silenciosamente desmarcada cuando el
modelo se reconstruye; si aún no hay eventos, el estado queda visible en el aviso del mapa.

## ADR-048 — Orden jerárquico con estructura DOM, CSS y JS

**Contexto:** el mapa solo tenía un orden: columnas por tipo de nodo y filas por hora de primera
aparición. Esa vista responde «qué ocurrió y cuándo», pero no «de qué depende cada cosa». El usuario pidió
un modo jerárquico que reemplace la cronología: si `html` tiene `head` y `body`, un hijo debe abrirse a la
izquierda y el otro a la derecha, y lo mismo debe repetirse con la estructura, los estilos, los controles,
las peticiones, el backend y el SQL. Además, el inventario solo registraba controles; ni los contenedores
del DOM ni las hojas de estilo o los scripts aparecían en el grafo.

**Decisión:** (1) **Protocolo e inventario:** se añaden los tipos de nodo `structure` y `asset` y los
kinds homónimos, más `pageUrl` en cada nodo. El script de inventario captura `html`, `head`, `body` y los
contenedores semánticos (`main`, `nav`, `header`, `footer`, `section`, `article`, `aside`, `div`) que sean
ancestros de un control o recurso; `html`, `head` y `body` se añaden siempre. También captura
`link[rel~=stylesheet]`, `<style>` y `<script>`, con su URL cuando existe. Cada elemento produce un solo
nodo: si una clave ya es control, la estructura no se duplica. El recorrido usa una caché de rutas por
nodo y visita el shadow DOM después del host para que un host interactivo no quede duplicado. (2) **Grafo:**
los nodos estructurales y de recurso se proyectan sin manejadores ni destinos declarados. La contención
DOM se calcula para todos los elementos, estructuras y recursos de una misma `pageUrl`: cada nodo elige
como padre al ancestro más cercano cuyo selector es un prefijo exacto del suyo, con el documento como
último recurso; los recursos nunca son padres. La arista `CONTAINS` lleva evidencia RUNTIME si el nodo fue
observado en ejecución y STATIC si solo proviene del inventario, y su nota aclara que describe jerarquía,
no flujo de datos. (3) **Layout:** `layoutFlow(snapshot, mode)` acepta `chronological` o `hierarchical`.
El modo jerárquico elige un único padre por nodo según la prioridad de la arista —`CONTAINS` 100,
`TRIGGERS` 95, `SENDS` 90, `MATCHES` 85, `HANDLES` 80, `QUERIES` 75, `READS`/`WRITES` 70, `USES` 65,
`SUBMITS`/`NAVIGATES` 60, `RENDERS` 55, `PROVENANCE` 50—, penaliza lo más reciente y evita ciclos; después
construye un árbol ordenado por tipo y por orden del DOM, reparte los subárboles de cada padre de
izquierda a derecha y apila los niveles de arriba abajo. Los nodos sin padre quedan como raíces y el
documento se coloca primero. El modo no usa la hora para posicionar, solo para desempatar. (4) **Mapa:**
la barra añade el grupo «Cronológico»/«Jerárquico»; el modo se conserva al cambiar de alcance, filtro,
búsqueda o enfoque, y se re-aplica al layout visible. En jerárquico cada arista se dibuja individualmente,
sin troncos agrupados: vertical si cambia de nivel y horizontal si conecta nodos del mismo nivel. Las
etiquetas de capa pasan a `NIVEL n · cantidad · tecnología`; el detalle muestra selector y URL del
recurso, la búsqueda y el resaltado en página aceptan estructuras y recursos, y el pie cuenta estructuras
y recursos CSS/JS. (5) **Límites:** el inventario estructural no vuelca todos los nodos del DOM, las reglas
CSS, las variables de JavaScript ni un grafo de llamadas entre librerías: solo incorpora lo que la
evidencia disponible permite afirmar. Las relaciones sin arista siguen apareciendo como raíces, no como
dependencias inventadas.

**Consecuencia:** el orden cronológico queda intacto y el jerárquico permite leer la página como un árbol
—documento, `html`, `head`/`body`, contenedores, estilos y scripts, controles, manejadores, peticiones,
rutas, funciones, SQL, tablas y bases de datos—, con los hijos repartidos a ambos lados del padre. Un
elemento ausente del inventario o una tecnología detectada solo en la cabecera no se convierte en padre de
algo que no lo evidencia; el mapa distingue lo observado de lo estático como en el resto de vistas.

## ADR-049 — Auditoría de exposición en el cliente y perfiles de manejador

**Contexto:** la herramienta mostraba la cadena de ejecución, pero no advertía de un fallo frecuente:
el HTML, el CSS o el JavaScript entregados al navegador podían contener la IP o el host internos del
backend, credenciales o endpoints HTTP, de modo que el cliente llamaba al servidor directamente en vez
de pasar por el frontend o su proxy. Además, los manejadores sin nombre aparecían como «función
anónima» aunque fueran funciones flecha con parámetros, `async`, `await` o generadores; esa información
ya estaba disponible en el objeto de la función y se estaba descartando.

**Decisión:** (1) **Escaneo textual honesto:** `SecurityScanner` recibe los mensajes CDP
`Debugger.scriptParsed`, `Debugger.globalObjectCleared` y `CSS.styleSheetAdded/Removed`, y al analizar
lee el DOM serializado (`document.documentElement.outerHTML`), las hojas de estilo mediante
`CSS.getStyleSheetText` —con el contenido accesible como respaldo—, todos los scripts con
`Debugger.getScriptSource` y las peticiones ya capturadas. El análisis se ejecuta en `main`, sin enviar
nada fuera del equipo, y se programa 900 ms después de cada carga; el botón «Reanalizar» lo repite. Los
escaneos se serializan y un cambio de página invalida el resultado en curso para no publicar hallazgos de
la página anterior. (2) **Reglas y severidad:** se marcan como críticas las direcciones privadas
(`10/8`, `127/8`, `192.168/16`, `172.16/12`, `169.254/16`), los hosts `localhost` o `.local` cuando no
coinciden con el origen de la página, y cualquier host que coincida con el backend configurado; como
altas, las peticiones directas al backend o a un host interno; como medias, el transporte HTTP sin
cifrar; y aparte se detectan secretos con forma conocida (Stripe, AWS, GitHub, GitLab, Google, JWT y
claves privadas) y sumideros DOM (`eval`, `new Function`, `innerHTML`, `outerHTML`,
`insertAdjacentHTML`, `document.write` y `dangerouslySetInnerHTML`) solo en código propio. Los secretos
se enmascaran en la evidencia y las credenciales genéricas solo se buscan en código de primera parte.
(3) **Origen de primera parte:** una URL es del proyecto si `normalizeCodeLocation` puede resolverla a un
archivo existente de la raíz abierta; las URL relativas a `localhost`, `127.0.0.1` o `::1` se resuelven
igual. Las líneas del HTML serializado se rotulan como tales, no como líneas del archivo fuente, y las
coincidencias en código servido que no se puede resolver llevan la misma advertencia. (4) **Interfaz:** la
pestaña «Seguridad» del panel inferior muestra los hallazgos con filtros exclusivos por gravedad y tipo,
búsqueda, estado del análisis, contadores de críticas/altas en la pestaña y enlaces al código cuando la
ubicación es resoluble. Los filtros ocultan y re-apilan, no atenúan. (5) **Perfiles de manejador:** el
protocolo añade `HandlerProfile` (`async`, `await`, `generator`, `arrow`, `params`, `signature`) y los
helpers `handlerLabel`/`handlerProfileTags`. El perfil se obtiene del objeto real de la función —en la
página para las props de React/Vue y el inventario de controles, y por `Runtime.callFunctionOn` para los
listeners de CDP—, con un respaldo que analiza el texto de la función cuando el objeto no está
disponible. La etiqueta muestra el nombre si existe y, si no, la firma (`async (req, res) =>`,
`function (e)`, `x =>`), seguida de las etiquetas `async`, `await`, `generador` y `flecha`. El mismo
perfil se propaga a panel, tooltip, inventario, ledger de runtime, mapa y búsqueda. El índice estático de
rutas añade `handlerSignature` para los manejadores anónimos del backend, de modo que el mapa ya no los
rotula como «Función anónima».

**Consecuencia:** la pestaña «Seguridad» señala la exposición del backend y los secretos que el navegador
puede leer, con evidencia y ubicación, sin afirmar que un hallazgo sea explotable: la detección es
textual y requiere revisar si el valor llega de una fuente no confiable. Escanear todos los scripts,
incluidos los de terceros, puede producir ruido; el filtro por primera parte se aplica a los sumideros y
a las credenciales genéricas, no a las claves con formato inequívoco, que se muestran en cualquier script
entregado. Las firmas y etiquetas describen la función observada —su constructor, su texto o su AST—, no
garantizan que se haya ejecutado; la evidencia STATIC/RUNTIME del resto de la herramienta sigue siendo la
que decide qué se observó.

## ADR-050 — Vista estructural y árbol por archivo

**Contexto:** ADR-048 añadió el orden jerárquico, pero el árbol seguía siendo HTML-céntrico: la contención
DOM solo relacionaba documento, estructuras, controles y recursos de una misma página; los manejadores,
rutas, funciones y SQL sin una arista de contención quedaban como raíces sueltas. El usuario pidió un modo
por orden estructural del archivo y que el árbol cubriera todos los archivos, no solo el HTML.

**Decisión:** (1) **Protocolo:** `FlowNodeType` añade `file` y `FlowStats` añade `files`. El nodo de archivo
tiene como título el nombre, como subtítulo la ruta relativa y como `file` la misma ruta, de modo que el
detalle pueda abrirlo en el editor. (2) **Índice del proyecto:** `WorkspaceService.getFilePaths()` aplana
el árbol ya ignorado por la configuración y lo cachea hasta que el observador detecta un cambio;
`BrowserControllerOptions.getWorkspaceFiles` lo entrega al controlador y `buildFlowSnapshot` lo recibe como
`workspaceFiles`. `createWorkspaceFileIndex` resuelve rutas relativas, URL `http(s)` locales, URL `file:`,
rutas absolutas de Windows por sufijo y rutas SPA al `index.html` del proyecto; no toca el disco durante el
mapa. (3) **Grafo:** `projectSourceFiles` crea un nodo `file` por cada archivo resuelto desde el documento
HTML, los recursos CSS/JS, los manejadores, las rutas, las funciones y las SQL. El archivo contiene el
documento raíz, los recursos y los nodos de código con aristas `CONTAINS`; la contención DOM existente se
conserva para los controles, de modo que el árbol no aplana el HTML. Los nodos sin archivo resoluble
—peticiones, tablas y bases de datos— siguen colgando de su cadena de evidencia. (4) **Layout:** el modo
`structural` reutiliza las columnas por categoría del cronológico y ordena cada columna por ruta de archivo,
línea, selector DOM, método/ruta o título, con la hora solo como desempate. El cronológico no cambia; el
jerárquico usa los nodos de archivo como raíces y aplica ese mismo orden estructural dentro de cada tipo.
(5) **Mapa:** la barra añade «Estructural»; el pie cuenta archivos, el buscador y el detalle aceptan nodos de
archivo, y el estado explica el criterio. El alcance «Solo lo que interactuaste» no expande los hijos
estructurales de un archivo: de lo contrario, un archivo con un solo nodo RUNTIME haría aparecer todos sus
controles estáticos como si se hubieran usado. (6) **Límites:** el árbol cubre todos los archivos que
aportan evidencia al mapa, no todos los archivos del repositorio; volcar archivos ajenos al flujo sería un
explorador de archivos, no un mapa. Un recurso compilado o minimizado que no se puede resolver a una fuente
del proyecto no inventa un nodo de archivo. Tampoco se extraen reglas CSS, variables internas de JavaScript
ni un grafo de llamadas entre librerías.

**Consecuencia:** el mapa deja de ser HTML-céntrico: el árbol muestra el archivo HTML con su DOM, el archivo
CSS/JS con sus recursos y manejadores, y cada archivo de backend con sus rutas, funciones y SQL; el modo
estructural permite comparar la misma categoría entre archivos por su posición real en el código o en el
DOM. Las relaciones que no tienen evidencia siguen apareciendo como raíces, no como dependencias
inventadas.

## ADR-051 — El enfoque sobrevive al clic en el vacío y detección de `try/catch`

**Contexto:** «Ver interacciones» aísla la cadena de un nodo y mantiene el subgrafo apilado, pero el clic
en el vacío llamaba a `clearSelection()`, que también borraba `focusScope`, `focusOriginId` y el detalle:
un clic fuera de las cajas deshacía el enfoque sin que el usuario lo pidiera. Además, el perfil del
manejador describía `async`, `await`, `generador` y `flecha`, pero no distinguía una función con
`try/catch`, aunque esa estructura cambia cómo se propaga el error en la cadena inspeccionada.

**Decisión:** (1) **Clic en el vacío:** al terminar un arrastre sin movimiento, el mapa solo quita la
selección cuando no hay enfoque activo. Con `focusScope` activo, el clic en el vacío no altera el
enfoque, la selección ni el detalle, y el subgrafo sigue apilado y ajustado. La salida explícita se
mantiene en «Quitar enfoque» del menú contextual y del estado; abrir el mapa, cambiar el modo de tráfico
o la casilla «Solo esos» conservan su propio restablecimiento. (2) **`try/catch`:** `HandlerProfile` añade
`tryCatch` como campo obligatorio. El helper de la página lo calcula del texto de la función con
`/\btry\s*\{/` y `/\bcatch\s*(?:\(|\{)/` —ambos presentes—; `parseHandlerProfile` normaliza el campo y
`profileFromSource` aplica la misma prueba cuando el objeto real no está disponible. `handlerProfileTags`
añade la etiqueta `try/catch`, de modo que panel, tooltip, inventario, ledger, búsqueda y detalle del mapa
la muestran junto a las etiquetas existentes sin cambios adicionales en cada vista.
(3) **Límite honesto:** la prueba es textual, igual que `await`: un `try` y un `catch` dentro de funciones
anidadas también marcan la función contenedora, un comentario o una cadena con ese texto puede producir
una coincidencia, y la etiqueta no demuestra que la ruta de error se ejecutara ni que la excepción
llegara al backend.

**Consecuencia:** el enfoque de una caja permanece estable mientras se navega, se inspecciona la página o
se hace clic en el fondo, y solo se abandona por una acción explícita. El perfil del manejador responde
también qué funciones capturan errores con `try/catch`, con la misma evidencia descriptiva —no de
ejecución— que el resto de etiquetas.

## ADR-052 — Vista compacta y barra fija de tipos en el mapa

**Contexto:** el mapa ya ocultaba lo que quedaba fuera del visor, pero cada tarjeta seguía mostrando tipo,
título, subtítulo, hora y contador en 48 px de alto; con muchas rutas, la densidad seguía siendo baja y
el texto pequeño dificultaba leer los cuadros. Además, las etiquetas de tipo de cada columna se dibujaban
dentro del SVG: al arrastrar el mapa vertical u horizontalmente desaparecían de la vista, de modo que el
usuario perdía la referencia de qué columna era HTML, frontend, backend o SQL.

**Decisión:** (1) **Vista compacta:** la barra del mapa añade la casilla «Vista compacta». Marcada, cada
nodo dibuja solo su título y su contador (`N×`) en una tarjeta de 30 px (`FLOW_NODE_COMPACT_HEIGHT`);
se ocultan la etiqueta de tipo, el subtítulo y la hora. El layout acepta `{ compact }` y reduce también
el hueco entre filas —de 10 a 6 px— y el hueco vertical del árbol jerárquico —de 82 a 48 px—, de modo que
entran más nodos en la misma pantalla. Las aristas, el recorte por visor, el ajuste y el zoom usan la
altura activa, no una constante. El detalle del nodo, el buscador, el tooltip y el rail conservan toda la
información: la vista compacta es una presentación, no una pérdida de datos. (2) **Barra fija de tipos:**
las etiquetas de capa dejan de dibujarse dentro del SVG y se renderizan en `#map-axis`, una franja opaca
de 22 px en la parte superior del lienzo con `pointer-events: none`. En los órdenes cronológico y
estructural, cada etiqueta se posiciona en la coordenada X de su columna y se desplaza con
`view.x + layer.x * view.k`, así que sigue el arrastre horizontal y el zoom, pero permanece fija en la
parte superior al desplazar en vertical. El ajuste (`fitView`/`fitToNodes`) reserva esos 22 px para que
la barra no tape la primera fila, y el estado del mapa se desplaza debajo. En el orden jerárquico no hay
columnas por tipo —sus capas son niveles—, así que las etiquetas de nivel se listan en la misma barra de
izquierda a derecha. (3) **Persistencia:** la casilla conserva su estado mientras la ventana del mapa
sigue abierta y se re-aplica al cambiar de orden, de alcance o de snapshot; el detalle no cambia.

**Consecuencia:** el usuario puede compactar el mapa para ver y leer muchos más objetos a la vez, y
mantiene siempre visible la referencia de tipo y tecnología de cada columna sin importar cuánto arrastre.
La contrapartida es que la barra ocupa 22 px del visor y que, en modo compacto, el tipo, el subtítulo y
la hora solo están disponibles en el detalle, el tooltip o al desmarcar la casilla. La barra sigue el
movimiento horizontal, no el vertical: es una guía de columnas, no un nodo del grafo.



## ADR-053 — Columnas medidas por su contenido y ajustables desde la barra fija

**Contexto:** ADR-052 redujo la altura de las tarjetas en vista compacta, pero el ancho seguía fijo en
210 px: títulos como «div» o nombres cortos dejaban la mayor parte del cuadro vacía, las columnas no se
acercaban y el mapa desperdiciaba espacio horizontal. El usuario pidió eliminar ese espacio y poder
cambiar el ancho de cada columna arrastrando el separador de su encabezado en la barra fija, como hace
el Explorador de Windows, en lugar de un control global.

**Decisión:** (1) **Anchos por contenido:** `FlowLayoutOptions` acepta `widthOf(node)`; `FlowPlacedNode`
lleva su `width` y `FlowLayerInfo` el ancho de su columna. El preload mide el texto con un canvas 2D
usando las mismas fuentes del SVG —título 600 11 px, tipo 600 8 px, subtítulo 10 px, contador 600 8 px y
hora 9 px mono— y calcula el ancho necesario: en vista compacta, título y contador; en normal, el mayor
de las filas tipo+contador, título y subtítulo+hora, con 10 px de margen izquierdo y 8 px de derecho. El
ancho natural se acota entre 52 y 440 px. En los órdenes cronológico y estructural, todas las tarjetas de
una columna usan el ancho de la columna —el mayor de sus anchos naturales o el ancho manual—; en el
árbol, cada nodo conserva su propio ancho y se centra sobre su subárbol. Las aristas, el recorte por
visor, el ajuste, las cajas de impacto y el dibujo usan el ancho de cada nodo en lugar de la constante.
El texto que no cabe se recorta con «…» midiendo píxeles; el contenido completo sigue en el tooltip y el
detalle. (2) **Columnas arrastrables:** la barra fija dibuja un separador en el borde derecho de cada
encabezado de tipo. Arrastrarlo cambia el ancho de esa columna —el desplazamiento en pantalla se divide
por el zoom para trabajar en unidades del mapa— entre 44 y 720 px; el ancho manual se guarda por tipo y
se re-aplica al re-apilar. Durante el arrastre, un `requestAnimationFrame` recalcula el layout y redibuja
el SVG sin cambiar el zoom, el desplazamiento, la selección ni el alcance activo. El doble clic en el
separador borra el ancho manual y vuelve al ancho del contenido. En el orden jerárquico, que no tiene
columnas por tipo, no hay separadores y se mantienen los anchos por contenido. (3) **Barra fija:** cada
etiqueta se limita al ancho de su columna y reduce su texto —completo, tipo y contador, o solo tipo—
cuando la columna es estrecha, además de recortarse con puntos suspensivos al hacer zoom, de modo que no
se pisan entre sí; como el separador se coloca en el borde de la columna, sigue al encabezado mientras
se arrastra o se desplaza la vista. (4) **Límites:** el ancho se mide con la fuente del sistema del
renderizador, no con las métricas exactas del SVG, así que puede quedar una diferencia de pocos píxeles;
el árbol puede mostrar bordes derechos irregulares porque cada tarjeta usa su propio ancho. No se
inventan anchos para textos que no se han medido ni se guardan preferencias entre ventanas: el ajuste
vive mientras la ventana del mapa sigue abierta.

**Consecuencia:** cada columna ocupa solo lo que su contenido necesita por defecto, las columnas se
acercan y el mapa deja de reservar espacio muerto; el usuario puede apretar o ensanchar cada columna
arrastrando el separador de su encabezado, como en el Explorador de Windows, y recuperar el ajuste
automático con doble clic. La contrapartida es que los textos largos se recortan visualmente, que una
columna muy ancha puede empujar las siguientes fuera del visor y que el árbol jerárquico puede quedar
con bordes derechos desiguales.

## ADR-054 — Vista de datos de la base de datos

**Revisión:** el «sin valores de filas» del contexto y de la presentación, la orientación origen →
tabla y la ausencia de aislamiento por clic quedaron sustituidos por ADR-055. El resto sigue vigente.
La ventana propia separada y el ciclo `flowOpen = mapOpen || dataOpen` quedaron sustituidos por
ADR-062 y, después, por ADR-064, que integra la rejilla de tablas en el único mapa.

**Contexto:** el mapa dibuja la dirección natural del flujo —elemento → manejador → petición → ruta →
SQL → tabla—, pero para entender qué datos extrae una aplicación conviene la vista inversa: dada una
tabla o una columna, qué acciones, rutas o funciones la leen o la escriben. El usuario pidió esa
visualización y aportó un boceto con acciones, dos tablas con columnas y una base de datos, sin
intención de copiar su diseño. Debía adaptarse a la interfaz plana existente, usar la misma evidencia
que el mapa y no mostrar valores de filas ni credenciales.

**Decisión:** (1) **Ventana propia y snapshot compartido:** «Datos» abre una `BrowserWindow` separada,
igual que el mapa, con su preload y su HTML. El controlador mantiene un solo ciclo de flujo mediante
`flowOpen = mapOpen || dataOpen`: abrir cualquiera de las dos ventanas inicia la captura, el inventario
y la resolución automática, y cerrar una no los detiene mientras la otra siga abierta; al cerrar ambas,
al desactivar la inspección o al limpiar la sesión, el flujo se detiene y ambas ventanas se cierran. Las
dos ventanas reciben el mismo `FlowMapState` en cada revisión; no hay una segunda captura ni un análisis
paralelo. (2) **Derivación desde el grafo, sin inventar datos:** se recorren los nodos `query` del
snapshot y sus tablas leídas/escritas se resuelven por nombre contra los nodos `table`. Las columnas
provienen del análisis SQL y se adjuntan a la tabla que declaran o, si no la declaran, a la única tabla
de la consulta; con varias tablas una columna sin tabla se descarta y la tabla se rotula «columnas no
identificadas». `SELECT *` se rotula como tal y no enumera columnas; el respaldo del analizador aporta
tablas pero no columnas. Las consultas sin tabla identificada se cuentan en el pie y no se dibujan. Los
orígenes se derivan del elemento con traza o, en su defecto, de la ruta o función más cercana que alimenta
la consulta. Se conservan las etiquetas STATIC/RUNTIME: las aristas heurísticas son discontinuas y las
solo estáticas se atenúan. (3) **Presentación:** origen → tabla con columnas → base de datos; cada
columna lista sus usos SQL (`SELECT`, `RETURNING`, `INSERT`, `SET`, `WHERE`, `JOIN`, `GROUP`, `ORDER`)
en verde para lectura, ámbar para escritura y gris para esquema. Los filtros «Todo/Lecturas/Escrituras»
y «Todo el tráfico/Solo lo que interactuaste» son exclusivos y re-apilan el grafo al ocultar; la
búsqueda encuentra orígenes, tablas, columnas y SQL y solo atenúa. El rail de orígenes y las listas
cargan de 20 en 20 al desplazarse. El detalle de cada nodo enlaza al código y permite resaltar el control
en la página; el pie declara que solo se muestran tablas y columnas, sin valores de filas. El texto del
SVG no es seleccionable, igual que en el mapa. (4) **Límites:** solo aparecen las columnas declaradas en
el SQL, así que los alias y las expresiones calculadas no figuran con el nombre que tendrían en la
respuesta; una columna sin tabla en una consulta con varias tablas no se adjunta; la orientación
origen → tabla es la del grafo y no prueba que esa ruta se ejecutara; la vista no persiste zoom,
desplazamiento ni preferencias entre ventanas.

**Consecuencia:** el usuario puede partir de una tabla o una columna y ver qué acciones, rutas o
funciones la extraen, con sus usos SQL y su evidencia, sin leer el SQL crudo ni abrir el mapa. La
contrapartida es que la vista hereda las limitaciones del análisis SQL: un `SELECT *`, un modo de
respaldo o una asociación ambigua dejan columnas sin dibujar, y la vista lo declara en lugar de
rellenarlas con suposiciones.

## ADR-055 — Valores devueltos y trazado direccional en la vista de datos

**Revisión:** los puntos (3) y (4) quedaron sustituidos por ADR-056: la tabla se dibuja como rejilla
SQL con celdas reales dentro del nodo y el clic izquierdo solo resalta; el aislamiento pasa al menú
contextual. El resto sigue vigente.

**Contexto:** tras la primera versión de «Datos», el usuario pidió ver exactamente qué dato trae cada
tabla y hacia dónde se dirige, y poder aislar la cadena de una tabla al hacer clic, como «Ver
interacciones» del mapa. También pidió que los valores se muestren sin enmascarar, incluidos hashes y
datos sensibles: la herramienta es observacional, el administrador de MySQL ya permite verlos y un
valor oculto impide comprobar precisamente lo que se quiere auditar —por ejemplo, si una contraseña
está hasheada—. La seguridad de esos datos corresponde a la base de datos, no a la vista.

**Decisión:** (1) **Captura de muestras en el punto de instrumentación:** el código inyectado que ya
registra el SQL envuelve además el resultado de los drivers soportados —callback en `mysql`,
`sqlite3` y `better-sqlite3`; promesa en `pg` y `mysql2`; `prepare().all/get` síncrono en
`better-sqlite3`— y guarda una muestra JSON-safe de las filas devueltas: máximo 12 filas, 24
columnas, 240 caracteres por celda y 200 KB por vaciado. Las muestras de un mismo SQL repetido en 20
ms se descartan para no duplicar ejecuciones. No se guardan parámetros, solo las filas que el driver
devuelve. (2) **Propagación con la misma evidencia:** la muestra viaja como `InspectionSqlResult` —
columnas, filas, recuento, truncado, hora y driver— desde la ejecución capturada hasta el nodo
`query` del snapshot (`FlowNode.result`). Las consultas estáticas llevan `result: null`; cuando una
ejecución observada actualiza una consulta ya conocida, su resultado se reemplaza por el último
observado. No hay una segunda captura ni una fuente de datos distinta de la del mapa. (3)
**Presentación sin enmascarar:** el detalle de tabla, columna y origen muestra «Datos devueltos» o
«Valores de <columna>» con la operación, el driver, la hora, el recuento de filas y el tamaño de la
muestra; dibuja todas las columnas o solo la de la columna elegida, distingue `null` de cadena vacía
y avisa de muestra truncada. Una nota declara que son valores reales del driver, sin enmascarar, que
pueden contener datos sensibles y que permanecen en memoria. Si no hubo ejecución observada, la vista
lo dice; no inventa filas. El enmascarado de cuerpos de petición, cabeceras y secretos de la
auditoría sigue intacto: esta excepción cubre solo las filas devueltas. (4) **Dirección e
aislamiento:** las lecturas se dibujan de tabla a origen —el dato sale de la tabla hacia quien lo
consume— y las escrituras de origen a tabla; la tabla apunta a su base de datos. El clic en cualquier
nodo lo selecciona y aísla su cadena completa —ancestros y descendientes—, la vuelve a apilar y la
ajusta a la pantalla. El enfoque se quita con el botón «Ver cadena completa» del estado, con
`Escape`, con un clic en el vacío, volviendo a pulsar el nodo o cambiando un filtro; los filtros
también limpian la selección. (5) **Límites:** solo hay filas de consultas observadas durante la
inspección; `Prisma` y los ORM que no pasan por los drivers instrumentados no aportan muestras; la
muestra refleja lo que devolvió el driver, no el cuerpo HTTP final ni transformaciones posteriores;
los topes de filas, columnas y celdas recortan resultados grandes y se rotulan como muestra.

**Consecuencia:** el usuario ve el valor exacto que sale de la base de datos —incluidos hashes, nulos
y formatos— y puede seguir su dirección y aislar la cadena como en el mapa. La contrapartida es que
la ventana puede mostrar información sensible en pantalla o en una grabación, y que las consultas sin
ejecución observada siguen sin filas; ambos límites se declaran en la interfaz y en la documentación
en lugar de simularse.

## ADR-056 — Rejilla SQL y selección sin aislamiento en la vista de datos

**Contexto:** tras ADR-055 el usuario corrigió tres cosas: el clic izquierdo debía solo resaltar el
nodo, y el aislamiento debía ir en un menú de clic derecho con «Ver interacciones», copiando exactamente
la interacción del mapa de flujo; la tabla solo enumeraba columnas, y hacía falta ver los datos como en
SQL —columnas en horizontal, el tipo de petición debajo del nombre, sin una sola línea— con las celdas
reales sobre las que se interactuó; y el mismo par clic izquierdo/menú contextual debía funcionar en los
orígenes, las listas y las celdas concretas.

**Decisión:** (1) **Interacción idéntica al mapa:** el clic izquierdo en una tabla, columna, celda,
origen, base de datos o fila de las listas solo selecciona y muestra el detalle; no aísla ni re-apila.
El clic derecho abre un menú fijo con «Ver interacciones» —aísla ancestros y descendientes, re-apila y
ajusta la vista—, «Resaltar en la página» para un origen con selector y «Quitar selección» o «Quitar
enfoque» según el estado. Un clic en el vacío solo limpia la selección cuando no hay enfoque activo;
`Escape` cierra primero el menú, después los resultados de búsqueda y por último la ventana; perder el
foco de la ventana cierra el menú. (2) **Rejilla dentro del nodo:** la tabla se dibuja como una rejilla
horizontal con los nombres de columna en la cabecera y sus usos SQL apilados debajo, uno por línea, con
color por operación; las celdas reales de las ejecuciones observadas se dibujan como filas con
numeración, franjas alternas y `·` para las ausentes; las columnas que solo trae la respuesta se añaden
al final con la etiqueta RESULTADO; las filas de todas las muestras de la tabla se fusionan emparejando
por nombre de columna en minúsculas; el ancho de cada columna se calcula por su contenido, con recorte y
`<title>` para los textos largos; la celda elegida se marca sobre la columna seleccionada. Una nota al
pie del nodo declara filas, ejecuciones, driver y truncado, o la ausencia de muestras. (3) **Detalle
coherente:** la tabla de muestra del detalle apila también los usos bajo cada nombre de columna y sus
encabezados y celdas comparten el clic de selección y el menú contextual, con el mismo enlace a la
columna del grafo.

**Consecuencia:** la vista «Datos» se comporta como el mapa —seleccionar no aísla— y muestra el valor
real dentro de la tabla, no solo en el panel lateral. La contrapartida es que los nodos de tabla son
más anchos y altos, que la captura sigue limitada a las ejecuciones observadas y que el emparejamiento
por nombre en minúsculas no distingue dos columnas homónimas de la misma tabla.

## ADR-057 — Muestras SQL de toda la sesión en la vista de datos

**Contexto:** con ADR-055 y ADR-056 una tabla como `warehouses` seguía mostrando «Sin celdas
observadas» aunque el backend hubiera leído sus filas. La muestra solo viajaba dentro de una traza de
clic: `applyCapturedSql` la descartaba si no había una inspección activa y la ejecución caía fuera de
la ventana de 3 s. Las consultas que se ejecutan al cargar una página o en segundo plano nunca llegaban
al grafo, así que sus tablas quedaban solo con columnas estáticas.

**Decisión:** (1) **Registro de sesión por SQL:** el controlador guarda en un mapa cada ejecución
capturada del driver, indexada por el texto SQL normalizado. Conserva la última muestra de filas, el
recuento de ejecuciones, el driver, la hora, el análisis de tablas y columnas y el primer marco de pila
resoluble; una ejecución sin muestra no borra la última muestra conocida. (2) **Fusión en el grafo:**
el snapshot recibe ese registro además de las trazas. Cada entrada se compara con las consultas ya
proyectadas —estáticas, de tarjeta o de traza— por texto SQL normalizado; la primera coincidencia
recibe la muestra y el recuento para no duplicar filas al agregar varias consultas de la misma tabla, y
las demás solo se marcan como ejecutadas. Si no hay coincidencia, se crea un nodo de consulta RUNTIME
con el análisis del SQL y, si la pila lo permite, se enlaza a la función que la ejecutó; la consulta
proyecta sus tablas y su base de datos. Las consultas, tablas, bases de datos y aristas de lectura o
escritura que toca una ejecución pasan a evidencia RUNTIME. (3) **Refresco:** cada captura marca el
flujo como sucio y el mapa o la vista «Datos» se reconstruyen con el refresco ya retardado, sin exigir
un clic. El registro se vacía al limpiar la sesión o al cerrar ambas ventanas, como el resto del flujo.

**Consecuencia:** las celdas reales aparecen para cualquier consulta que el backend ejecute mientras la
inspección esté activa, incluidas las de carga inicial y las de segundo plano, sin depender de haber
hecho clic en la página. La ventana «Datos» muestra además el estado de la captura: sin inspector
conectado, sin drivers compatibles, con error o con la captura activa pero aún sin filas devueltas, de
modo que una tabla vacía nunca queda sin explicación. La contrapartida es que la asociación es por texto
SQL y no por sitio de llamada —dos rutas con el mismo SQL aparecen ambas como ejecutadas—, que no hay
muestras retroactivas anteriores a la conexión del inspector y que los ORM con motor propio siguen sin
exponer filas.

## ADR-058 — Detección general de drivers SQL en el proceso inspeccionado

**Contexto:** con ADR-057 la ventana «Datos» podía seguir sin detectar `mysql2` en un backend ESM. La
captura obtenía el cargador con `await import('node:module')`, pero `Runtime.evaluate` del inspector no
admite `import()` dinámico sin callback («A dynamic import callback was not specified»): el error se
capturaba en silencio, no quedaba ningún cargador, `require` y `process.mainModule` no existen en un
entorno ESM y la detección terminaba con cero drivers. Además, la lista de drivers era fija y solo
miraba el módulo raíz resuelto desde un par de rutas, de modo que no cubría copias anidadas ni paquetes
nuevos.

**Decisión:** (1) **Cargador síncrono:** se obtiene el módulo `node:module` con
`process.getBuiltinModule('node:module')` (Node 22.3+) y, como respaldo, con `process.mainModule`; con
`createRequire` sobre `process.argv[1]` y el `cwd` se resuelven paquetes de un backend ESM o CommonJS.
Si no hay ningún cargador, la captura informa el motivo en lugar de decir simplemente que no hay
drivers. (2) **Registro de adaptadores:** la lista fija se sustituye por un registro
`adapters[paquete] → patch(módulo)`; añadir un driver nuevo es añadir una entrada. El registro inicial
cubre `pg`, `mysql2`, `mysql`, `mariadb`, `mssql`, `sqlite3` y `better-sqlite3`. (3) **Caché real de
módulos:** se recorre `require.cache` de todos los cargadores, se agrupa por paquete —incluidas copias
anidadas en `node_modules` y `pnpm`— y se parchea cada copia cargada, no solo la que resuelve la ruta
del punto de entrada. (4) **Cargas futuras:** se envuelve `Module._load` para instrumentar drivers o
paquetes SQL que se carguen después de conectar la inspección. (5) **Detección genérica:** un paquete
cargado con pistas de base de datos (`sql`, `database`, `postgres`, `mysql`, `sqlite`, `oracle`, `libsql`…)
que exporte clases con `query` o `execute` y nombre de conexión, cliente, pool, base de datos o sesión
se instrumenta con el nombre del paquete aunque no tenga adaptador; los ORM y clientes que delegan en
un driver ya parcheado se excluyen para no duplicar filas. (6) **Compatibilidad en caliente:** el estado
global lleva versión; al reconectar con una captura anterior se instala la nueva y su drenaje fusiona el
búfer antiguo, así que una versión nueva de la app no exige reiniciar el backend ya instrumentado. (7)
**Límites de memoria:** el búfer conserva las últimas 2000 ejecuciones sin drenar y el mapa de
deduplicación los últimos 1000 textos SQL, para que la instrumentación no crezca sin límite si la app se
desconecta y el backend sigue ejecutando consultas.

**Consecuencia:** la captura funciona igual en backends CommonJS y ESM (en ESM requiere Node 22.3+ para
obtener el cargador), detecta drivers ya cargados y futuros, e incorpora motores nuevos mediante el
registro o la detección genérica. La ruta de instalación de MySQL no interviene en ningún paso: la
captura ocurre dentro del proceso Node, no en el servidor de base de datos. Siguen fuera de alcance los
drivers empaquetados dentro de un bundle (no hay módulo que parchear), las APIs sin clases exportadas
(por ejemplo, clientes HTTP que solo exponen una función) y los ORM con motor propio como Prisma; para
esos casos el estado de la captura lo declara en vez de simular columnas.

**Revisión:** el adaptador `mysql2` parchea toda la cadena de prototipos de `Connection` (incluidas
`BaseConnection` y `BasePoolConnection`) y no las clases `Pool`/`PoolCluster`. `pool.query(sql, cb)`
crea un objeto `Query` y llama a `conn.query(cmdQuery)`; en ese modo las filas no se emiten como eventos
sino que quedan en `query._rows`/`query._fields` al terminar. La captura conserva una referencia a ese
objeto y lee ahí la muestra, sin muestrear el `Query` en sí. Además, el drenaje de una captura nueva
descarta las entradas del estado anterior creadas después de su instalación (`at >= installedAt`): los
wrappers antiguos que sigan vivos en el proceso dejan de aportar filas falsas aunque el backend no se
reinicie. Verificado en vivo contra un backend ESM con `mysql2/promise`: `SELECT 1` produce
`columns: ["1"], rows: 1` sin entradas espurias.

## ADR-059 — Aristas ancladas a la celda observada en la vista de datos

**Contexto:** con ADR-056 la tabla se dibuja como una rejilla con celdas reales, pero las aristas de
lectura y escritura seguían entrando por la cabecera del nodo de tabla. Al mirar una ejecución concreta
no se veía a qué fila —a qué celda— pertenecía el dato que había viajado entre la base de datos y el
origen.

**Decisión:** (1) **Ancla por celda:** cada arista origen-tabla termina en el borde izquierdo del nodo
alineada con la celda concreta que tocó su SQL, no con la cabecera de la tabla. Para lecturas se toma la
muestra más reciente del origen y se elige una columna leída de esa muestra (primero `SELECT`/`RETURNING`,
después condiciones y por último cualquier columna devuelta) en su primera fila; para escrituras se usa
una muestra con filas de la propia escritura si existe (`RETURNING`) y, si no, la celda de cabecera de la
columna escrita. Las columnas del análisis estático sin muestra apuntan a su celda de cabecera. (2)
**Clic en una celda:** cuando el usuario elige una celda, las aristas del mismo sentido cuya consulta
devolvió esa fila y usa esa columna se anclan a la fila elegida; la celda sigue marcada en la rejilla y
las aristas ajenas conservan su ancla. (3) **Marca en el borde:** el borde izquierdo del nodo pinta un
segmento del color de cada arista en la fila de anclaje, de modo que la conexión se lee aunque la línea
quede dibujada bajo la tabla. (4) **Tooltip:** la arista nombra la celda (`tabla.columna · fila N = valor`)
o la columna sin fila observada, junto a la dirección, el recuento, la correlación y la evidencia.

**Consecuencia:** las flechas muestran el dato concreto que salió o entró de la tabla en lugar de la
tabla entera, y al seleccionar una celda se ve exactamente a qué valor llega cada arista. La
contrapartida es que una consulta que devuelve varias filas se representa por su primera fila —la celda
elegida manda— y que una escritura sin `RETURNING` no tiene celda de valor observada y solo puede apuntar
a la columna escrita.

## ADR-060 — Operación por celda, resaltado permanente y ruta al hacer clic

**Contexto:** con ADR-059 las aristas se anclan a la celda observada, pero la rejilla solo mostraba los
usos bajo el nombre de la columna. Al mirar una fila no se sabía qué había hecho su consulta con cada
celda, qué celdas había tocado el backend ni cuál era el recorrido exacto de un valor concreto; y el clic
en una celda no trazaba ese recorrido por separado.

**Decisión:** (1) **Etiquetas por celda:** cada celda apila bajo su valor las operaciones que la consulta
de esa fila realizó sobre su columna —`SELECT`, `INSERT`, `SET`, `UPDATE`, `DELETE`, `WHERE`, `JOIN`,
`GROUP`, `ORDER`—. Si la fila viene de una consulta sin columnas declaradas (resultado suelto o
`SELECT *`), se usa la operación de la consulta. La altura de la fila crece con el máximo de etiquetas de
sus celdas y no se recorta. (2) **Resaltado permanente:** las celdas que una consulta tocó quedan
pintadas por tipo —lectura, escritura o condición— aunque no haya selección; las demás conservan su
fondo normal. Ninguna se atenúa al elegir una celda. (3) **Ruta al hacer clic:** sin selección no se
dibuja ninguna flecha por celda. Al hacer clic en una celda se traza una sola ruta azul desde esa celda
hasta el origen que ejecutó la consulta de su fila —o desde el origen hasta la celda si es escritura—,
con un punto en la celda y el SQL en el tooltip; la ruta se calcula solo para la celda elegida y se
sustituye al elegir otra. (4) **Sin aislamiento:** el clic no filtra ni reencuadra el mapa; un clic en el
vacío limpia selección y ruta pero conserva el paneo y el zoom. (5) **Arrastre robusto:** el paneo captura
el puntero solo tras 3 px de movimiento para no robar el clic a celdas y columnas, y descarta un arrastre
cuyo `pointermove` llegue sin botones, de modo que un `pointerup` perdido no desplace el mapa después.

**Consecuencia:** se lee de un vistazo qué hizo el backend con cada celda y cuál fue el recorrido de un
valor, sin flechas cruzadas ni perder el resto del contenido. La contrapartida es que una misma columna
puede mostrar etiquetas distintas por fila si otra consulta la tocó de otra forma, y que las filas con
varias etiquetas son más altas.

## ADR-061 — Resaltado de página con un solo clic izquierdo y destello sincronizado de las celdas

**Contexto:** con ADR-060 el resaltado en la página seguía viviendo en el menú contextual («Resaltar en
la página») y en el botón del detalle del origen, y al pulsarlo solo se marcaba el recuadro del control:
las celdas SQL que esa interacción había tocado no se encendían, así que no se podía emparejar el
control de la página con el dato concreto de la rejilla. El usuario corrigió las dos cosas: resaltar es
literalmente un solo clic izquierdo, y el resaltado debe marcar también las celdas con las que se
interactuó. Se aclaró que las celdas a marcar son las de la rejilla «Datos» —no celdas del DOM de la
página— y que cualquier nodo de Datos (origen, tabla, columna, celda o base de datos) debe resaltar.

**Decisión:** (1) **Un clic, sin menú:** cualquier selección de la vista «Datos» —clic izquierdo en un
nodo del grafo, una entrada del rail, una columna, una cabecera, una celda o una arista— resuelve sus
objetivos de página y los envía en el mismo acto. Un origen apunta a su propio elemento; una tabla, una
columna o una base de datos apuntan a todos los orígenes de elemento que la usan; una celda apunta a los
orígenes que ejecutaron la consulta de su fila y, si no hay ninguno, a los de su tabla. Los objetivos se
deduplican por selector. El menú contextual y el botón del detalle conservan «Resaltar en la página» como
repetición explícita del mismo efecto. (2) **Varios controles a la vez:** el IPC de resaltado acepta una
lista `targets` además del payload suelto `{key, selector}` que sigue enviando el mapa de flujo, valida
cada entrada en el proceso principal y el inspector evalúa un solo `__bdtMapHighlightMany` que dibuja un
recuadro plano por control —mismo azul translúcido, posición fija, z-index 2147483646—, desplaza el
primero a la vista y hace parpadear todos a la vez; la variante de un solo objetivo se retiró. (3)
**Destello de celdas:** la selección enciende durante 2.600 ms —el mismo tiempo que el recuadro— una
capa `grid-cell-flash` sobre las celdas tocadas de la rejilla: un origen enciende las celdas con uso de
las filas de sus consultas, una tabla todas las suyas, una columna solo esa columna, una base de datos
las de sus tablas y una celda exactamente esa celda. El destello se dibuja sobre el resaltado permanente
y sobre la marca de celda elegida, se sustituye al elegir otra selección, se cancela al cerrar la vista o
al cambiar de filtros y deja intactos el paneo y el zoom. (4) **Alcance honesto:** solo se resaltan
orígenes de tipo elemento con selector declarado; un origen de ruta, función o consulta no aporta
recuadro.

**Consecuencia:** un clic izquierdo muestra a la vez el control de la página y el dato SQL exacto que
participó, sin pasos intermedios. La contrapartida es que un control puede quedar fuera del viewport
cuando varios controles comparten tabla —solo el primero se desplaza a la vista—, que el emparejamiento
de columnas sigue siendo por nombre en minúsculas y que el destello no marca cabeceras ni filas
completas, solo las celdas con uso de la selección.

## ADR-062 — Ventana unificada de mapa y datos con selección cruzada

**Revisión:** la ventana con dos mitades, el divisor arrastrable y la selección cruzada quedaron
sustituidos por ADR-064, que fusiona ambos grafos en un solo lienzo y convierte cada tabla en una
rejilla dentro del mapa. La ventana única, el `FlowMapState` compartido y el cierre con
«Cerrar ventana»/X/`Escape` siguen vigentes.

**Contexto:** mapa de flujo y vista de datos vivían en ventanas separadas para ahorrar trabajo de render.
En uso real el coste se trasladaba a la persona: debía buscar el mismo nodo en dos mapas que nunca se
unían, sin poder seguir de un tirón la cadena HTML → frontend → backend → SQL → base de datos, y sin
selección compartida entre ambas vistas. El rendimiento no es una restricción en esta etapa.

**Decisión:** (1) **Una sola ventana:** `UNIFIED_HTML` monta el mapa en la mitad superior y la vista de
datos en la inferior, con un divisor de 7 px arrastrable, doble clic que restaura la proporción por
defecto (56/44) y flechas ↑/↓ que lo mueven por teclado. Ambos preloads comparten el proceso de preload
`unified.ts`, que inicializa las dos vistas y recibe un único `FlowMapState`. (2) **Mismos nodos:** las
dos vistas siguen usando los identificadores del grafo —`table:`, `database:`, `route:`, `function:`—,
de modo que una tabla o una función es el mismo nodo en mapa y en datos en lugar de una copia.
(3) **Selección cruzada sin bucles:** al seleccionar un nodo en el mapa se enfoca el nodo equivalente en
datos y viceversa —incluidos tabla, columna, celda, origen y base de datos— mediante un indicador de
sincronización que envuelve ambas llamadas y corta la reentrada. Cada enfoque reutiliza la selección y
el resaltado ya existentes: no inventa un estado nuevo. (4) **Un solo botón:** «Mapa» abre la ventana
unificada; «Cerrar ventana», la X o `Escape` la cierran y el mapa deja de refrescarse. (5) **Divisor
accesible:** el separador es un `role="separator"` con `tabindex`, y el cuerpo bloquea la selección de
texto mientras se arrastra.

**Consecuencia:** la cadena completa se lee en un solo lugar y una selección sirve para las dos vistas.
La contrapartida es que ambas vistas renderizan a la vez y comparten un proceso de preload, lo que
aumenta el trabajo por refresco —aceptado a cambio de la continuidad y pendiente de la optimización
prevista—.

## ADR-063 — Captura de todos los movimientos JSON del backend en runtime

**Contexto:** la instrumentación de ADR-057 capturaba todas las ejecuciones SQL del backend, también las
que no colgaban de un clic. Los cuerpos JSON —peticiones salientes, respuestas del servidor y llamadas a
`JSON.parse`/`JSON.stringify`— solo se veían de forma indirecta en las peticiones capturadas por el
navegador. Faltaba el equivalente del lado del servidor para seguir un dato desde el cuerpo HTTP hasta
el objeto que lo parseó o serializó, y la petición del usuario fue explícita: hacer con JSON lo que se
hizo con SQL.

**Decisión:** (1) **Misma vía:** se inyecta un global `__bdtJsonCapture` mediante `Runtime.evaluate` en
el objetivo del Node Inspector, con versión de captura, información honesta de hooks instalados y un
búfer acotado con deduplicación reciente. (2) **Qué se captura:** `JSON.parse` y `JSON.stringify`
—etiquetados como `parse`/`stringify`— cuando el valor es un objeto o una cadena con forma JSON; las
escrituras de `http`/`https` `ServerResponse` —respuestas, `response`—; las escrituras de
`ClientRequest` —peticiones salientes, `request`—; y `fetch` en ambos sentidos, con el cuerpo de la
respuesta leído desde un clon para no consumir el original. Cada entrada guarda tipo, dirección,
método, ruta limpia, estado, hora, cuerpo, marca de truncado y pila. (3) **Drenaje periódico:** cada
400 ms se ejecuta `serialize(drain())` y el proceso principal parsea el resultado con topes de tamaño y
de entradas. (4) **Enmascarado en el proceso principal:** los cuerpos pasan por `sanitizeJsonBody` de
`@bdt/network-capture` antes de guardarse o mostrarse; un cuerpo truncado se oculta, nunca se muestra
sin enmascarar. La clave de deduplicación combina tipo, dirección, método, ruta, estado y cuerpo, y
cada repetición incrementa un contador. (5) **Anclaje al grafo:** el movimiento se asocia por pila a la
función correspondiente y, si no hay función, a la ruta por método y patrón —incluidos `:param` y `*`—
o al nodo de petición por método y ruta exactos. Parseos y serializaciones sin destino siguen
visibles en un rail global de movimientos JSON, con hora, tipo, método, ruta, estado, recuento,
ubicación con enlace al código y cuerpo enmascarado. (6) **Evidencia honesta:** el estado del hook se
muestra junto al de SQL —hooks activos o error—; nada se presenta como capturado si el inspector no
está conectado. (7) **Actividad:** cada movimiento nuevo aparece en el registro con categoría `json`,
filtro propio y aviso de backend si la instalación de hooks falla.

**Consecuencia:** se ve todo el tráfico JSON del backend —entrante, saliente y transformaciones en
memoria— con los mismos enlaces al código y el mismo rigor STATIC/RUNTIME que el resto del inspector,
sin tocar el proyecto inspeccionado. La contrapartida es que el búfer y el drenaje periódico añaden
trabajo constante al proceso instrumentado y que los cuerpos solo se conservan enmascarados y acotados,
de modo que un valor sensible no puede recuperarse desde la interfaz.

## ADR-064 — Un solo grafo con las tablas como rejilla completa

**Contexto:** ADR-062 unificó mapa y datos en una ventana con dos mitades y un divisor, pero el usuario
rechazó esa solución: seguir viendo dos mapas obliga a buscar el mismo nodo por separado y no une la
cadena del frontend con el backend. La petición fue literal: unir los mapas y que los nodos se vean
enteros, desde el HTML hasta la base de datos. El rendimiento no es una restricción en esta etapa.

**Decisión:** (1) **Un lienzo, sin vista paralela:** se elimina la ventana «Datos», su preload, su HTML,
su módulo de render y el divisor; `UNIFIED_HTML` monta solo el mapa y los dos preloads comparten el
mismo `FlowMapState`. Los canales `dataOpen` y `pane`, el tipo `InspectPane` y la sincronización de
selección entre vistas desaparecen: no hay una segunda captura, un segundo layout ni un segundo grafo.
(2) **Tabla = rejilla en el grafo:** cada nodo `table` se dibuja como rejilla SQL completa —cabecera con
usos por columna, filas reales con numeración, operación por celda y columnas RESULTADO— dentro del
mismo SVG, con la misma evidencia que usaba la vista de datos. `tableIndex.heightOf` alimenta la altura
del nodo para layout, recorte por visor, ajuste y re-apilado; en vista compacta la tabla se reduce a su
cabecera. (3) **Aristas a la fila observada:** las aristas READ/WRITE siguen yendo de consulta a tabla,
pero se anclan con `anchorYOf` a la fila de la ejecución observada o a la columna escrita si no hubo
filas, de modo que el destino se lee dentro de la rejilla y no en un borde genérico. (4) **Interacción de
celda:** el clic izquierdo en una celda la selecciona, la deja iluminada de forma permanente y traza una
única ruta azul entre la celda y la consulta que la ejecutó —o entre la consulta y la celda si es
escritura—; las demás celdas conservan su fondo normal y solo muestran sus etiquetas de uso. La ruta se
sustituye al elegir otra celda y se limpia con un clic en el vacío sin reencuadrar; el clic derecho
conserva el menú del mapa —«Ver interacciones», «Resaltar en la página», «Quitar selección»/«Quitar
enfoque»— y el resaltado de página usa la lista `targets` para marcar todos los controles implicados.
(5) **Filtros y búsqueda:** «Todo/Lecturas/Escrituras», «Todo el tráfico/Solo lo que interactuaste» y la
casilla «Solo esos» ocultan y re-apilan nodos, celdas y aristas; la búsqueda encuentra nodos, tablas,
columnas, usos y SQL y solo atenúa. El rail «Movimientos JSON» y el detalle por nodo siguen alimentándose
del mismo snapshot.

**Consecuencia:** la cadena completa HTML → frontend → backend → SQL → base de datos se lee en un único
grafo y una celda se sigue hasta la consulta que la produjo sin cambiar de ventana ni de vista. La
contrapartida es que un snapshot con muchas tablas y filas hace más pesado el layout y el dibujo; se
acepta a cambio de la continuidad, con la optimización prevista pendiente.

