import { useEffect, useRef } from 'react';
import { monaco } from '../monaco';

interface MonacoPaneProps {
  content: string;
  language: string;
}

export function MonacoPane({ content, language }: MonacoPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

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

    return () => {
      editor.dispose();
    };
  }, [content, language]);

  return <div className="monaco-host" ref={hostRef} data-testid="monaco-host" />;
}
