import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractRoutesFromSource, initRouteParser, matchRoute, type StaticRoute } from './index';

const root = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

beforeAll(async () => {
  await initRouteParser({
    runtimeWasm: path.join(root, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
    javascriptWasm: path.join(
      root,
      'node_modules',
      'tree-sitter-javascript',
      'tree-sitter-javascript.wasm',
    ),
    pythonWasm: path.join(root, 'node_modules', 'tree-sitter-python', 'tree-sitter-python.wasm'),
  });
});

function extract(filePath: string, source: string): StaticRoute[] {
  return extractRoutesFromSource({ filePath, source });
}

describe('rutas Express', () => {
  it('extrae ruta, manejador y línea del manejador', () => {
    const routes = extract(
      'server/routes.js',
      [
        "const express = require('express');",
        'const app = express();',
        'function listarClientes(req, res) { res.json([]); }',
        "app.get('/api/clientes', listarClientes);",
      ].join('\n'),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'GET',
      path: '/api/clientes',
      handlerName: 'listarClientes',
      line: 3,
      endLine: 3,
      routeLine: 4,
      framework: 'express',
      resolved: true,
    });
  });

  it('marca el final del cuerpo de una función de varias líneas', () => {
    const routes = extract(
      'server/routes.js',
      [
        'const app = express();',
        'function listarClientes(req, res) {',
        '  const filas = consultar();',
        '  res.json(filas);',
        '}',
        "app.get('/api/clientes', listarClientes);",
      ].join('\n'),
    );
    expect(routes[0]).toMatchObject({ line: 2, endLine: 5, routeLine: 6 });
  });

  it('aplica prefijos de router y resuelve manejadores en línea', () => {
    const routes = extract(
      'server/app.js',
      [
        "const express = require('express');",
        'const app = express();',
        'const router = express.Router();',
        "app.use('/api', router);",
        "router.post('/login', async (req, res) => { res.json({ ok: true }); });",
      ].join('\n'),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'POST',
      path: '/api/login',
      handlerName: null,
      line: 5,
      endLine: 5,
      resolved: true,
    });
  });

  it('marca como no resuelto un manejador importado o de objeto', () => {
    const routes = extract(
      'server/app.js',
      [
        "const express = require('express');",
        'const app = express();',
        'const controlador = { login() {} };',
        "app.post('/api/login', controlador.login);",
      ].join('\n'),
    );
    expect(routes[0]?.resolved).toBe(false);
    expect(routes[0]?.handlerName).toBe('login');
    expect(routes[0]?.note).toContain('método de objeto');
  });

  it('ignora rutas comentadas', () => {
    const routes = extract(
      'server/app.js',
      [
        'const app = express();',
        "// app.get('/api/oculta', listar);",
        "/* app.post('/api/x', y); */",
      ].join('\n'),
    );
    expect(routes).toHaveLength(0);
  });

  it('tolera errores de sintaxis y conserva lo que sí parsea', () => {
    const routes = extract(
      'server/roto.js',
      ['const app = express();', "app.get('/api/sana', sana);", 'function roto( {'].join('\n'),
    );
    expect(routes.some((route) => route.path === '/api/sana')).toBe(true);
  });
});

describe('rutas FastAPI y Flask', () => {
  it('extrae decoradores FastAPI con prefijo de APIRouter', () => {
    const routes = extract(
      'backend/main.py',
      [
        'from fastapi import APIRouter',
        'router = APIRouter(prefix="/api")',
        '@router.post("/login")',
        'async def login(body: dict):',
        '    return {"ok": True}',
      ].join('\n'),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'POST',
      path: '/api/login',
      handlerName: 'login',
      line: 4,
      endLine: 5,
      framework: 'fastapi',
      resolved: true,
    });
  });

  it('extrae Flask route con lista de métodos', () => {
    const routes = extract(
      'backend/app.py',
      [
        'from flask import Flask',
        'app = Flask(__name__)',
        '@app.route("/clientes", methods=["GET", "POST"])',
        'def clientes():',
        '    return "ok"',
      ].join('\n'),
    );
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /clientes',
      'POST /clientes',
    ]);
    expect(routes[0]?.framework).toBe('flask');
  });

  it('extrae varios decoradores sobre la misma función', () => {
    const routes = extract(
      'backend/app.py',
      [
        'app = FastAPI()',
        '@app.get("/saludo")',
        '@app.head("/saludo")',
        'def saludo():',
        '    return {"ok": True}',
      ].join('\n'),
    );
    expect(routes.map((route) => route.method).sort()).toEqual(['GET', 'HEAD']);
  });
});

