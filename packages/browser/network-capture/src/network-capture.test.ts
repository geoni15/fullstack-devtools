import { beforeEach, describe, expect, it } from 'vitest';
import { classifyUrl, normalizeOrigin } from './classify';
import { isSensitiveHeader, maskHeaders, maskUrl } from './headers';
import { normalizeInitiator } from './initiator';
import { matchesTargets, RequestBuffer } from './request-buffer';

const targets = {
  frontendOrigin: 'http://127.0.0.1:5173',
  backendOrigin: 'http://127.0.0.1:8080',
};

describe('clasificación de peticiones', () => {
  it('distingue backend, frontend y externas por origen', () => {
    expect(classifyUrl('http://127.0.0.1:8080/api/clientes?page=1', targets)).toBe('backend');
    expect(classifyUrl('http://127.0.0.1:5173/src/main.ts', targets)).toBe('frontend');
    expect(classifyUrl('https://cdn.example.com/lib.js', targets)).toBe('external');
  });

  it('trata un puerto distinto como origen distinto', () => {
    expect(classifyUrl('http://127.0.0.1:9090/api', targets)).toBe('external');
  });

  it('rechaza orígenes que no son http ni https', () => {
    expect(normalizeOrigin('file:///C:/app/index.html')).toBeNull();
    expect(normalizeOrigin('no es una url')).toBeNull();
    expect(classifyUrl('data:text/plain,hola', targets)).toBe('external');
  });

  it('exige frontend y backend distintos', () => {
    expect(matchesTargets('http://127.0.0.1:5173', 'http://127.0.0.1:5173')).toBeNull();
    expect(matchesTargets('http://127.0.0.1:5173', 'http://localhost:8080')).toEqual({
      frontendOrigin: 'http://127.0.0.1:5173',
      backendOrigin: 'http://localhost:8080',
    });
  });
});

describe('enmascarado de cabeceras', () => {
  it('marca las cabeceras sensibles sin conservar el valor', () => {
    const masked = maskHeaders({
      Authorization: 'Bearer secreto-real',
      Cookie: 'sesion=abc',
      'X-Api-Key': 'clave',
      'Content-Type': 'application/json',
    });
    expect(masked.Authorization).toBe('[enmascarado]');
    expect(masked.Cookie).toBe('[enmascarado]');
    expect(masked['X-Api-Key']).toBe('[enmascarado]');
    expect(masked['Content-Type']).toBe('application/json');
    expect(JSON.stringify(masked)).not.toContain('secreto-real');
  });

  it('reconoce nombres que contienen términos sensibles', () => {
    expect(isSensitiveHeader('X-Session-Id')).toBe(true);
    expect(isSensitiveHeader('X-Request-Token')).toBe(true);
    expect(isSensitiveHeader('Accept-Language')).toBe(false);
  });

  it('limita cantidad, tamaño de nombre y valor', () => {
    const headers: Record<string, string> = { ['x'.repeat(200)]: 'valor' };
    for (let index = 0; index < 50; index += 1) headers[`h-${index}`] = 'v'.repeat(1000);
    const masked = maskHeaders(headers);
    const names = Object.keys(masked);
    expect(names).toHaveLength(40);
    expect(names).not.toContain('x'.repeat(200));
    for (const name of names) expect(masked[name]?.length).toBeLessThanOrEqual(512);
  });

  it('enmascara parámetros sensibles en la URL', () => {
    const masked = maskUrl('http://127.0.0.1:8080/api?token=abc123&page=2');
    expect(masked).toContain('token=%5Benmascarado%5D');
    expect(masked).toContain('page=2');
    expect(masked).not.toContain('abc123');
  });
});

describe('normalización de iniciadores', () => {
  it('convierte líneas y columnas a base 1 y conserva el nombre de función', () => {
    const initiator = normalizeInitiator({
      type: 'parser',
      stack: {
        callFrames: [
          {
            functionName: 'guardarCliente',
            url: 'http://127.0.0.1:5173/src/api.ts',
            lineNumber: 9,
            columnNumber: 4,
          },
        ],
      },
    });
    expect(initiator).toEqual({
      type: 'parser',
      async: false,
      mapped: false,
      frames: [
        {
          functionName: 'guardarCliente',
          url: 'http://127.0.0.1:5173/src/api.ts',
          line: 10,
          column: 5,
        },
      ],
    });
  });

  it('descarta marcos que no son http(s) y conserva toda la pila', () => {
    const frames = Array.from({ length: 12 }, (_, index) => ({
      functionName: `fn${index}`,
      url: index === 0 ? 'data:text/javascript,alert(1)' : `http://127.0.0.1:5173/s${index}.ts`,
      lineNumber: index,
      columnNumber: index,
    }));
    const initiator = normalizeInitiator({ type: 'script', stack: { callFrames: frames } });
    expect(initiator?.frames).toHaveLength(11);
    expect(initiator?.frames[0]?.url).toBe('http://127.0.0.1:5173/s1.ts');
    expect(initiator?.frames[10]?.url).toBe('http://127.0.0.1:5173/s11.ts');
  });

  it('marca la pila como asíncrona cuando hay padre y evita ciclos', () => {
    const parent = {
      callFrames: [
        {
          functionName: 'load',
          url: 'http://127.0.0.1:5173/app.ts',
          lineNumber: 0,
          columnNumber: 0,
        },
      ],
    };
    const child = {
      callFrames: [
        {
          functionName: 'fetchData',
          url: 'http://127.0.0.1:5173/data.ts',
          lineNumber: 1,
          columnNumber: 1,
        },
      ],
      parent,
    };
    const initiator = normalizeInitiator({ type: 'script', stack: child });
    expect(initiator?.async).toBe(true);
    expect(initiator?.frames.map((frame) => frame.functionName)).toEqual(['fetchData', 'load']);
  });

  it('devuelve null sin iniciador y objeto vacío sin pila', () => {
    expect(normalizeInitiator(null)).toBeNull();
    expect(normalizeInitiator({ type: 'parser' })).toEqual({
      type: 'parser',
      frames: [],
      async: false,
      mapped: false,
    });
  });
});

