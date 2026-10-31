import { normalizeRoutePath, type StaticRoute } from './types';

export function routePatternToRegExp(routePath: string): RegExp {
  const path = normalizeRoutePath(routePath);
  let pattern = '^';
  let index = 0;
  while (index < path.length) {
    const char = path[index];
    if (char === ':') {
      index += 1;
      while (index < path.length) {
        const next = path[index];
        if (next === undefined || !/[A-Za-z0-9_]/.test(next)) {
          break;
        }
        index += 1;
      }
      if (path[index] === '?') {
        index += 1;
        pattern += '(?:/[^/]+)?';
      } else {
        pattern += '[^/]+';
      }
      continue;
    }
    if (char === '{') {
      const end = path.indexOf('}', index);
      if (end === -1) {
        pattern += '\\{';
        index += 1;
        continue;
      }
      const converter = path.slice(index + 1, end).split(':')[1];
      pattern += converter === 'path' ? '.*' : '[^/]+';
      index = end + 1;
      continue;
    }
    if (char === '*') {
      pattern += '.*';
      index += 1;
      continue;
    }
    pattern += (char ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }
  return new RegExp(`${pattern}/?$`, 'i');
}

function specificity(route: StaticRoute): number {
  return route.path.length - route.path.split(':').length - route.path.split('{').length;
}

function suffixCandidates(
  routes: readonly StaticRoute[],
  method: string,
  normalized: string,
): StaticRoute[] {
  const segments = normalized.split('/').filter((segment) => segment !== '');
  for (let start = 1; start <= 2 && start < segments.length; start += 1) {
    const suffix = `/${segments.slice(start).join('/')}`;
    const fits = routes.filter(
      (route) => route.method === method && routePatternToRegExp(route.path).test(suffix),
    );
    if (fits.length > 0) return fits;
  }
  return [];
}

function routeSuffixCandidates(
  routes: readonly StaticRoute[],
  method: string,
  normalized: string,
): StaticRoute[] {
  return routes.filter((route) => {
    if (route.method !== method) return false;
    const segments = normalizeRoutePath(route.path)
      .split('/')
      .filter((segment) => segment !== '');
    if (segments.length < 2) return false;
    for (let start = 1; start <= 2 && start < segments.length; start += 1) {
      const suffix = `/${segments.slice(start).join('/')}`;
      if (routePatternToRegExp(suffix).test(normalized)) return true;
    }
    return false;
  });
}

export function matchRoute(
  routes: readonly StaticRoute[],
  method: string,
  pathname: string,
): StaticRoute | null {
  const normalized = normalizeRoutePath((pathname.split('?')[0] ?? pathname).split('#')[0] ?? '');
  const upperMethod = method.toUpperCase();
  const candidates = routes.filter(
    (route) => route.method === upperMethod && routePatternToRegExp(route.path).test(normalized),
  );
  if (candidates.length > 0) {
    candidates.sort((left, right) => specificity(right) - specificity(left));
    return candidates[0] ?? null;
  }
  const suffixed = suffixCandidates(routes, upperMethod, normalized);
  if (suffixed.length > 0) {
    suffixed.sort((left, right) => specificity(right) - specificity(left));
    const best = suffixed[0];
    if (best === undefined) return null;
    const note = 'coincidencia por sufijo del camino (prefijo montado)';
    return { ...best, note: best.note === null ? note : `${best.note} · ${note}` };
  }
  const shortened = routeSuffixCandidates(routes, upperMethod, normalized);
  if (shortened.length === 0) return null;
  shortened.sort((left, right) => specificity(right) - specificity(left));
  const best = shortened[0];
  if (best === undefined) return null;
  const note = 'coincidencia por sufijo de la ruta (prefijo del cliente)';
  return { ...best, note: best.note === null ? note : `${best.note} · ${note}` };
}
