const CHROME_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #0e1116; color: #c9d1d9; font: 13px/1.4 system-ui, "Segoe UI", sans-serif; user-select: none; }
#bar { display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 8px; background: #141a22; }
button { background: #1d2632; color: #c9d1d9; border: 0; height: 26px; min-width: 26px; padding: 0 8px; font: inherit; cursor: pointer; }
button:disabled { color: #5c6773; background: #161d26; cursor: default; }
button:hover:not(:disabled) { background: #26313f; }
#nav { flex: 1; display: flex; }
#url { width: 100%; height: 26px; background: #0e131a; color: #e6edf3; border: 0; padding: 0 10px; font: inherit; outline: none; user-select: text; }
#url:focus { background: #111923; }
#inspect { min-width: 108px; }
#inspect.is-on { background: #1c5c3b; color: #e8fff1; }
#inspect.is-off { background: #3a2a1b; color: #ffd7a8; }
.meta { display: flex; align-items: center; gap: 12px; height: 24px; padding: 0 10px; background: #10161e; color: #8b98a5; font-size: 11px; }
#loading { display: none; color: #8fc7ff; }
#bar.is-loading #loading { display: inline; }
#message { color: #ffb4a8; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 60%; }
`;

export const BROWSER_CHROME_HTML = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
    <title>Navegador</title>
    <style>${CHROME_CSS}</style>
  </head>
  <body>
    <header id="bar">
      <button id="back" type="button" title="Atrás">&#8249;</button>
      <button id="forward" type="button" title="Adelante">&#8250;</button>
      <button id="reload" type="button" title="Recargar">&#8635;</button>
      <form id="nav" autocomplete="off">
        <input id="url" type="text" spellcheck="false" aria-label="Dirección" />
      </form>
      <button id="inspect" type="button" class="is-on">Inspección ON</button>
    </header>
    <div class="meta">
      <span id="status">N0</span>
      <span id="loading">Cargando</span>
      <span id="message"></span>
    </div>
  </body>
</html>`;

const PANEL_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: #0e1116; color: #c9d1d9; font: 12px/1.45 system-ui, "Segoe UI", sans-serif; }
#panel { display: flex; flex-direction: column; height: 100%; }
header { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; background: #141a22; flex: none; }
header strong { flex: 1; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: #8fc7ff; font-weight: 600; }
#modes { display: flex; gap: 2px; padding: 4px 8px; background: #10161e; flex: none; }
.mode { flex: 1 1 auto; height: 24px; padding: 0 4px; background: #172029; color: #8b98a5; font: 10px/1 system-ui, "Segoe UI", sans-serif; letter-spacing: 0.02em; cursor: pointer; }
.mode:hover { background: #1d2833; }
.mode.is-on { background: #223044; color: #e6edf3; }
main { flex: 1; overflow-y: auto; padding: 10px 12px 16px; }
h1 { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: #e6edf3; word-break: break-word; }
.sub { color: #8b98a5; font-size: 11px; }
section { margin-top: 14px; }
h2 { margin: 0 0 5px; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #7d8b99; }
.value { color: #e6edf3; word-break: break-word; }
.note { color: #8b98a5; font-size: 11px; margin-top: 3px; word-break: break-word; }
#runtime { display: flex; flex-direction: column; gap: 3px; padding: 7px 8px; background: #131a22; }
#runtime .head { display: flex; align-items: center; gap: 8px; }
#runtime-status { padding: 1px 6px; font-size: 10px; letter-spacing: 0.04em; background: #1d2632; color: #aab8c5; }
#runtime-status.is-on { background: #163a2a; color: #9fe3b8; }
#runtime-status.is-connecting { background: #162a3a; color: #9fd0ff; }
#runtime-status.is-warn { background: #3a2a1b; color: #ffd7a8; }
#runtime-message { color: #aab8c5; font-size: 11px; word-break: break-word; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 12px; }
.chip { padding: 1px 6px; font-size: 10px; letter-spacing: 0.04em; background: #1d2632; color: #aab8c5; }
.chip.runtime { background: #163a2a; color: #9fe3b8; }
.chip.static { background: #22303f; color: #a9cdf0; }
.request { display: block; width: 100%; text-align: left; padding: 6px 8px; margin: 0 0 4px; background: #131a22; border: 0; font: inherit; color: inherit; cursor: pointer; }
.request:hover { background: #1a2430; }
.request.is-selected { background: #223044; }
.request .head { display: flex; gap: 8px; align-items: baseline; }
.method { font-weight: 700; font-size: 10px; color: #9fe3b8; }
.method.post { color: #ffd7a8; }
.method.delete { color: #ffb4a8; }
.request .path { flex: 1; color: #e6edf3; word-break: break-all; }
.phase { padding: 1px 5px; font-size: 9px; letter-spacing: 0.05em; background: #2b3542; color: #aab8c5; white-space: nowrap; }
.phase.background { background: #2b2436; color: #cbb8e8; }
.phase.after-click { background: #163a2a; color: #9fe3b8; }
.request .status { font-size: 10px; color: #8b98a5; white-space: nowrap; }
.request .time { font-size: 10px; color: #7d8b99; white-space: nowrap; font-family: "Cascadia Mono", Consolas, monospace; }
.request .backend-line { margin-top: 2px; color: #a9cdf0; font-size: 11px; word-break: break-all; }
.empty { color: #8b98a5; font-style: italic; }
.code-head { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; }
.code-file { font-family: "Cascadia Mono", Consolas, monospace; font-size: 11px; color: #a9cdf0; word-break: break-all; }
.code-range { margin-left: auto; font-size: 10px; color: #7d8b99; white-space: nowrap; }
.code { margin-top: 4px; background: #0a1016; overflow-x: auto; }
.code-line { display: flex; min-height: 17px; font-family: "Cascadia Mono", Consolas, monospace; font-size: 11px; line-height: 17px; }
.code-number { flex: none; width: 42px; padding-right: 8px; text-align: right; color: #56616d; user-select: none; }
.code-text { white-space: pre; color: #d4d4d4; padding-right: 10px; }
.code-line.is-executed { background: #163a2a; }
.code-line.is-executed .code-number { color: #9fe3b8; }
.code-note { padding: 5px 8px; color: #ffd7a8; font-size: 10px; background: #241c12; }
.seq { margin-top: 8px; }
.seq-item { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
.seq-time { flex: none; width: 54px; color: #7d8b99; font-size: 10px; font-family: "Cascadia Mono", Consolas, monospace; }
.seq-tag { flex: none; width: 64px; color: #a9cdf0; font-size: 9px; letter-spacing: 0.05em; }
.seq-text { flex: 1; color: #d4d4d4; font-size: 11px; word-break: break-word; }
.seq-item.is-ok .seq-tag { color: #9fe3b8; }
.seq-item.is-error .seq-tag, .seq-item.is-error .seq-text { color: #ffb4a8; }
.body-head { margin-top: 10px; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #7d8b99; }
.body { margin-top: 3px; padding: 6px 8px; background: #0a1016; color: #d4d4d4; font-family: "Cascadia Mono", Consolas, monospace; font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
.body-note { margin-top: 3px; color: #7d8b99; font-size: 10px; }
.tok-kw { color: #569cd6; }
.tok-ctl { color: #c586c0; }
.tok-str { color: #ce9178; }
.tok-num { color: #b5cea8; }
.tok-com { color: #6a9955; }
.tok-fn { color: #dcdcaa; }
.tok-type { color: #4ec9b0; }
.tok-var { color: #9cdcfe; }
.tok-lit { color: #569cd6; }
.tok-key { color: #9cdcfe; }
.tok-punc { color: #d4d4d4; }
#execution { padding: 6px 8px; background: #131a22; }
#execution-empty { color: #8b98a5; font-size: 11px; font-style: italic; }
#breakpoints { margin-top: 3px; color: #9fe3b8; font-size: 10px; }
.query { padding: 6px 8px; background: #131a22; margin-bottom: 4px; }
.query .head { display: flex; gap: 8px; align-items: baseline; }
.query .op { font-weight: 700; font-size: 10px; letter-spacing: 0.04em; color: #a9cdf0; }
.query .state { margin-left: auto; font-size: 10px; color: #8b98a5; }
.query.is-observed .state { color: #9fe3b8; }
.query .sql { margin-top: 4px; padding: 5px 7px; background: #0a1016; color: #d4d4d4; font-family: "Cascadia Mono", Consolas, monospace; font-size: 11px; line-height: 1.35; white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
.query .meta { margin-top: 3px; color: #aab8c5; font-size: 10px; word-break: break-word; }
#note { margin-top: 12px; color: #ffd7a8; font-size: 11px; }
.footer { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.footer .level { padding: 1px 6px; background: #22303f; color: #a9cdf0; font-size: 10px; }
#idle { padding: 4px 0; }
#idle p { margin: 0; color: #aab8c5; font-size: 12px; }
`;

export const INSPECTION_PANEL_HTML = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
    <title>Inspección</title>
    <style>${PANEL_CSS}</style>
  </head>
  <body>
    <div id="panel">
      <header>
        <strong>Backend DevTools · Inspección</strong>
        <span class="chip" id="level">N0</span>
      </header>
      <div id="modes" role="tablist" aria-label="Modo de inspección">
        <button type="button" class="mode is-on" data-mode="html" role="tab">HTML/CSS</button>
        <button type="button" class="mode" data-mode="frontend" role="tab">Frontend</button>
        <button type="button" class="mode" data-mode="backend" role="tab">Backend</button>
        <button type="button" class="mode" data-mode="request" role="tab">JSON</button>
        <button type="button" class="mode" data-mode="database" role="tab">SQL</button>
      </div>
      <main>
        <div id="runtime">
          <div class="head">
            <span id="runtime-status">INSPECTOR OFF</span>
          </div>
          <div id="runtime-message"></div>
        </div>

        <div id="idle">
          <p id="idle-hint">Pasa el mouse sobre un elemento de la página.</p>
        </div>

        <div id="content" hidden>
          <h1 id="element">Elemento</h1>
          <div id="element-detail" class="sub"></div>

          <section>
            <h2>Frontend</h2>
            <div id="handler" class="value">—</div>
            <div id="handler-loc" class="note"></div>
            <div id="handler-code-wrap" hidden>
              <div class="code-head">
                <span class="code-file" id="handler-code-file"></span>
                <span class="code-range" id="handler-code-range"></span>
              </div>
              <div class="code" id="handler-code"></div>
            </div>
          </section>

          <section>
            <h2>Peticiones</h2>
            <div id="requests"><div class="empty">Escuchando…</div></div>
          </section>

          <section>
            <h2>Petición</h2>
            <div id="endpoint" class="value">—</div>
            <div class="seq" id="sequence"></div>
            <div class="body-head" id="request-body-head" hidden>Enviado</div>
            <div class="body" id="request-body" hidden></div>
            <div class="body-head" id="response-body-head" hidden>Respuesta</div>
            <div class="body" id="response-body" hidden></div>
            <div class="body-note" id="bodies-note" hidden></div>
          </section>

          <section>
            <h2>Backend</h2>
            <div id="backend" class="value"></div>
            <div id="backend-loc" class="note"></div>
            <div id="backend-code-wrap" hidden>
              <div class="code-head">
                <span class="code-file" id="backend-code-file"></span>
                <span class="code-range" id="backend-code-range"></span>
              </div>
              <div class="code" id="backend-code"></div>
            </div>
          </section>

          <section>
            <h2>SQL</h2>
            <div id="queries"><div class="empty">—</div></div>
          </section>

          <section>
            <h2>Ejecución</h2>
            <div id="execution" hidden>
              <div id="execution-loc" class="value"></div>
              <div id="breakpoints"></div>
              <div class="code-head">
                <span class="code-file" id="execution-code-file"></span>
                <span class="code-range" id="execution-code-range"></span>
              </div>
              <div class="code" id="execution-code"></div>
            </div>
            <div id="execution-empty">Sin ejecución observada.</div>
          </section>

          <div class="chips" id="evidence"></div>
          <div id="note" hidden></div>
          <div class="footer">
            <span class="sub" id="status"></span>
          </div>
        </div>
      </main>
    </div>
  </body>
</html>`;
