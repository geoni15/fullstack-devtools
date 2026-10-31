import { describe, expect, it } from 'vitest';
import { analyzeSql } from './index';

function single(sql: string) {
  const analyses = analyzeSql(sql);
  expect(analyses).toHaveLength(1);
  const analysis = analyses[0];
  if (analysis === undefined) {
    throw new Error('El analizador no devolvió resultados.');
  }
  return analysis;
}

function columnNames(analysis: ReturnType<typeof single>): string[] {
  return analysis.columns.map((column) =>
    column.table === null ? column.name : `${column.table}.${column.name}`,
  );
}

describe('analizador SQL', () => {
  it('extrae tablas y columnas de un SELECT con JOIN, WHERE, GROUP y ORDER', () => {
    const analysis = single(
      [
        'SELECT u.id, u.nombre, COUNT(p.id) AS pedidos',
        'FROM usuarios u',
        'JOIN pedidos p ON p.usuario_id = u.id',
        'WHERE u.activo = 1',
        'GROUP BY u.id, u.nombre',
        'ORDER BY u.nombre',
      ].join('\n'),
    );
    expect(analysis.operation).toBe('select');
    expect(analysis.parse).toBe('ast');
    expect(analysis.selectStar).toBe(false);
    expect(analysis.tablesRead).toEqual(['usuarios', 'pedidos']);
    expect(analysis.tablesWritten).toEqual([]);
    expect(columnNames(analysis)).toEqual(
      expect.arrayContaining([
        'usuarios.id',
        'usuarios.nombre',
        'pedidos.id',
        'pedidos.usuario_id',
        'usuarios.activo',
      ]),
    );
    expect(analysis.columns).toEqual(
      expect.arrayContaining([
        { table: 'pedidos', name: 'usuario_id', usage: 'join' },
        { table: 'usuarios', name: 'activo', usage: 'where' },
        { table: 'usuarios', name: 'nombre', usage: 'group' },
        { table: 'usuarios', name: 'nombre', usage: 'order' },
      ]),
    );
  });

  it('distingue columnas modificadas y de condición en un UPDATE de PostgreSQL', () => {
    const analysis = single(
      'UPDATE usuarios SET nombre = $1, activo = $2 WHERE id = $3 RETURNING id',
    );
    expect(analysis.operation).toBe('update');
    expect(analysis.dialect).toBe('postgresql');
    expect(analysis.tablesWritten).toEqual(['usuarios']);
    expect(analysis.tablesRead).toEqual(['usuarios']);
    expect(analysis.columns).toEqual(
      expect.arrayContaining([
        { table: 'usuarios', name: 'nombre', usage: 'set' },
        { table: 'usuarios', name: 'activo', usage: 'set' },
        { table: 'usuarios', name: 'id', usage: 'where' },
        { table: 'usuarios', name: 'id', usage: 'returning' },
      ]),
    );
  });

  it('identifica tablas y columnas de un INSERT sin conservar valores', () => {
    const analysis = single(
      "INSERT INTO usuarios (nombre, email) VALUES ('secreto-sembrado', 'a@b.c')",
    );
    expect(analysis.operation).toBe('insert');
    expect(analysis.tablesWritten).toEqual(['usuarios']);
    expect(analysis.tablesRead).toEqual([]);
    expect(analysis.columns).toEqual([
      { table: 'usuarios', name: 'nombre', usage: 'insert' },
      { table: 'usuarios', name: 'email', usage: 'insert' },
    ]);
    expect(JSON.stringify(analysis)).not.toContain('secreto-sembrado');
  });

  it('identifica la tabla y la condición de un DELETE', () => {
    const analysis = single('DELETE FROM pedidos WHERE usuario_id = 5');
    expect(analysis.operation).toBe('delete');
    expect(analysis.tablesWritten).toEqual(['pedidos']);
    expect(analysis.columns).toEqual([{ table: 'pedidos', name: 'usuario_id', usage: 'where' }]);
  });

  it('marca SELECT * sin inventar columnas y pide el esquema', () => {
    const analysis = single('SELECT * FROM usuarios WHERE id = 1');
    expect(analysis.operation).toBe('select');
    expect(analysis.selectStar).toBe(true);
    expect(analysis.columns).toEqual([{ table: 'usuarios', name: 'id', usage: 'where' }]);
    expect(analysis.note).toContain('esquema');
  });

  it('devuelve una entrada por sentencia', () => {
    const analyses = analyzeSql('SELECT id FROM usuarios; DELETE FROM pedidos WHERE id = 1');
    expect(analyses).toHaveLength(2);
    expect(analyses[0]?.operation).toBe('select');
    expect(analyses[1]?.operation).toBe('delete');
  });

  it('usa el fallback sin lanzar cuando el SQL no se puede analizar', () => {
    const analysis = single('UPDATE usuarios SET nombre = WHERE');
    expect(analysis.parse).toBe('fallback');
    expect(analysis.dialect).toBeNull();
    expect(analysis.operation).toBe('update');
    expect(analysis.tablesWritten).toEqual(['usuarios']);
    expect(analysis.note).toContain('aproximado');
  });

  it('reconoce el dialecto SQLite por AUTOINCREMENT', () => {
    const analysis = single(
      'CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT)',
    );
    expect(analysis.parse).toBe('ast');
    expect(analysis.dialect).toBe('sqlite');
    expect(analysis.operation).toBe('other');
  });

  it('no inventa resultados para una cadena vacía', () => {
    expect(analyzeSql('   ')).toEqual([]);
  });
});
