# Backend DevTools Desktop — Especificación técnica de propósito general

**Versión:** 1.0
**Tipo:** aplicación de escritorio (Windows, macOS, Linux)
**Alcance:** independiente de cualquier proyecto concreto. Funciona abriendo la carpeta de **cualquier** proyecto web con frontend y backend locales.
**Implementador:** cualquier asistente de programación con acceso a archivos y terminal.

---

## 0. Instrucciones para la IA implementadora (leer primero, obedecer siempre)

1. **Una fase a la vez** (§10). No adelantes código de fases posteriores salvo tipos/interfaces compartidos.
2. **Plan antes de código:** archivos a crear/modificar, orden, riesgos. Después implementa.
3. **No inventes APIs.** Antes de usar Electron, CDP (Chrome DevTools Protocol), `web-tree-sitter`, `source-map`, OTLP o cualquier librería: verifica la versión instalada y lee sus tipos o documentación local. Si no puedes verificar una firma, escribe `// VERIFY:` junto a la línea y decláralo.
4. **Versiones exactas** en `package.json` (sin `^` ni `~`) para Electron, tree-sitter, Monaco y librerías de protocolo.
5. **Tests junto al código.** Sin tests (o sin explicación de por qué no son posibles) la tarea no está terminada.
6. **Archivos completos**, nunca fragmentos con "...el resto igual".
7. **Un cambio, un propósito.** No refactorices código ajeno a la tarea.
8. **Ambigüedad:** si afecta la arquitectura, pregunta (máximo 3 preguntas). Si es un detalle menor, decide y registra un ADR breve en `docs/decisions.md`.
9. **Honestidad verificable:** nunca digas "funciona" sin indicar el comando de prueba y el resultado esperado.
10. **Idioma:** código e identificadores en inglés; comentarios, documentación y mensajes al usuario en español.
11. **Formato de cada entrega:** ver §13.
12. **Contexto limitado:** trabaja con §0, §3, §6 y la fase actual de §10. Si falta información de otra sección, pídela.
13. **Seguridad primero:** cualquier cambio que toque permisos de archivos, IPC, red o el contenido embebido debe revisarse contra §9 antes de entregarse.

---

## 1. Qué es el producto

Un **programa de escritorio estilo IDE** que permite **ver lo que hace el backend en tiempo real desde el frontend**.

El usuario abre la carpeta de su proyecto, arranca (o conecta) su frontend y su backend locales, y el programa:

1. Muestra la aplicación web dentro de la propia herramienta.
2. Captura **todas las peticiones** que el frontend hace al backend.
3. Analiza el código fuente (frontend y backend) y las trazas de ejecución.
4. Con la **devtool activada**, al **pasar el cursor** sobre cualquier elemento de la interfaz, muestra una tarjeta que explica **qué hace**: su manejador en el frontend, las peticiones que dispara, el endpoint que las recibe, el código del backend que las atiende y sus efectos en la base de datos.

Es el equivalente a Chrome DevTools "Inspeccionar elemento", extendido hacia el backend, dentro de un entorno con editor de código.

### Qué NO es

- No es un depurador completo (breakpoints, stepping) en v1.
- No es una herramienta de monitoreo de producción ni un APM.
- No es un asistente que escribe código por el usuario.
- No sustituye al editor del usuario; el editor integrado existe para navegar y entender código.

### Los 4 modos

| Modo | Nombre | Descripción |
|---|---|---|
| A | **Inspector por cursor** | Con la devtool activa, el cursor sobre un elemento de la app muestra su cadena funcional completa |
| B | **Explorador** | Rutas, funciones, clases, módulos, middlewares y consultas del backend, navegables sin pasar por la UI |
| C | **Mapa de ejecución** | Árbol de lo que realmente ocurrió en una petición |
| D | **Explorador de datos** | Por tabla: qué código la lee/modifica, qué endpoints, qué elementos de UI la alimentan |

---

## 2. Principio de fidelidad por niveles

El producto **debe funcionar con cualquier stack**, pero la profundidad del análisis depende de lo que se pueda observar. Por eso la capacidad se define en niveles. Toda la interfaz debe indicar **qué nivel está activo** para cada elemento y **degradarse con elegancia** cuando un nivel no está disponible.

| Nivel | Fuente de información | Requiere | Funciona con |
|---|---|---|---|
| **N0 — Caja negra HTTP** | Captura de red del navegador embebido (CDP) | Nada | Cualquier backend, cualquier lenguaje |
| **N1 — Código fuente** | Análisis estático del repo (tree-sitter + adaptadores de framework) | Adaptador del lenguaje/framework | Lenguajes y frameworks con adaptador |
| **N2 — Ejecución real** | Trazas del backend (OTLP o inspector del lenguaje) | Que el backend emita trazas (el programa puede configurarlo al lanzarlo) | Stacks con instrumentación OTel o inspector |
| **N3 — Datos** | Esquema de BD + consultas observadas | Credenciales de BD de desarrollo y/o spans de BD | MySQL, PostgreSQL, SQLite (v1) |

**Regla:** lo que viene de N1 se marca **STATIC** (posible), lo que viene de N0/N2 se marca **RUNTIME** (observado), lo que viene de N3 se marca **SCHEMA** o **RUNTIME**. Nunca presentar algo STATIC como ejecutado.

---

## 3. Decisiones arquitectónicas fijas

