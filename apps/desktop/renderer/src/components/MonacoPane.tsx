import { useEffect, useRef } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { monaco } from '../monaco';

export interface MonacoReveal {
  line: number;
  endLine: number | null;
  nonce: number;
}

interface MonacoPaneProps {
  value: string;
  dirty: boolean;
  language: string;
  reveal: MonacoReveal | null;
  onChange(value: string): void;
  onSave(): void;
}

export function MonacoPane({ value, dirty, language, reveal, onChange, onSave }: MonacoPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const liveRef = useRef({ value, onChange, onSave });
  liveRef.current = { value, onChange, onSave };

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    const editor = monaco.editor.create(host, {
      value: liveRef.current.value,
      language,
      theme: 'bdt-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontLigatures: false,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      padding: { top: 10, bottom: 10 },
      wordWrap: 'off',
      contextmenu: false,
      smoothScrolling: false,
      cursorBlinking: 'solid',
      cursorStyle: 'line-thin',
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      renderWhitespace: 'none',
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      glyphMargin: false,
      folding: false,
      lineNumbersMinChars: 3,
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false,
      },
    });
    editorRef.current = editor;
    decorationsRef.current = editor.createDecorationsCollection([]);
    const changes = editor.onDidChangeModelContent(() => {
      const next = editor.getValue();
      if (next === liveRef.current.value) return;
      liveRef.current.onChange(next);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      liveRef.current.onSave();
    });

    return () => {
      changes.dispose();
      decorationsRef.current = null;
      editorRef.current = null;
      editor.dispose();
    };
  }, [language]);

  // El editor se crea una vez por pestaña: el texto externo solo entra cuando no hay edición,
  // para no perder lo que el usuario está escribiendo.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null || dirty) return;
    if (editor.getValue() === value) return;
    editor.setValue(value);
  }, [value, dirty]);

  const revealLine = reveal?.line ?? null;
  const revealEndLine = reveal?.endLine ?? null;
  const revealNonce = reveal?.nonce ?? null;

  useEffect(() => {
    if (revealLine === null) {
      return;
    }
    const editor = editorRef.current;
    const decorations = decorationsRef.current;
    const model = editor?.getModel() ?? null;
    if (editor === null || decorations === null || model === null) {
      return;
    }

    const lastLine = model.getLineCount();
    const start = Math.min(Math.max(1, revealLine), lastLine);
    const requestedEnd = revealEndLine ?? start;
    const end = Math.min(Math.max(start, requestedEnd), lastLine);
    decorations.set([
      {
        range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
        options: {
          isWholeLine: true,
          className: 'code-reveal-line',
          marginClassName: 'code-reveal-margin',
        },
      },
    ]);
    editor.revealLinesInCenter(start, end, monaco.editor.ScrollType.Immediate);
  }, [revealLine, revealEndLine, revealNonce, language]);

  return <div className="monaco-host" ref={hostRef} data-testid="monaco-host" />;
}
