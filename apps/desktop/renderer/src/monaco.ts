import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

interface MonacoWorkerEnvironment {
  getWorker(workerId: string, label: string): Worker;
}

const globalScope = self as unknown as { MonacoEnvironment?: MonacoWorkerEnvironment };
globalScope.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'typescript' || label === 'javascript') {
      return new TsWorker();
    }
    if (label === 'json') {
      return new JsonWorker();
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      return new CssWorker();
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new HtmlWorker();
    }
    return new EditorWorker();
  },
};

monaco.editor.defineTheme('bdt-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b7485' },
    { token: 'string', foreground: 'a5c261' },
    { token: 'keyword', foreground: '9db4ff' },
    { token: 'number', foreground: 'd8a06a' },
  ],
  colors: {
    'editor.background': '#0e1116',
    'editor.foreground': '#d7dde7',
    'editorLineNumber.foreground': '#4a5262',
    'editorLineNumber.activeForeground': '#8a94a6',
    'editor.selectionBackground': '#26406b',
    'editor.inactiveSelectionBackground': '#1c2c47',
    'editorCursor.foreground': '#58a6ff',
    'editor.lineHighlightBackground': '#12161d',
    'editorWidget.background': '#14181f',
    'editorWidget.border': '#0e1116',
    'editorSuggestWidget.selectedBackground': '#223149',
    'scrollbarSlider.background': '#2a3140',
    'scrollbarSlider.hoverBackground': '#39424f',
    'scrollbarSlider.activeBackground': '#465062',
    'editorOverviewRuler.border': '#0e1116',
  },
});

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  go: 'go',
  java: 'java',
  xml: 'xml',
};

export function languageForPath(filePath: string): string {
  const fileName = filePath.split('/').pop() ?? filePath;
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === fileName.length - 1) {
    return 'plaintext';
  }
  return EXTENSION_LANGUAGES[fileName.slice(dotIndex + 1).toLowerCase()] ?? 'plaintext';
}

export { monaco };
