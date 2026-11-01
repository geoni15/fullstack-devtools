import fs from 'node:fs';
import path from 'node:path';
import { isIgnoredName, LIMITS } from '../config';

export interface ComponentSymbol {
  file: string;
  line: number;
  definition: string;
  body: string;
}

interface SourceFile {
  file: string;
  absolute: string;
  basename: string;
}

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
]);
const SOURCE_DIR_BOOST = new Set([
  'src',
  'components',
  'views',
  'pages',
  'screens',
  'app',
  'ui',
  'lib',
]);

function skipString(content: string, index: number): number {
  const quote = content[index];
  let cursor = index + 1;
  while (cursor < content.length) {
    const char = content[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (quote === '`' && char === '$' && content[cursor + 1] === '{') {
      cursor = skipBalanced(content, cursor + 1, '{', '}');
      continue;
    }
    if (char === quote) return cursor + 1;
    cursor += 1;
  }
  return content.length;
}

function skipComment(content: string, index: number): number | null {
  if (content[index] !== '/') return null;
  if (content[index + 1] === '/') {
    const end = content.indexOf('\n', index + 2);
    return end === -1 ? content.length : end;
  }
  if (content[index + 1] === '*') {
    const end = content.indexOf('*/', index + 2);
    return end === -1 ? content.length : end + 2;
  }
  return null;
}

function skipBalanced(content: string, index: number, open: string, close: string): number {
  let depth = 0;
  let cursor = index;
  while (cursor < content.length) {
    const char = content[cursor];
    if (char === "'" || char === '"' || char === '`') {
      cursor = skipString(content, cursor);
      continue;
    }
    const comment = skipComment(content, cursor);
    if (comment !== null) {
      cursor = comment;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  return content.length;
}

function findToken(content: string, from: number, token: string): number {
  let cursor = from;
  while (cursor < content.length) {
    const char = content[cursor];
    if (char === "'" || char === '"' || char === '`') {
      cursor = skipString(content, cursor);
      continue;
    }
    const comment = skipComment(content, cursor);
    if (comment !== null) {
      cursor = comment;
      continue;
    }
    if (content.startsWith(token, cursor)) return cursor;
    cursor += 1;
  }
  return -1;
}

function nextCodeIndex(content: string, from: number): number {
  let cursor = from;
  while (cursor < content.length) {
    const char = content[cursor];
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      cursor += 1;
      continue;
    }
    const comment = skipComment(content, cursor);
    if (comment !== null) {
      cursor = comment;
      continue;
    }
    return cursor;
  }
  return content.length;
}

function captureExpression(content: string, from: number): string {
  const stack: string[] = [];
  let cursor = from;
  while (cursor < content.length) {
    const char = content[cursor];
    if (char === "'" || char === '"' || char === '`') {
      cursor = skipString(content, cursor);
      continue;
    }
    const comment = skipComment(content, cursor);
    if (comment !== null) {
      cursor = comment;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      stack.push(char);
      cursor += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      if (stack.length === 0) return content.slice(from, cursor);
      stack.pop();
      cursor += 1;
      continue;
    }
    if (char === ';' && stack.length === 0) return content.slice(from, cursor + 1);
    cursor += 1;
  }
  return content.slice(from);
}

function bodyFromBrace(content: string, brace: number): string {
  return content.slice(brace, skipBalanced(content, brace, '{', '}'));
}

function parseArrow(content: string, arrow: number): string {
  const start = nextCodeIndex(content, arrow + 2);
  if (content[start] === '{') return bodyFromBrace(content, start);
  return captureExpression(content, start);
}

function parseFunctionAt(content: string, from: number): string {
  const paren = content.indexOf('(', from);
  if (paren === -1) return '';
  const paramsEnd = skipBalanced(content, paren, '(', ')');
  const brace = findToken(content, paramsEnd, '{');
  if (brace === -1) return '';
  return bodyFromBrace(content, brace);
}

function parseArrowParams(content: string, from: number): string {
  const start = nextCodeIndex(content, from);
  let cursor = start;
  if (content[cursor] === '(') {
    cursor = skipBalanced(content, cursor, '(', ')');
  } else {
    const match = /^[A-Za-z_$][\w$]*/.exec(content.slice(cursor, cursor + 200));
    if (match === null) return '';
    cursor += match[0].length;
  }
  const arrow = findToken(content, cursor, '=>');
  if (arrow === -1) return '';
  return parseArrow(content, arrow);
}

function parseAssignmentBody(content: string, assign: number): string {
  let cursor = nextCodeIndex(content, assign + 1);
  if (content.startsWith('async', cursor)) cursor = nextCodeIndex(content, cursor + 5);
  if (content.startsWith('function', cursor)) return parseFunctionAt(content, cursor + 8);
  const direct = parseArrowParams(content, cursor);
  if (direct !== '') return direct;
  const arrow = findToken(content, cursor, '=>');
  if (arrow !== -1) return parseArrow(content, arrow);
  const fn = findToken(content, cursor, 'function');
  if (fn !== -1) return parseFunctionAt(content, fn + 8);
  return '';
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < content.length; cursor += 1) {
    if (content[cursor] === '\n') line += 1;
  }
  return line;
}

function lineTextAt(content: string, index: number): string {
  const start = content.lastIndexOf('\n', index - 1) + 1;
  const end = content.indexOf('\n', index);
  const raw = content.slice(start, end === -1 ? content.length : end);
  return raw.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function definitionBody(content: string, name: string): { index: number; body: string } | null {
  const escaped = escapeRegExp(name);
  const declaration = new RegExp(
    String.raw`(?:^|[^\w$])(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+${escaped}\b`,
  ).exec(content);
  if (declaration !== null) {
    const index = declaration.index + declaration[0].indexOf('function');
    const body = parseFunctionAt(content, index + 8);
    if (body !== '') return { index, body };
  }
  const constant = new RegExp(
    String.raw`(?:^|[^\w$])(?:export\s+)?(?:const|let|var)\s+${escaped}\b`,
  ).exec(content);
  if (constant !== null) {
    const index = constant.index + constant[0].indexOf(escapeRegExp(name));
    const assign = content.indexOf('=', constant.index + constant[0].length);
    if (assign !== -1 && !content.slice(constant.index, assign).includes(';')) {
      const body = parseAssignmentBody(content, assign);
      if (body !== '') return { index, body };
    }
  }
  const keyword = new RegExp(String.raw`(?:^|[^\w$])class\s+${escaped}\b`).exec(content);
  if (keyword !== null) {
    const index = keyword.index + keyword[0].indexOf('class');
    const brace = findToken(content, index + 5, '{');
    if (brace !== -1) return { index, body: bodyFromBrace(content, brace) };
  }
  return null;
}

export class WorkspaceSymbols {
  private root: string | null = null;
  private files: SourceFile[] | null = null;
  private readonly cache = new Map<string, ComponentSymbol | null>();

  constructor(private readonly getRoot: () => string | null) {}

  invalidate(): void {
    this.root = null;
    this.files = null;
    this.cache.clear();
  }

  find(name: string): ComponentSymbol | null {
    const clean = name.trim();
    // JSX component identifiers are capitalized or member expressions, so lowercase
    // minified names in production builds are not searched.
    if (!/^[A-Z_$][\w$]*$/.test(clean)) return null;
    const root = this.getRoot();
    if (root === null) return null;
    if (this.root !== root) {
      this.root = root;
      this.files = null;
      this.cache.clear();
    }
    const cached = this.cache.get(clean);
    if (cached !== undefined) return cached;
    const result = this.search(clean);
    this.cache.set(clean, result);
    return result;
  }

  private search(name: string): ComponentSymbol | null {
    const files = this.sourceFiles();
    if (files === null) return null;
    const ordered = this.order(files, name.toLowerCase());
    for (const entry of ordered) {
      let content: string;
      try {
        const stat = fs.statSync(entry.absolute);
        if (!stat.isFile() || stat.size > LIMITS.maxFileBytes) continue;
        content = fs.readFileSync(entry.absolute, 'utf8');
      } catch {
        continue;
      }
      const found = definitionBody(content, name);
      if (found === null) continue;
      return {
        file: entry.file,
        line: lineNumberAt(content, found.index),
        definition: lineTextAt(content, found.index),
        body: found.body,
      };
    }
    return null;
  }

  private order(files: SourceFile[], lower: string): SourceFile[] {
    const scored = files.map((entry) => {
      let score = 0;
      if (entry.basename === lower) score += 6;
      else if (entry.basename.includes(lower)) score += 3;
      const segments = entry.file.toLowerCase().split('/');
      for (const segment of segments.slice(0, -1)) {
        if (SOURCE_DIR_BOOST.has(segment)) score += 1;
      }
      if (/\.(?:test|spec)\.[a-z]+$/.test(entry.file)) score -= 4;
      score -= Math.min(segments.length, 20) * 0.05;
      return { entry, score };
    });
    scored.sort((left, right) => right.score - left.score);
    return scored.map((item) => item.entry);
  }

  private sourceFiles(): SourceFile[] | null {
    if (this.files !== null) return this.files;
    const root = this.root;
    if (root === null) return null;
    const files: SourceFile[] = [];
    const walk = (directory: string, relative: string): void => {
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      children.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      for (const child of children) {
        if (isIgnoredName(child.name) || child.isSymbolicLink()) continue;
        const absolute = path.join(directory, child.name);
        const file = relative === '' ? child.name : `${relative}/${child.name}`;
        if (child.isDirectory()) {
          walk(absolute, file);
          continue;
        }
        if (!child.isFile()) continue;
        const extension = path.extname(child.name).toLowerCase();
        if (!SOURCE_EXTENSIONS.has(extension)) continue;
        files.push({
          file,
          absolute,
          basename: path.basename(child.name, path.extname(child.name)).toLowerCase(),
        });
      }
    };
    walk(root, '');
    this.files = files;
    return files;
  }
}