| # | Decisión | Consecuencia |
|---|---|---|
| A | **Electron** como contenedor de escritorio | Garantiza Chromium integrado, CDP completo vía `webContents.debugger`, y Node para sistema de archivos y procesos. Tauri queda descartado en v1 porque su webview no expone CDP de forma uniforme entre sistemas. El núcleo se aísla en un paquete sin dependencia de Electron para poder portarlo. |
| B | **El grafo es la fuente de verdad** | La UI solo lee el grafo. Ninguna relación vive solo en la interfaz. |
| C | **Evidencia explícita en cada relación** | STATIC / RUNTIME / SCHEMA / MANUAL. |
| D | **"No observado" ≠ "muerto"** | Nunca etiquetar código como inútil por no haberse ejecutado. |
| E | **Los hechos son deterministas; las explicaciones en lenguaje natural son opcionales** | Todo lo que muestra la tarjeta sale de análisis y trazas, sin IA. La redacción en lenguaje natural se genera con **plantillas deterministas** por defecto. Un proveedor de IA (local o remoto) es **opcional, desactivado por defecto** (§8.4). |
| F | **Adaptadores por lenguaje, framework, base de datos y protocolo** | Añadir un stack = añadir un adaptador. El núcleo no conoce frameworks. |
| G | **Observación sin modificar el proyecto del usuario** | El programa no escribe en el repo salvo acciones explícitas de guardado del editor. Para N2 inyecta variables de entorno y flags **al lanzar procesos**, sin tocar archivos del proyecto. |
| H | **Contenido bajo inspección = no confiable** | La app web embebida corre aislada y nunca recibe acceso a IPC, Node ni archivos (§9). |
| I | **Alcance de archivos por espacio de trabajo** | Acceso de lectura a las raíces del proyecto abierto (ver §9.1). No acceso a todo el disco. |
| J | **IDs deterministas y compartidos** | El analizador estático y los adaptadores de runtime generan IDs con el mismo paquete (`identifiers`). Si difieren, el runtime no confirmará lo estático. |
| K | **Tiempo real por flujo de eventos con lotes** | Bus de eventos interno; la UI aplica lotes (≈ un fotograma) para no bloquearse con ráfagas. |

---

## 4. Stack tecnológico

| Área | Tecnología | Notas |
|---|---|---|
| Lenguaje | TypeScript (strict, ESM) | `noUncheckedIndexedAccess` activado |
| Escritorio | Electron | Procesos: main, preload mínimo, renderer UI, vista de app inspeccionada (aislada) |
| UI | React + Vite | Layout tipo IDE (§7) |
| Editor | Monaco (`monaco-editor`) | Solo lectura por defecto; guardado explícito |
| Terminal integrada | `node-pty` + `xterm` | Para lanzar y ver procesos del proyecto |
| Navegador embebido | Vista Chromium de Electron (`WebContentsView`) | Partición propia de sesión; **no** usar la etiqueta `<webview>` |
| Protocolo navegador | CDP vía `webContents.debugger` | Dominios: `Network`, `DOM`, `DOMDebugger`, `Debugger`, `Runtime`, `Overlay`, `CSS` (`VERIFY` por versión) |
| Source maps | `@jridgewell/trace-mapping` | Mapear código compilado → fuente original |
| Análisis estático | `web-tree-sitter` (WASM) + gramáticas por lenguaje | Un solo motor para varios lenguajes |
| Trazas backend | Receptor **OTLP/HTTP** local (JSON y protobuf) | Puerto de loopback; ver §6.5 |
| SQL | `node-sql-parser` (MySQL, PostgreSQL, SQLite) | Fallback sin romper el flujo |
| BD (esquema) | Adaptadores de lectura: `mysql2`, `pg`, `better-sqlite3` | Credenciales dadas por el usuario, solo lectura |
| Observación de archivos | `chokidar` | Reanálisis incremental |
| Almacén de sesión | SQLite (`better-sqlite3`) | Índice y caché; las capturas de red/trazas viven en memoria con búfer circular |
| Grafo | Estructura propia (nodos + aristas + evidencia) | Sin dependencia externa en el núcleo |
| Visualización | React Flow (`@xyflow/react`) + `@dagrejs/dagre` | Máximo ~300 nodos por vista |
| Empaquetado | `electron-builder` | Firmado de código y actualizaciones firmadas |
| Pruebas | Vitest + Playwright (modo Electron) | `VERIFY` soporte de Electron en la versión instalada |

---

## 5. Estructura del repositorio

