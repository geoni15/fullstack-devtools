import type { HandlerProfile } from '@bdt/protocol';

export const HANDLER_PROFILE_HELPER_SOURCE = String.raw`
  const profileOfHandler = (fn) => {
    let name = null;
    try {
      name = typeof fn.name === 'string' && fn.name !== '' ? fn.name : null;
    } catch (error) {
      void error;
    }
    let source = null;
    try {
      const raw = Function.prototype.toString.call(fn);
      if (raw.trim() !== '') source = raw.slice(0, 6000);
    } catch (error) {
      void error;
    }
    const text = typeof source === 'string' ? source : '';
    const trimmed = text.replace(/^\s+/, '');
    let ctor = '';
    try {
      ctor = fn.constructor && typeof fn.constructor.name === 'string' ? fn.constructor.name : '';
    } catch (error) {
      void error;
    }
    const asyncFlag = ctor === 'AsyncFunction' || /^async\b/.test(trimmed);
    const generator =
      ctor === 'GeneratorFunction' ||
      ctor === 'AsyncGeneratorFunction' ||
      /^(?:async\s+)?function\s*\*/.test(trimmed);
    const brace = trimmed.indexOf('{');
    const arrowAt = trimmed.indexOf('=>');
    const arrow =
      arrowAt !== -1 &&
      (brace === -1 || arrowAt < brace) &&
      !/^(?:async\s+)?function\b/.test(trimmed);
    const functionMatch = /^(?:async\s+)?function\s*\*?\s*[A-Za-z0-9_$]*\s*\(([^)]*)\)/.exec(trimmed);
    const arrowParen = /^(?:async\s+)?\(([^)]*)\)\s*=>/.exec(trimmed);
    const arrowBare = /^(?:async\s+)?([A-Za-z0-9_$]+)\s*=>/.exec(trimmed);
    const methodMatch = /^(?:async\s+)?\*?\s*[A-Za-z0-9_$]+\s*\(([^)]*)\)\s*\{/.exec(trimmed);
    const rawParams = functionMatch
      ? functionMatch[1]
      : arrowParen
        ? arrowParen[1]
        : arrowBare
          ? arrowBare[1]
          : methodMatch
            ? methodMatch[1]
            : null;
    let params = null;
    if (rawParams !== null && rawParams !== undefined) {
      params = rawParams.trim();
      if (params.length > 160) params = params.slice(0, 160) + '…';
    }
    let signature = null;
    if (params !== null) {
      const prefix = asyncFlag ? 'async ' : '';
      if (arrow) {
        signature = arrowBare !== null ? prefix + params + ' =>' : prefix + '(' + params + ') =>';
      } else if (functionMatch !== null) {
        signature = prefix + (generator ? 'function* ' : 'function ') + '(' + params + ')';
      } else {
        signature = prefix + '(' + params + ')';
      }
    }
    const tryCatch = /\btry\s*\{/.test(text) && /\bcatch\s*(?:\(|\{)/.test(text);
    return {
      name: name,
      source: source,
      profile: {
        async: asyncFlag,
        await: /(^|[^.\w$])await\b/.test(text),
        generator: generator,
        arrow: arrow,
        tryCatch: tryCatch,
        params: params,
        signature: signature,
      },
    };
  };
`;

export const HANDLER_PROFILE_CALL_SOURCE = `function () {\n${HANDLER_PROFILE_HELPER_SOURCE}\n  return profileOfHandler(this);\n}`;

export function parseHandlerProfile(value: unknown): HandlerProfile | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const params =
    typeof record.params === 'string' && record.params !== '' ? record.params.slice(0, 240) : null;
  const signature =
    typeof record.signature === 'string' && record.signature !== ''
      ? record.signature.slice(0, 240)
      : null;
  return {
    async: record.async === true,
    await: record.await === true,
    generator: record.generator === true,
    arrow: record.arrow === true,
    tryCatch: record.tryCatch === true,
    params,
    signature,
  };
}

export function profileFromSource(
  source: string | null,
  constructorName: string | null = null,
): HandlerProfile | null {
  if (source === null || source.trim() === '') return null;
  const text = source;
  const trimmed = text.replace(/^\s+/, '');
  const asyncFlag = constructorName === 'AsyncFunction' || /^async\b/.test(trimmed);
  const generator =
    constructorName === 'GeneratorFunction' ||
    constructorName === 'AsyncGeneratorFunction' ||
    /^(?:async\s+)?function\s*\*/.test(trimmed);
  const brace = trimmed.indexOf('{');
  const arrowAt = trimmed.indexOf('=>');
  const arrow =
    arrowAt !== -1 &&
    (brace === -1 || arrowAt < brace) &&
    !/^(?:async\s+)?function\b/.test(trimmed);
  const functionMatch = /^(?:async\s+)?function\s*\*?\s*[A-Za-z0-9_$]*\s*\(([^)]*)\)/.exec(trimmed);
  const arrowParen = /^(?:async\s+)?\(([^)]*)\)\s*=>/.exec(trimmed);
  const arrowBare = /^(?:async\s+)?([A-Za-z0-9_$]+)\s*=>/.exec(trimmed);
  const methodMatch = /^(?:async\s+)?\*?\s*[A-Za-z0-9_$]+\s*\(([^)]*)\)\s*\{/.exec(trimmed);
  const rawParams =
    functionMatch?.[1] ?? arrowParen?.[1] ?? arrowBare?.[1] ?? methodMatch?.[1] ?? null;
  let params: string | null = null;
  if (rawParams !== null) {
    params = rawParams.trim();
    if (params.length > 160) params = `${params.slice(0, 160)}…`;
  }
  let signature: string | null = null;
  if (params !== null) {
    const prefix = asyncFlag ? 'async ' : '';
    if (arrow) {
      signature = arrowBare !== null ? `${prefix}${params} =>` : `${prefix}(${params}) =>`;
    } else if (functionMatch !== null) {
      signature = `${prefix}${generator ? 'function* ' : 'function '}(${params})`;
    } else {
      signature = `${prefix}(${params})`;
    }
  }
  return {
    async: asyncFlag,
    await: /(^|[^.\w$])await\b/.test(text),
    generator,
    arrow,
    tryCatch: /\btry\s*\{/.test(text) && /\bcatch\s*(?:\(|\{)/.test(text),
    params,
    signature,
  };
}
