import { useEffect, useRef } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { monaco } from '../monaco';

export interface MonacoReveal {
  line: number;
  endLine: number | null;
  nonce: number;
}

interface MonacoPaneProps {
  content: string;
  language: string;
  reveal: MonacoReveal | null;
}

export function MonacoPane({ content, language, reveal }: MonacoPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    const editor = monaco.editor.create(host, {
      value: content,
      language,
      theme: 'bdt-dark',
      readOnly: true,
      domReadOnly: true,
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

    return () => {
      decorationsRef.current = null;
      editorRef.current = null;
      editor.dispose();
    };
  }, [content, language]);

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
  }, [revealLine, revealEndLine, revealNonce, content, language]);

  return <div className="monaco-host" ref={hostRef} data-testid="monaco-host" />;
}