```
backend-devtools-desktop/
├── apps/
│   └── desktop/
│       ├── main/                 # proceso principal: ventanas, IPC, procesos, fs
│       ├── preload/              # puente IPC mínimo y tipado
│       └── renderer/             # UI IDE (React)
├── packages/
│   ├── core/
│   │   ├── identifiers/          # generación de IDs (único punto de verdad)
│   │   ├── graph-engine/         # nodos, aristas, consultas, fusión de evidencia
│   │   ├── evidence-engine/
│   │   ├── event-bus/            # flujo de eventos con lotes
│   │   └── protocol/             # tipos de eventos y de mensajes IPC
│   ├── browser/
│   │   ├── cdp-session/          # conexión CDP y normalización de eventos
│   │   ├── network-capture/      # peticiones con initiator, cuerpos opcionales, redacción
│   │   ├── source-maps/
│   │   ├── dom-inspector/        # resolución elemento → manejador → fuente
│   │   └── framework-hints/      # plugins por framework de UI (React, Vue, Svelte...)
│   ├── analysis/
│   │   ├── workspace/            # raíces, detección de stack, archivos ignorados
│   │   ├── parser/               # tree-sitter + gestión de gramáticas
│   │   ├── imports/              # resolución de imports por lenguaje
│   │   ├── call-graph/
│   │   └── adapters/
│   │       ├── routes-express/
│   │       ├── routes-fastify/
│   │       ├── routes-fastapi/   # primer adaptador no-JS (demuestra generalidad)
│   │       └── ...               # un adaptador por framework
│   ├── runtime/
│   │   ├── otlp-receiver/        # recepción de trazas OTel
│   │   ├── process-runner/       # lanzar/vigilar procesos con entorno inyectado
│   │   └── inspector-adapters/   # p. ej. inspector de Node (opcional)
│   ├── data/
│   │   ├── sql-analyzer/
│   │   └── schema-adapters/      # mysql, postgres, sqlite
│   ├── explain/
│   │   ├── templates/            # frases deterministas por tipo de nodo/relación
│   │   └── llm-provider/         # opcional, desactivado por defecto
│   └── ui/
│       ├── components/
│       ├── panels/
│       ├── graph-view/
│       └── explorer/
├── fixtures/
│   ├── react-express-mysql/
│   ├── vue-fastapi-sqlite/       # segundo stack OBLIGATORIO para probar generalidad
│   └── <cada uno con expected-graph.json>
├── docs/decisions.md
├── scripts/
└── package.json
```

**Dependencias permitidas:** `core` ← `browser`, `analysis`, `runtime`, `data`, `explain` ← `ui` ← `apps/desktop`. `core` no depende de nada del repo. Prohibidos los ciclos. API pública de cada paquete solo vía su `index.ts`.

---

## 6. Arquitectura

```
┌──────────────────────── Electron ────────────────────────┐
│  Renderer UI (React)  ◄──IPC tipado──►  Main process      │
│  ┌─────────┬──────────────┬─────────┐    ├ workspace      │
│  │ Archivos│ App embebida │Inspector│    ├ cdp-session    │
│  │ Editor  │ (aislada)    │ panel   │    ├ otlp-receiver  │
│  ├─────────┴──────────────┴─────────┤    ├ process-runner │
│  │ Timeline red/trazas · Terminal   │    ├ analysis       │
│  └──────────────────────────────────┘    └ graph-engine   │
└───────────────────────────────────────────────────────────┘
        │ CDP                  │ OTLP (127.0.0.1)      │ fs (solo raíces)
   App web (frontend)      Backend del usuario     Código fuente
        └────── HTTP ──────────────►
```

### 6.1 Modelo de datos del grafo

```ts
export type NodeType =
  | 'ui-element' | 'component' | 'handler'
  | 'request'        // llamada HTTP del frontend (sitio de código y/o petición observada)
  | 'route' | 'middleware' | 'function' | 'class' | 'module'
  | 'query' | 'table' | 'column'
  | 'process';       // proceso lanzado por el programa

export type EdgeType =
  | 'CALLS' | 'IMPORTS' | 'HANDLES' | 'TRIGGERS' | 'REQUESTS'
  | 'HANDLES_REQUEST' | 'QUERIES' | 'READS' | 'WRITES'
  | 'USES_COLUMN' | 'DEPENDS_ON';

export type EvidenceKind = 'STATIC' | 'RUNTIME' | 'SCHEMA' | 'MANUAL';

export interface Evidence {
  kind: EvidenceKind;
  source: string;                       // p. ej. 'cdp/network', 'adapter/routes-fastapi', 'otlp'
  at: number;                           // epoch ms
  traceId?: string;
  loc?: { file: string; line: number; column?: number };
  correlation?: 'direct' | 'heuristic'; // en vínculos UI → petición
}

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  language?: string;                    // 'ts', 'py', 'java'...
  file?: string;                        // relativo a la raíz, separadores POSIX
  line?: number;
  endLine?: number;
  attrs: Record<string, unknown>;
  runtime?: { executions: number; lastSeen: number; avgMs?: number; errors: number };
}

export interface GraphEdge {
  id: string;                           // `${type}|${from}|${to}`
  type: EdgeType;
  from: string;
  to: string;
  evidence: Evidence[];
  attrs: Record<string, unknown>;
}
```

**Reglas del grafo**
1. Una arista duplicada fusiona su evidencia.
2. Una arista está **confirmada** si tiene evidencia `RUNTIME`, `SCHEMA` o `MANUAL`.
3. La llegada de `RUNTIME` nunca elimina `STATIC`.
4. Al cambiar un archivo se invalidan solo las evidencias `STATIC` de ese archivo.
5. Lo que no se puede resolver se registra como nodo `unresolved:<texto>` con `attrs.reason`. **No se adivina. Prohibido resolver por coincidencia de nombre entre archivos.**
6. Un nodo sin `runtime` se muestra como **no observado**.
7. API síncrona y pura: `getNode`, `neighbors(id,{direction,edgeTypes?,evidenceKinds?})`, `findByType`, `search`, `path(from,to)`, `stronglyConnectedComponents`.

**IDs** (únicamente desde `identifiers`; rutas relativas a la raíz, POSIX):

