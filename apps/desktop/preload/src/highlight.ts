export type TokenKind =
  'kw' | 'ctl' | 'str' | 'num' | 'com' | 'fn' | 'type' | 'var' | 'lit' | 'key' | 'punc';

export interface HighlightToken {
  text: string;
  kind: TokenKind | null;
}

export type HighlightLanguage = 'js' | 'python' | 'sql' | 'json';

export interface HighlightState {
  blockComment: boolean;
  template: boolean;
  triple: string | null;
  pendingDef: 'fn' | 'type' | null;
}

export function createHighlightState(): HighlightState {
  return { blockComment: false, template: false, triple: null, pendingDef: null };
}

export function languageForFile(file: string): HighlightLanguage {
  const path = file.split(/[?#]/, 1)[0]?.toLowerCase() ?? '';
  if (path.endsWith('.py') || path.endsWith('.pyw')) return 'python';
  if (path.endsWith('.sql')) return 'sql';
  if (path.endsWith('.json')) return 'json';
  return 'js';
}

const JS_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'extends',
  'new',
  'import',
  'export',
  'from',
  'as',
  'static',
  'get',
  'set',
  'typeof',
  'delete',
  'void',
  'this',
  'super',
  'interface',
  'type',
  'enum',
  'implements',
  'public',
  'private',
  'protected',
  'readonly',
  'declare',
  'namespace',
  'abstract',
  'satisfies',
  'keyof',
  'infer',
  'asserts',
  'require',
  'module',
  'exports',
]);

const JS_CONTROL = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'return',
  'throw',
  'try',
  'catch',
  'finally',
  'await',
  'async',
  'yield',
  'in',
  'of',
  'instanceof',
]);

const JS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

const JS_PRIMITIVES = new Set([
  'any',
  'unknown',
  'string',
  'number',
  'boolean',
  'object',
  'never',
  'bigint',
  'symbol',
]);

const PY_KEYWORDS = new Set([
  'def',
  'class',
  'import',
  'from',
  'as',
  'with',
  'lambda',
  'global',
  'nonlocal',
  'pass',
  'del',
  'assert',
]);

const PY_CONTROL = new Set([
  'if',
  'elif',
  'else',
  'for',
  'while',
  'try',
  'except',
  'finally',
  'return',
  'raise',
  'yield',
  'break',
  'continue',
  'and',
  'or',
  'not',
  'in',
  'is',
  'await',
  'async',
]);

const PY_LITERALS = new Set(['None', 'True', 'False']);

const SQL_KEYWORDS = new Set([
  'select',
  'from',
  'where',
  'insert',
  'into',
  'values',
  'update',
  'set',
  'delete',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'full',
  'cross',
  'on',
  'group',
  'by',
  'order',
  'having',
  'limit',
  'offset',
  'as',
  'and',
  'or',
  'not',
  'null',
  'is',
  'in',
  'like',
  'ilike',
  'between',
  'case',
  'when',
  'then',
  'else',
  'end',
  'distinct',
  'union',
  'all',
  'create',
  'alter',
  'drop',
  'table',
  'index',
  'view',
  'primary',
  'key',
  'foreign',
  'references',
  'returning',
  'default',
  'asc',
  'desc',
  'exists',
  'with',
  'begin',
  'commit',
  'rollback',
  'truncate',
]);

const SQL_TYPES = new Set([
  'int',
  'integer',
  'bigint',
  'smallint',
  'serial',
  'bigserial',
  'text',
  'varchar',
  'char',
  'boolean',
  'bool',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'interval',
  'numeric',
  'decimal',
  'real',
  'double',
  'float',
  'json',
  'jsonb',
  'uuid',
  'bytea',
  'blob',
]);

const NUMBER_PATTERN =
  /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)n?/;
const IDENT_PATTERN = /^[A-Za-z_$][\w$]*/;
const OPERATOR_PATTERN = /^[{}()[\];,.:?!+\-*/%<>=&|^~]+/;

function isWordStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_$]/.test(character);
}

function token(text: string, kind: TokenKind | null): HighlightToken {
  return { text, kind };
}

function scanQuoted(
  line: string,
  start: number,
  quote: string,
  doubled = false,
): { end: number; closed: boolean } {
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line[index] === quote) {
      if (doubled && line[index + 1] === quote) {
        index += 2;
        continue;
      }
      return { end: index + 1, closed: true };
    }
    index += 1;
  }
  return { end: line.length, closed: false };
}

function nextMeaningful(line: string, from: number): string | null {
  let index = from;
  while (index < line.length && /\s/.test(line[index] ?? '')) index += 1;
  return index < line.length ? (line[index] ?? null) : null;
}