describe('sitios SQL del manejador', () => {
  it('extrae una consulta literal de JavaScript con línea y receptor', () => {
    const routes = extract(
      'server/clientes.js',
      [
        'const app = express();',
        "app.get('/api/clientes', async (req, res) => {",
        "  const filas = await pool.query('SELECT id, nombre FROM clientes WHERE activo = true');",
        '  res.json(filas.rows);',
        '});',
      ].join('\n'),
    );
    expect(routes[0]?.sqlSites).toEqual([
      expect.objectContaining({
        line: 3,
        method: 'query',
        objectName: 'pool',
        sql: 'SELECT id, nombre FROM clientes WHERE activo = true',
        dynamic: false,
        note: null,
      }),
    ]);
  });

  it('marca como dinámica una consulta cuyo texto se arma en una variable', () => {
    const routes = extract(
      'server/clientes.js',
      [
        'const app = express();',
        "app.get('/buscar', async (req, res) => {",
        "  const texto = `SELECT id FROM clientes WHERE nombre LIKE '%${req.query.nombre}%'`;",
        '  const filas = await db.query(texto);',
        '  res.json(filas);',
        '});',
      ].join('\n'),
    );
    const site = routes[0]?.sqlSites[0];
    expect(site?.line).toBe(4);
    expect(site?.dynamic).toBe(true);
    expect(site?.sql).toBeNull();
    expect(site?.note).toContain('dinámico');
  });

  it('reconoce plantillas etiquetadas sin interpolación', () => {
    const routes = extract(
      'server/clientes.js',
      [
        'const app = express();',
        "app.get('/contar', async (req, res) => {",
        '  const total = await db.query`SELECT COUNT(*) FROM clientes`;',
        '  res.json(total);',
        '});',
      ].join('\n'),
    );
    expect(routes[0]?.sqlSites[0]).toMatchObject({
      line: 3,
      method: 'query',
      sql: 'SELECT COUNT(*) FROM clientes',
      dynamic: false,
    });
  });

  it('no extrae consultas fuera del cuerpo del manejador', () => {
    const routes = extract(
      'server/app.js',
      [
        'const app = express();',
        'function listar(req, res) { res.json([]); }',
        "app.get('/api/x', listar);",
        "function otra() { db.query('SELECT 1'); }",
      ].join('\n'),
    );
    expect(routes[0]?.sqlSites).toEqual([]);
  });

  it('deja sqlSites vacío cuando el manejador no se resolvió', () => {
    const routes = extract(
      'server/app.js',
      [
        'const app = express();',
        "const controlador = require('./controlador');",
        "app.get('/api/x', controlador.listar);",
      ].join('\n'),
    );
    expect(routes[0]?.resolved).toBe(false);
    expect(routes[0]?.sqlSites).toEqual([]);
  });

  it('extrae SQL literal y f-string dinámico de Python', () => {
    const routes = extract(
      'backend/main.py',
      [
        'from fastapi import FastAPI',
        'app = FastAPI()',
        '@app.put("/clientes/{id}")',
        'def actualizar(id: int):',
        '    cursor.execute("UPDATE clientes SET nombre = %s WHERE id = %s", (nombre, id))',
        '    return {"ok": True}',
        '@app.get("/buscar")',
        'def buscar(nombre: str):',
        '    cursor.execute(f"SELECT id FROM clientes WHERE nombre = \'{nombre}\'")',
        '    return []',
      ].join('\n'),
    );
    const update = routes.find((route) => route.method === 'PUT')?.sqlSites[0];
    expect(update).toMatchObject({
      line: 5,
      method: 'execute',
      objectName: 'cursor',
      sql: 'UPDATE clientes SET nombre = %s WHERE id = %s',
      dynamic: false,
    });
    const search = routes.find((route) => route.method === 'GET')?.sqlSites[0];
    expect(search?.line).toBe(9);
    expect(search?.dynamic).toBe(true);
    expect(search?.sql).toBeNull();
  });
});

describe('emparejamiento de rutas', () => {
  const routes: StaticRoute[] = [
    {
      method: 'GET',
      path: '/api/clientes',
      handlerName: 'listarClientes',
      file: 'server/routes.js',
      line: 3,
      endLine: 5,
      routeLine: 4,
      framework: 'express',
      resolved: true,
      note: null,
      sqlSites: [],
    },
    {
      method: 'GET',
      path: '/api/clientes/:id',
      handlerName: 'verCliente',
      file: 'server/routes.js',
      line: 8,
      endLine: 10,
      routeLine: 9,
      framework: 'express',
      resolved: true,
      note: null,
      sqlSites: [],
    },
  ];

  it('empareja rutas con parámetros y query eliminada', () => {
    expect(matchRoute(routes, 'GET', '/api/clientes/42')?.handlerName).toBe('verCliente');
    expect(matchRoute(routes, 'get', '/api/clientes?page=2')?.handlerName).toBe('listarClientes');
  });

  it('respeta el método y devuelve null si no hay coincidencia', () => {
    expect(matchRoute(routes, 'POST', '/api/clientes')).toBeNull();
    expect(matchRoute(routes, 'GET', '/api/otros')).toBeNull();
  });
});