| Tipo | Formato |
|---|---|
| función | `function:<ruta>#<nombreCualificado>` (anónimas: `#<anon>@<línea>:<col>`) |
| ruta HTTP | `route:<MÉTODO>:<plantilla>` (las rutas `/x/${id}` y `/x/:id` se unifican como `/x/:param`) |
| middleware | `middleware:<ruta>#<nombre>` |
| elemento UI | `ui:<ruta>:<línea>:<col>` cuando hay mapeo a fuente; si no, `ui:dom:<selector estable>` |
| petición | `request:<MÉTODO>:<plantilla>@<ruta>:<línea>` |
| consulta | `query:<hash corto del SQL normalizado>` |
| tabla / columna | `table:<nombre>` / `column:<tabla>.<columna>` |

### 6.2 Navegador embebido y captura de red (N0)

- La app inspeccionada se carga en una **vista aislada** (§9.2). Por defecto solo se permite navegar a `localhost`/`127.0.0.1`/`::1` y a los orígenes que el usuario añada a la lista blanca.
- Se adjunta CDP desde el proceso principal. Dominios y usos:
  - `Network`: cada petición con método, URL, estado, tiempos, **`initiator` con pila de llamadas**, y cabeceras/cuerpos solo bajo las reglas de §9.5.
  - `Debugger.setAsyncCallStackDepth`: pilas asíncronas, para que la pila del `initiator` incluya el manejador original.
  - `DOM` / `DOMDebugger.getEventListeners`: manejadores registrados en un elemento (script, línea, columna).
  - `Overlay`: modo de inspección y resaltado nativo (`VERIFY`; alternativa: resaltado propio inyectado en Shadow DOM).
- **Source maps:** cada posición de código compilado se traduce a archivo/línea original con `trace-mapping`. Sin source map, se muestra la posición compilada y se marca `mapped: false`.
- **Clasificación de peticiones:** las dirigidas a orígenes configurados como "backend del proyecto" se enlazan al grafo; el resto (CDN, analítica) se agrupan como externas y no se analizan.

### 6.3 Resolución elemento → manejador → petición (modo A)

Estrategias en este orden; se usa la primera que resuelva y se registra cuál fue:

1. **Listeners directos:** `DOMDebugger.getEventListeners` sobre el elemento y sus ancestros → manejador → fuente original (source map).
2. **Hints de framework** (`framework-hints`): cuando el framework delega eventos en la raíz (p. ej. React), leer del nodo DOM las referencias internas del framework para obtener el componente y el manejador declarado (`VERIFY` por versión). Un plugin por framework; el núcleo no los conoce.
3. **Análisis estático:** del manejador resuelto se extraen las llamadas HTTP (`fetch`, `axios`, `XMLHttpRequest`, clientes generados) → `request` con método y plantilla → enlace a `route`.
4. **Correlación en runtime:** al producirse un evento de usuario (clic, envío), las peticiones cuyo `initiator` contenga una pila que pase por el manejador se enlazan con `correlation: 'direct'`. Las inferidas solo por ventana temporal se marcan `'heuristic'` y la UI lo muestra.

Si ninguna estrategia resuelve, la tarjeta lo dice explícitamente ("sin manejador identificado") y ofrece las peticiones observadas en la ventana temporal como pista `heuristic`.

### 6.4 Análisis estático del repo (N1)

- **Pipeline:** detectar stack (manifiestos: `package.json`, `pyproject.toml`, `pom.xml`, `go.mod`, `composer.json`, `Gemfile`...) → descubrir archivos (respetar `.gitignore`) → parsear con tree-sitter → extraer declaraciones, imports y llamadas → **adaptadores de framework** extraen rutas, middlewares y consultas SQL → construir el grafo.
- **Contrato de adaptador de framework:**

```ts
export interface FrameworkAdapter {
  id: string;                                   // 'express', 'fastapi'...
  language: string;
  detect(ws: WorkspaceInfo): boolean;
  extract(file: ParsedFile, ctx: AdapterCtx): ExtractionResult; // rutas, middlewares, handlers, SQL, llamadas HTTP
  capabilities: { routes: boolean; middlewares: boolean; sqlLiterals: boolean };
}
```

- **Estrategia de resolución de llamadas (parar en la primera que resuelva):** (1) binding local, (2) binding de import → export del módulo destino, (3) miembro de objeto/clase importado de forma conocida, (4) `unresolved` con motivo.
- **SQL:** solo literales y plantillas sin interpolación; si hay interpolación, `attrs.dynamicSql = true` sin inventar la consulta.
- **Propiedades:** determinista, incremental (caché por hash de contenido), tolerante a errores de sintaxis.
- El analizador solo afirma que una consulta *aparentemente* modifica una tabla. La confirmación llega de N2/N3.

### 6.5 Ejecución real del backend (N2)

Dos vías, ambas opcionales y combinables:

1. **OTLP (la vía genérica).** El programa levanta un receptor OTLP/HTTP en `127.0.0.1` y, al **lanzar** el backend desde su terminal/ejecutor, inyecta `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` y las variables de la auto-instrumentación del lenguaje. Los spans traen ruta HTTP, nombre de operación y, si la instrumentación de BD está activa, la consulta (`db.statement`).
   - Requiere que el proyecto tenga (o el programa pueda activar al lanzarlo) la auto-instrumentación de OTel de su lenguaje. El programa debe **detectarlo y decirle al usuario exactamente qué falta**, sin modificar archivos del proyecto sin permiso.
   - Da evidencia `RUNTIME` de cualquier lenguaje con OTel; **no** da por sí misma el grafo de llamadas completo (solo los spans que la instrumentación emita).