function classifyJs(word: string, nextChar: string | null, previousChar: string | null): TokenKind {
  if (JS_LITERALS.has(word)) return 'lit';
  if (JS_CONTROL.has(word)) return 'ctl';
  if (JS_KEYWORDS.has(word)) return 'kw';
  if (JS_PRIMITIVES.has(word)) return 'type';
  if (nextChar === '(') return 'fn';
  if (previousChar === '.') return 'var';
  if (/^[A-Z]/.test(word)) return 'type';
  return 'var';
}

function highlightJs(line: string, state: HighlightState): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let index = 0;
  if (state.template) {
    const ended = scanQuoted(line, -1, '`');
    if (ended.closed) {
      tokens.push(token(line.slice(0, ended.end), 'str'));
      state.template = false;
      index = ended.end;
    } else {
      return [token(line, 'str')];
    }
  }

  while (index < line.length) {
    if (state.blockComment) {
      const end = line.indexOf('*/', index);
      if (end === -1) {
        tokens.push(token(line.slice(index), 'com'));
        return tokens;
      }
      tokens.push(token(line.slice(index, end + 2), 'com'));
      state.blockComment = false;
      index = end + 2;
      continue;
    }

    const character = line[index] ?? '';
    const rest = line.slice(index);
    const previousChar = index > 0 ? (line[index - 1] ?? null) : null;

    if (rest.startsWith('//')) {
      tokens.push(token(rest, 'com'));
      break;
    }
    if (rest.startsWith('/*')) {
      const end = line.indexOf('*/', index + 2);
      if (end === -1) {
        tokens.push(token(rest, 'com'));
        state.blockComment = true;
        break;
      }
      tokens.push(token(line.slice(index, end + 2), 'com'));
      index = end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const scan = scanQuoted(line, index, character);
      tokens.push(token(line.slice(index, scan.end), 'str'));
      if (character === '`' && !scan.closed) state.template = true;
      index = scan.end;
      continue;
    }

    const number = NUMBER_PATTERN.exec(rest);
    if (number !== null) {
      tokens.push(token(number[0], 'num'));
      index += number[0].length;
      continue;
    }

    if (isWordStart(character)) {
      const word = IDENT_PATTERN.exec(rest)?.[0] ?? character;
      const next = nextMeaningful(line, index + word.length);
      tokens.push(token(word, classifyJs(word, next, index === 0 ? null : previousChar)));
      index += word.length;
      continue;
    }

    if (/\s/.test(character)) {
      const space = /^\s+/.exec(rest)?.[0] ?? character;
      tokens.push(token(space, null));
      index += space.length;
      continue;
    }

    const operator = OPERATOR_PATTERN.exec(rest)?.[0] ?? character;
    tokens.push(token(operator, 'punc'));
    index += operator.length;
  }
  return tokens;
}

function highlightPython(line: string, state: HighlightState): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let index = 0;

  if (state.triple !== null) {
    const end = line.indexOf(state.triple, index);
    if (end === -1) return [token(line, 'str')];
    tokens.push(token(line.slice(0, end + state.triple.length), 'str'));
    index = end + state.triple.length;
    state.triple = null;
  }

  while (index < line.length) {
    const character = line[index] ?? '';
    const rest = line.slice(index);

    if (character === '#') {
      tokens.push(token(rest, 'com'));
      break;
    }
    if (rest.startsWith("'''") || rest.startsWith('"""')) {
      const delimiter = rest.slice(0, 3);
      const end = line.indexOf(delimiter, index + 3);
      if (end === -1) {
        tokens.push(token(rest, 'str'));
        state.triple = delimiter;
        break;
      }
      tokens.push(token(line.slice(index, end + 3), 'str'));
      index = end + 3;
      continue;
    }
    if (character === "'" || character === '"') {
      const scan = scanQuoted(line, index, character);
      tokens.push(token(line.slice(index, scan.end), 'str'));
      index = scan.end;
      continue;
    }
    if (character === '@' && isWordStart(line[index + 1])) {
      const name = IDENT_PATTERN.exec(line.slice(index + 1))?.[0] ?? '';
      tokens.push(token(`@${name}`, 'fn'));
      index += name.length + 1;
      continue;
    }

    const number = NUMBER_PATTERN.exec(rest);
    if (number !== null) {
      tokens.push(token(number[0], 'num'));
      index += number[0].length;
      continue;
    }

    if (isWordStart(character)) {
      const word = IDENT_PATTERN.exec(rest)?.[0] ?? character;
      let kind: TokenKind;
      if (state.pendingDef !== null) {
        kind = state.pendingDef;
        state.pendingDef = null;
      } else if (PY_LITERALS.has(word)) {
        kind = 'lit';
      } else if (PY_CONTROL.has(word)) {
        kind = 'ctl';
      } else if (PY_KEYWORDS.has(word)) {
        kind = 'kw';
        if (word === 'def') state.pendingDef = 'fn';
        else if (word === 'class') state.pendingDef = 'type';
      } else if (nextMeaningful(line, index + word.length) === '(') {
        kind = 'fn';
      } else {
        kind = 'var';
      }
      tokens.push(token(word, kind));
      index += word.length;
      continue;
    }

    if (/\s/.test(character)) {
      const space = /^\s+/.exec(rest)?.[0] ?? character;
      tokens.push(token(space, null));
      index += space.length;
      continue;
    }

    const operator = OPERATOR_PATTERN.exec(rest)?.[0] ?? character;
    tokens.push(token(operator, 'punc'));
    index += operator.length;
  }
  return tokens;
}

