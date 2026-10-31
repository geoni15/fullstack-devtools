import { describe, expect, it } from 'vitest';
import {
  SQL_CAPTURE_DRAIN_EXPRESSION,
  SQL_CAPTURE_SOURCE,
  parseCapturedSql,
  parseSqlCaptureInfo,
} from './sql-capture';

interface CaptureGlobal {
  __bdtSqlCapture?: { drain(): unknown[] };
}

describe('captura SQL en runtime', () => {
  it('el código inyectado y el drenaje son JavaScript válido', () => {
    expect(() => {
      new Function(SQL_CAPTURE_SOURCE);
    }).not.toThrow();
    expect(() => {
      new Function(SQL_CAPTURE_DRAIN_EXPRESSION);
    }).not.toThrow();
  });

  it('instala un búfer vacío y lo drena sin drivers', async () => {
    const readCapture = (): CaptureGlobal['__bdtSqlCapture'] =>
      (globalThis as typeof globalThis & CaptureGlobal).__bdtSqlCapture;
    delete (globalThis as typeof globalThis & CaptureGlobal).__bdtSqlCapture;
    const start = new Function(`return (${SQL_CAPTURE_SOURCE});`) as () => Promise<string>;
    const raw = await start();
    const info = parseSqlCaptureInfo(JSON.parse(raw) as unknown);
    expect(info?.ok).toBe(true);
    expect(info?.error).toBeNull();
    expect(typeof readCapture()?.drain).toBe('function');

    const drain = new Function(`return (${SQL_CAPTURE_DRAIN_EXPRESSION});`) as () => string;
    expect(JSON.parse(drain())).toEqual([]);
    delete (globalThis as typeof globalThis & CaptureGlobal).__bdtSqlCapture;
  });

  it('descarta capturas sin driver o sin SQL', () => {
    const raw = JSON.stringify([
      {
        driver: 'pg',
        sql: '  SELECT  1 ',
        at: 10,
        frames: [
          { functionName: 'listar', file: 'C:/proyecto/server.js', line: 4, column: 3 },
          { file: '', line: 0, column: 0 },
        ],
      },
      { driver: '', sql: 'SELECT 2', at: 11, frames: [] },
      { driver: 'pg', sql: '   ', at: 12, frames: [] },
      { driver: 'mysql2', sql: 'UPDATE t SET a = 1', at: 'x', frames: 'no' },
    ]);
    const executions = parseCapturedSql(raw);
    expect(executions).toHaveLength(2);
    expect(executions[0]?.driver).toBe('pg');
    expect(executions[0]?.sql).toBe('SELECT  1');
    expect(executions[0]?.frames).toHaveLength(1);
    expect(executions[0]?.frames[0]?.line).toBe(4);
    expect(executions[1]?.driver).toBe('mysql2');
    expect(executions[1]?.frames).toEqual([]);
    expect(Number.isFinite(executions[1]?.at)).toBe(true);
  });

  it('valida la información de arranque de la captura', () => {
    expect(
      parseSqlCaptureInfo({ ok: true, drivers: ['pg', 'pg', ''], prisma: true, error: null }),
    ).toEqual({ ok: true, drivers: ['pg'], prisma: true, error: null });
    expect(parseSqlCaptureInfo('no')).toBeNull();
    expect(parseSqlCaptureInfo({ ok: false, drivers: 'pg', prisma: 'sí' })?.drivers).toEqual([]);
  });
});