2. **Adaptadores de inspector por lenguaje** (opcional). P. ej. el inspector de Node (flag `--inspect` inyectado al lanzar) para obtener funciones ejecutadas con mayor detalle. Cada adaptador declara `capabilities` y se activa solo si el lenguaje coincide.

**Correlación de trazas:** el programa añade una cabecera de correlación a las peticiones del navegador embebido (vía CDP `Network.setExtraHTTPHeaders`) y la usa para enlazar petición ↔ traza cuando el backend propaga el contexto (`traceparent` de W3C). Si el backend no lo propaga, correlacionar por método + ruta + ventana temporal y marcar `heuristic`.

Los spans recibidos se convierten en evidencia `RUNTIME` sobre aristas `HANDLES_REQUEST`, `CALLS`, `QUERIES` y actualizan `node.runtime`.

### 6.6 Datos (N3)

- **Esquema:** lectura de `information_schema` (MySQL/PostgreSQL) o `PRAGMA` (SQLite) con credenciales de **desarrollo** dadas por el usuario, usuario de solo lectura recomendado. Genera `table`/`column` y relaciones (FK) como `DEPENDS_ON` con `attrs.kind='fk'`, evidencia `SCHEMA`.
- **Consultas observadas:** desde spans OTel con `db.statement`. Si no hay, quedan solo las consultas estáticas (STATIC).
- **Analizador SQL:** operación, tablas leídas/escritas, columnas (selección, `SET`, `WHERE`, `JOIN`, columnas de `INSERT`). `SELECT *` se expande con el esquema. Si falla el parseo: fallback simple (`attrs.parse='fallback'`).
- **Valores:** nunca se guardan parámetros ni valores de filas por defecto (§9.5).

### 6.7 Proveedor de explicaciones (§E)

Salida de la tarjeta = **hechos** (deterministas) + **frase de resumen**.
- La frase por defecto sale de **plantillas** (`explain/templates`) combinando tipo de nodo y relaciones. Ejemplo: "Este botón ejecuta `handleRegister`, que envía `POST /api/employees`. Lo atiende `createEmployee` (employee.controller.ts:42), que inserta en `employees`."
- Las plantillas reflejan la evidencia: "puede enviar" (STATIC) frente a "envió" (RUNTIME).
- Proveedor de IA opcional: interfaz `ExplainProvider`; ver restricciones en §9.4.

---