function highlightSql(line: string, state: HighlightState): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let index = 0;

  while (index < line.length) {
    if (state.blockComment) {
      const end = line.indexOf('*/', index);
      if (end === -1) {
        tokens.push(token(line.slice(index), 'com'));
        return tokens;
      }
      tokens.push(token(line.slice(index, end + 2), 'com'));
      state.blockComment = false;
      index = end + 2;
      continue;
    }

    const character = line[index] ?? '';
    const rest = line.slice(index);

    if (rest.startsWith('--') || character === '#') {
      tokens.push(token(rest, 'com'));
      break;
    }
    if (rest.startsWith('/*')) {
      const end = line.indexOf('*/', index + 2);
      if (end === -1) {
        tokens.push(token(rest, 'com'));
        state.blockComment = true;
        break;
      }
      tokens.push(token(line.slice(index, end + 2), 'com'));
      index = end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const scan = scanQuoted(line, index, character, true);
      tokens.push(token(line.slice(index, scan.end), character === "'" ? 'str' : 'var'));
      index = scan.end;
      continue;
    }

    const number = NUMBER_PATTERN.exec(rest);
    if (number !== null) {
      tokens.push(token(number[0], 'num'));
      index += number[0].length;
      continue;
    }

    if (isWordStart(character)) {
      const word = IDENT_PATTERN.exec(rest)?.[0] ?? character;
      const lower = word.toLowerCase();
      let kind: TokenKind;
      if (SQL_KEYWORDS.has(lower)) kind = 'kw';
      else if (SQL_TYPES.has(lower)) kind = 'type';
      else if (nextMeaningful(line, index + word.length) === '(') kind = 'fn';
      else kind = 'var';
      tokens.push(token(word, kind));
      index += word.length;
      continue;
    }

    if (/\s/.test(character)) {
      const space = /^\s+/.exec(rest)?.[0] ?? character;
      tokens.push(token(space, null));
      index += space.length;
      continue;
    }

    const operator = OPERATOR_PATTERN.exec(rest)?.[0] ?? character;
    tokens.push(token(operator, 'punc'));
    index += operator.length;
  }
  return tokens;
}

function highlightJson(line: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let index = 0;

  while (index < line.length) {
    const character = line[index] ?? '';
    const rest = line.slice(index);

    if (character === '"') {
      const scan = scanQuoted(line, index, '"');
      const isKey = nextMeaningful(line, scan.end) === ':';
      tokens.push(token(line.slice(index, scan.end), isKey ? 'key' : 'str'));
      index = scan.end;
      continue;
    }

    const number = NUMBER_PATTERN.exec(rest);
    if (number !== null) {
      tokens.push(token(number[0], 'num'));
      index += number[0].length;
      continue;
    }

    if (isWordStart(character)) {
      const word = IDENT_PATTERN.exec(rest)?.[0] ?? character;
      tokens.push(
        token(word, word === 'true' || word === 'false' || word === 'null' ? 'lit' : 'var'),
      );
      index += word.length;
      continue;
    }

    if (/\s/.test(character)) {
      const space = /^\s+/.exec(rest)?.[0] ?? character;
      tokens.push(token(space, null));
      index += space.length;
      continue;
    }

    tokens.push(token(character, 'punc'));
    index += 1;
  }
  return tokens;
}

export function highlightLine(
  line: string,
  language: HighlightLanguage,
  state: HighlightState,
): HighlightToken[] {
  switch (language) {
    case 'python':
      return highlightPython(line, state);
    case 'sql':
      return highlightSql(line, state);
    case 'json':
      return highlightJson(line);
    default:
      return highlightJs(line, state);
  }
}