describe('búfer de peticiones', () => {
  function start(
    id: string,
    url = 'http://127.0.0.1:8080/api',
    timestamp = 1000,
  ): ReturnType<RequestBuffer['begin']> {
    return buffer.begin({ requestId: id, url, method: 'post', resourceType: 'XHR', timestamp });
  }

  let buffer: RequestBuffer;

  beforeEach(() => {
    buffer = new RequestBuffer(targets);
  });

  it('registra una petición pendiente con origen y cabeceras enmascaradas', () => {
    const request = buffer.begin({
      requestId: 'r1',
      url: 'http://127.0.0.1:8080/api/clientes?page=2',
      method: 'post',
      resourceType: 'Fetch',
      timestamp: 1000.4,
      wallTimestamp: 1_700_000_000_000,
      headers: { Authorization: 'Bearer abc', Accept: 'application/json' },
    });
    expect(request).toMatchObject({
      id: 'r1',
      method: 'POST',
      origin: 'backend',
      outcome: 'pending',
      statusCode: null,
      startedAt: 1000,
      wallStartedAt: 1_700_000_000_000,
      path: '/api/clientes?page=2',
      host: '127.0.0.1:8080',
    });
    expect(request?.headers.Authorization).toBe('[enmascarado]');
    expect(request?.headers.Accept).toBe('application/json');
  });

  it('no conserva parámetros sensibles en la ruta mostrada', () => {
    const request = buffer.begin({
      requestId: 'r-token',
      url: 'http://127.0.0.1:8080/api/sesion?token=secreto&page=1',
      method: 'GET',
      resourceType: 'Fetch',
      timestamp: 1,
    });
    expect(request?.path).not.toContain('secreto');
    expect(request?.path).toContain('page=1');
    expect(request?.url).not.toContain('secreto');
  });

  it('ignora URLs inválidas o que no son http(s)', () => {
    expect(
      buffer.begin({
        requestId: 'r1',
        url: 'no-url',
        method: 'GET',
        resourceType: 'XHR',
        timestamp: 1,
      }),
    ).toBeNull();
    expect(
      buffer.begin({
        requestId: 'r2',
        url: 'file:///C:/a',
        method: 'GET',
        resourceType: 'XHR',
        timestamp: 1,
      }),
    ).toBeNull();
    expect(buffer.count).toBe(0);
  });

  it('actualiza estado, código y duración al finalizar', () => {
    start('r1');
    const finished = buffer.finish('r1', {
      statusCode: 201,
      mimeType: 'application/json',
      durationMs: 42.6,
    });
    expect(finished).toMatchObject({
      outcome: 'finished',
      statusCode: 201,
      durationMs: 43,
      mimeType: 'application/json',
    });
    expect(buffer.all()[0]?.outcome).toBe('finished');
  });

  it('registra fallos con error acotado', () => {
    start('r1');
    const failed = buffer.fail('r1', 'x'.repeat(500), 10);
    expect(failed?.outcome).toBe('failed');
    expect(failed?.error).toHaveLength(200);
  });

  it('devuelve null al actualizar peticiones desconocidas y no duplica al reiniciar', () => {
    expect(buffer.finish('nope', { statusCode: 200, mimeType: null, durationMs: 1 })).toBeNull();
    expect(buffer.fail('nope', 'x', 1)).toBeNull();
    expect(buffer.setHeaders('nope', {})).toBeNull();
    const first = start('r1');
    const second = start('r1', 'http://127.0.0.1:8080/otra');
    expect(second).toBe(first);
    expect(buffer.count).toBe(1);
  });

  it('desaloja las peticiones más antiguas al superar el límite', () => {
    const small = new RequestBuffer(targets, 3);
    for (let index = 0; index < 5; index += 1) {
      small.begin({
        requestId: `r${index}`,
        url: 'http://127.0.0.1:8080/api',
        method: 'GET',
        resourceType: 'XHR',
        timestamp: index,
      });
    }
    expect(small.count).toBe(3);
    expect(small.all().map((request) => request.id)).toEqual(['r2', 'r3', 'r4']);
  });

  it('vacía el búfer por completo', () => {
    start('r1');
    buffer.clear();
    expect(buffer.count).toBe(0);
    expect(buffer.all()).toEqual([]);
  });
});