## 7. Interfaz (layout tipo IDE)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Barra: proyecto ▾ · Ejecutar ▸ · [ 🔍 Devtool ON/OFF ] · Nivel N0-N3  │
├────────────┬───────────────────────────────┬─────────────────────────┤
│ Archivos   │  App embebida (navegador)     │  Panel del inspector    │
│ Explorador │  ┌─────────────────────────┐  │  Overview · Dependencies│
│ (rutas,    │  │  [elemento resaltado]   │  │  Execution · Database   │
│ funciones, │  │   ┌───────────────┐     │  │  Source · Performance   │
│ tablas)    │  │   │ Tarjeta hover │     │  │                         │
│            │  │   └───────────────┘     │  │                         │
├────────────┴───────────────────────────────┴─────────────────────────┤
│ Timeline: peticiones y trazas en tiempo real · Terminal · Problemas   │
└──────────────────────────────────────────────────────────────────────┘
```

- **Archivos / Explorador:** árbol del proyecto y vistas por tipo (rutas, funciones, clases, módulos, middlewares, tablas).
- **Editor:** Monaco con pestañas, lectura por defecto, salto a definición entre nodos del grafo.
- **App embebida:** la aplicación web bajo inspección. Barra con URL (restringida a la lista blanca), recarga, tamaño de dispositivo.
- **Devtool ON:** activa el modo inspector. El cursor resalta elementos; `Esc` desactiva; clic fija la selección y abre el panel.
- **Timeline:** lista en vivo de peticiones (método, ruta, estado, duración, origen en código) con filtros; seleccionar una abre su cadena en el panel y el mapa de ejecución.
- **Terminal / ejecutor:** configuraciones de ejecución (comando, directorio, entorno) para frontend y backend; los procesos lanzados aquí reciben la inyección de §6.5.

### 7.1 Tarjeta de hover (contenido obligatorio)

| Campo | Contenido |
|---|---|
| Elemento | Etiqueta y texto/rol accesible |
| Componente | Nombre y archivo:línea (si se resolvió) |
| Evento y manejador | p. ej. `onClick → handleRegister` con ubicación original |
| Peticiones | Método + plantilla de URL, con estado: **observada** / **posible** |
| Endpoint | Ruta del backend y archivo:línea del manejador |
| Qué hace | Frase de resumen (§6.7) |
| Datos | Tablas/columnas y operación, si N3/N1 lo permiten |
| Evidencia | Insignias STATIC / RUNTIME / SCHEMA y `correlation` (`direct`/`heuristic`) |
| Nivel | N0–N3 alcanzado para este elemento |

Si un campo no se puede resolver, mostrar `—` con la **razón** ("sin source map", "sin adaptador para este framework"), nunca ocultarlo.

### 7.2 Panel del inspector

Pestañas: **Overview · Dependencies · Execution · Database · Source · Performance**. Clic en cualquier función, ruta o tabla del panel la convierte en el nuevo elemento inspeccionado, con historial atrás/adelante. Líneas discontinuas = STATIC; sólidas = RUNTIME.

---

## 8. Capacidades por modo y tolerancia a fallos

- **Sin adaptador para el framework del backend (solo N0):** la tarjeta muestra el elemento, el manejador y las peticiones observadas; el resto aparece como no disponible con instrucciones para activar N1/N2.
- **Sin source maps:** se trabaja con posiciones compiladas y se avisa.
- **Backend no propaga contexto de traza:** correlación `heuristic` visible.
- **Procesos que fallan al arrancar o puertos ocupados:** el ejecutor muestra el error y no reintenta en bucle (máximo 3 reintentos con espera creciente).
- **Archivos muy grandes o binarios:** se omiten del análisis (límite configurable) y se informa.
- **Rendimiento:** la UI debe mantenerse fluida con ráfagas de peticiones (lotes de eventos, virtualización de listas, límites de nodos en el grafo).

---

## 9. Seguridad y privacidad (no negociable)

Esta aplicación **lee código, ve tráfico con credenciales y ejecuta procesos**. Se trata como software de alto privilegio.

### 9.1 Alcance de archivos
- El usuario concede **raíces de proyecto** explícitas. El proceso principal solo lee/escribe dentro de ellas, validando con `realpath` y rechazando `..` y enlaces simbólicos que escapen.
- **Sin acceso a todo el disco.** Cualquier ampliación requiere confirmación del usuario, por raíz.
- Escritura únicamente por acción explícita del usuario en el editor (guardar). Nunca escrituras automáticas en el proyecto.
- Archivos sensibles (`.env*`, claves privadas, certificados, almacenes de credenciales): se pueden abrir en el editor por decisión del usuario, pero **nunca** se indexan para explicaciones, no se envían a ningún proveedor de IA y se enmascaran en capturas y exportaciones.

### 9.2 Endurecimiento de Electron
- UI principal: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP estricta, sin contenido remoto.
- IPC: canales con nombre fijo, tipados y validados (esquema) en el main; **nada** de `ipcRenderer` expuesto en bruto; el preload solo expone funciones concretas.
- **App inspeccionada:** vista separada con **partición de sesión propia**, sin preload, sin Node, sin acceso a IPC, `sandbox` activo, permisos del navegador denegados por defecto. CDP se adjunta solo desde el main.
- Navegación y ventanas nuevas: bloqueo por defecto fuera de la lista blanca; enlaces externos se abren en el navegador del sistema tras confirmar.
- Prohibido `<webview>` y `remote`. Activar `Fuses` de Electron aplicables al empaquetar (`VERIFY` por versión).

### 9.3 Red local
- El receptor OTLP y cualquier servidor interno escuchan **solo en `127.0.0.1`** con puerto configurable; si la configuración pide otra interfaz, se niega a iniciar.
- El programa **no expone servicios accesibles desde otras máquinas**.
- Las conexiones a `localhost` del usuario son las que este configure en "orígenes del proyecto"; el resto de tráfico de la app embebida sigue la lista blanca.

### 9.4 Proveedor de IA (opcional)
- **Desactivado por defecto.** Se activa por proyecto, con confirmación explícita.
- Se envía únicamente el fragmento seleccionado, tras **mostrarle al usuario exactamente qué se enviará**, con secretos enmascarados (§9.5).
- Admite proveedor local (sin salida de red). Para proveedor remoto, advertencia clara de que el código sale de la máquina.
- Nunca se envían archivos sensibles, cabeceras de autenticación, cuerpos de petición ni valores de base de datos.

### 9.5 Datos capturados
- **Por defecto no se guardan cuerpos de petición/respuesta ni valores de parámetros SQL.** El usuario puede activarlos por sesión; aun así se aplica enmascarado.
- Enmascarado de cabeceras y claves sensibles (`authorization`, `cookie`, `set-cookie`, `x-api-key`, y claves cuyo nombre contenga `password`, `token`, `secret`, `jwt`, `session`), ampliable.
- Capturas y trazas viven **en memoria con búfer circular**; lo persistido en disco (índice, caché) no contiene valores de datos.
- Exportar capturas (p. ej. HAR) aplica el mismo enmascarado.
- **Sin telemetría.** El programa no envía información a servidores del autor. Las comprobaciones de actualización son opcionales, firmadas y sin datos del usuario.

### 9.6 Cadena de suministro
- Versiones exactas y archivo de bloqueo; auditoría de dependencias en CI.
- Gramáticas tree-sitter y recursos WASM empaquetados localmente (sin descargas en tiempo de ejecución).
- Instaladores y actualizaciones firmados.

### 9.7 Verificación
Cada requisito tiene un test automático donde sea posible: lectura fuera de la raíz rechazada, IPC no listado rechazado, la app inspeccionada no accede a `window.require`/IPC, el receptor se niega a escuchar fuera de loopback, un secreto sembrado no aparece en logs, caché ni exportaciones.

---

## 10. Plan por fases

Cada fase termina cuando **todos** sus criterios se cumplen y los tests pasan. No empieces la siguiente sin confirmación del usuario.

### F0 — Esqueleto del escritorio
- **Entregables:** monorepo, app Electron con layout IDE vacío, gestión de espacio de trabajo (abrir carpeta, árbol de archivos con `chokidar`), Monaco en solo lectura, IPC tipado, línea base de seguridad de §9.1 y §9.2.
- **Criterios:** abrir una carpeta y ver/abrir sus archivos; lectura fuera de la raíz rechazada (test); UI sin acceso a Node (test); empaquetado de desarrollo funcional en el sistema operativo del usuario.

### F1 — Navegador embebido y captura de red (N0)
- **Entregables:** vista aislada con lista blanca de orígenes, `cdp-session`, `network-capture` (con `initiator` y pilas asíncronas), `source-maps`, timeline en vivo.
- **Criterios:** cargar una app local y ver **cada petición** con su origen en el código fuente original (cuando hay source map); enmascarado de cabeceras sensibles (test); funciona con los dos fixtures.

### F2 — Inspector por cursor, parte frontend (modo A)
- **Entregables:** botón Devtool ON/OFF, resaltado, selección, `dom-inspector` (estrategias 1–2 de §6.3), `framework-hints` para React y Vue (los dos fixtures), tarjeta de hover con campos de elemento/componente/manejador/peticiones observadas.
- **Criterios:** pasar el cursor sobre un botón muestra su manejador con archivo:línea original; hacer clic en él y ver en la tarjeta la petición **observada** con `correlation: 'direct'`; `Esc` desactiva; la app inspeccionada no cambia de comportamiento.

### F3 — Análisis estático multi-lenguaje (N1) y rutas
- **Entregables:** `workspace` (detección de stack), `parser` (tree-sitter), `imports`, `call-graph`, adaptadores `routes-express` y `routes-fastapi` (un lenguaje JS y uno no-JS como prueba de generalidad), enlace `request → route → handler`, CLI de análisis para pruebas.
- **Criterios:** en **ambos fixtures** la tarjeta muestra endpoint y función del backend; informe de precisión y exhaustividad **estáticas** contra `expected-graph.json`; llamadas no resueltas como `unresolved` con motivo; archivo con error de sintaxis no aborta el análisis.

### F4 — Ejecución real (N2)
- **Entregables:** `process-runner` (configuraciones de ejecución, terminal), `otlp-receiver`, inyección de variables de entorno al lanzar, correlación con `traceparent`/cabecera, pestaña Execution, marcas Observado/No observado.
- **Criterios:** lanzar el backend de al menos un fixture desde el programa y ver el árbol de spans de una petición real; las aristas estáticas ejecutadas reciben `RUNTIME`; si faltan requisitos de instrumentación, el programa informa exactamente qué falta sin modificar el proyecto.

### F5 — Datos (N3)
- **Entregables:** adaptadores de esquema MySQL/PostgreSQL/SQLite, `sql-analyzer`, aristas `QUERIES/READS/WRITES/USES_COLUMN/DEPENDS_ON(fk)`, pestaña Database, modo D.
- **Criterios:** un `INSERT` real identifica tabla y columnas; un `UPDATE` identifica columnas modificadas y de condición; ningún valor de parámetro en trazas, logs ni caché (test); fallo de parseo → fallback sin excepción.

### F6 — Explicaciones y grafo completo
- **Entregables:** `explain/templates` (frases deterministas con matiz STATIC/RUNTIME), explorador completo (modo B), mapa de ejecución (modo C), vista de grafo, detección de ciclos, reporte de **no observados** (nunca "muertos"), proveedor de IA opcional con confirmación (§9.4).
- **Criterios:** la tarjeta incluye la frase "qué hace" correcta en ambos fixtures; seleccionar una función muestra quién la llama; seleccionar una tabla muestra qué código/endpoints/elementos de UI la usan; el proveedor de IA desactivado por defecto no genera ningún tráfico de red (test).

### F7 — Endurecimiento y distribución
- **Entregables:** suite e2e (Playwright en modo Electron), presupuestos de rendimiento medidos, instaladores firmados para los tres sistemas, documentación de uso y de creación de adaptadores, verificación completa de §9.7.
- **Criterios:** todos los requisitos de §9 pasan; la UI se mantiene fluida con una ráfaga de peticiones de prueba (medir y reportar); guía para escribir un adaptador nuevo validada creando uno de ejemplo.

---

## 11. Pruebas y criterios de aceptación globales

| Prueba | Resultado esperado |
|---|---|
| Abrir carpeta de proyecto | Detecta stack y muestra el árbol de archivos |
| Cargar la app en la vista embebida | Captura todas las peticiones al backend con su origen en el código |
| Devtool ON + cursor sobre un botón | Tarjeta con componente, manejador, petición y endpoint |
| Pulsar el botón | La petición pasa de **posible** a **observada** |
| Petición con backend instrumentado | Árbol de funciones ejecutadas en orden con duración |
| Petición que hace INSERT/UPDATE | Tabla y columnas identificadas |
| Seleccionar una función | Muestra quién la llama |
| Seleccionar una tabla | Muestra qué código y qué elementos de UI la utilizan |
| Backend sin adaptador ni trazas | Funciona en N0 con degradación explícita, sin errores |
| Intento de leer fuera de la raíz o desde la app inspeccionada | Rechazado |
| Secreto sembrado en cabecera/SQL/entorno | No aparece en UI persistida, logs, caché ni exportaciones |

**Generalidad (obligatorio):** toda fase que toque análisis, captura o tarjeta se valida en **al menos dos stacks distintos** (`react-express-mysql` y `vue-fastapi-sqlite`). Un resultado que solo funciona en un stack no cuenta como terminado.

**Medición de calidad:** precisión y exhaustividad se miden **por separado** para relaciones estáticas y dinámicas contra `expected-graph.json`, y se reportan en cada versión. Los objetivos numéricos los fija el usuario tras el primer informe. **No inventes cifras objetivo.** Ninguna versión puede empeorar la métrica de la anterior sin justificarlo.

**Tipos de prueba:** unitarias (Vitest), *golden files* para analizadores, integración (CDP, OTLP, adaptadores) y e2e (Playwright en modo Electron).

---

## 12. Estándares de código

- TypeScript `strict`, `noUncheckedIndexedAccess`, ESLint + Prettier. Sin `any` salvo justificación en comentario.
- Errores tipados con código (`BDT_E_...`). Un único `logger` con niveles; prohibido `console.log` fuera de él.
- Todo acceso al sistema de archivos pasa por una función que valida raíz y enlaces simbólicos.
- Todo mensaje IPC se valida con esquema en el main.
- `core` sin efectos secundarios ni E/S.

### Anti-patrones (no hacer)
1. Resolver llamadas por coincidencia de nombre entre archivos.
2. Presentar STATIC como ejecutado, o llamar "muerto" al código no observado.
3. Dar acceso a todo el disco "por comodidad".
4. Exponer IPC, Node o archivos a la app inspeccionada.
5. Modificar archivos del proyecto del usuario para instrumentarlo sin permiso explícito.
6. Guardar cuerpos de petición, parámetros SQL o valores de cabeceras por defecto.
7. Enviar código o datos a un proveedor de IA sin confirmación explícita, o activarlo por defecto.
8. Escuchar en una interfaz distinta de loopback.
9. Acoplar el núcleo a un framework concreto en lugar de usar adaptadores.
10. Implementar varias fases en una respuesta.
11. Declarar éxito sin comando de prueba y resultado esperado.

---

## 13. Formato de entrega y prompt de arranque

### Estructura obligatoria de cada respuesta de implementación
1. **Resumen** (máximo 5 líneas).
2. **Árbol de archivos** creados/modificados.
3. **Código completo** de cada archivo, con su ruta como encabezado.
4. **Cómo probar:** comandos exactos y resultado esperado.
5. **Limitaciones conocidas y marcas `// VERIFY:`.**
6. **Decisiones tomadas** (reflejadas en `docs/decisions.md`).
7. **Siguiente paso sugerido** (sin ejecutarlo).

### Prompt de arranque por fase

```
Lee BACKEND_DEVTOOLS_DESKTOP_SPEC.md. Implementa SOLO la fase F<N> (§10).
Sigue §0 (reglas) y §13 (formato). Valida en los dos fixtures de §11.
Empieza con el plan de archivos y riesgos; no escribas código hasta mostrarlo.
```

### Entorno que el agente necesita
Node ≥ 20 LTS, npm, git, toolchain para empaquetar Electron, pantalla o modo sin cabeza compatible para pruebas e2e de Electron, y Docker (o instalaciones locales) para las bases de datos de los fixtures. El agente debe ejecutarse en la misma máquina donde corren los servidores de prueba.

---

## 14. Preguntas abiertas (el usuario debe responderlas; la IA no debe asumirlas)

| # | Pregunta | Afecta a |
|---|---|---|
| 1 | ¿Sistemas operativos objetivo prioritarios? | F0, F7 |
| 2 | ¿Qué frameworks de backend deben tener adaptador primero, además de Express y FastAPI? | F3 |
| 3 | ¿Qué frameworks de UI deben tener `framework-hints` además de React y Vue? | F2 |
| 4 | ¿El programa puede lanzar los servidores del proyecto (ejecutor integrado) o solo debe conectarse a procesos ya corriendo? | F4 |
| 5 | ¿Se acepta que, para N2, el usuario añada la auto-instrumentación de OTel a su proyecto cuando falte? | F4 |
| 6 | ¿Explicaciones con IA: ninguna, local, o remota opcional? | F6 |
| 7 | ¿Bases de datos prioritarias además de MySQL/PostgreSQL/SQLite? | F5 |
| 8 | ¿Distribución: uso personal o instaladores públicos firmados? | F7 |

Si falta una respuesta cuando se necesita: **preguntar o parametrizar mediante configuración**, nunca asumir.

---

## 15. Glosario

- **CDP:** Chrome DevTools Protocol; permite observar y controlar el navegador embebido (red, DOM, depurador).
- **OTLP / OpenTelemetry:** estándar abierto para emitir trazas desde un backend; la vía genérica de N2.
- **tree-sitter:** analizador sintáctico multi-lenguaje usado para N1.
- **Adaptador:** módulo que enseña al núcleo a entender un lenguaje, framework, base de datos o protocolo concretos.
- **Evidencia:** origen de una relación: `STATIC` (código), `RUNTIME` (observada), `SCHEMA` (esquema de BD), `MANUAL` (declarada por el usuario).
- **Observado / No observado:** si hubo ejecución real durante la sesión. No implica utilidad.
- **Correlación `direct` / `heuristic`:** vínculo confirmado por pila de llamadas o contexto de traza frente a vínculo inferido por proximidad temporal.
- **Raíz de proyecto:** carpeta a la que el usuario concede acceso; límite de lectura/escritura del programa.