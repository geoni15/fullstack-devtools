import type { RequestOutcome } from './browser';

export type RequestStatusKind =
  | 'informational'
  | 'success'
  | 'redirect'
  | 'client-error'
  | 'server-error'
  | 'network-error'
  | 'pending'
  | 'empty';

export type RequestStatusTone = 'ok' | 'warning' | 'error' | 'pending' | 'muted';

export interface RequestStatusView {
  kind: RequestStatusKind;
  tone: RequestStatusTone;
  code: string;
  reason: string;
  label: string;
  phase: string;
  detail: string;
  search: string;
}

const REASON_PHRASE: Record<number, string> = {
  100: 'Continuar',
  101: 'Cambio de protocolo',
  102: 'Procesando',
  103: 'Primeros indicios',
  200: 'OK',
  201: 'Creado',
  202: 'Aceptado',
  203: 'Información no autoritativa',
  204: 'Sin contenido',
  205: 'Reiniciar contenido',
  206: 'Contenido parcial',
  207: 'Multi-estado',
  208: 'Ya informado',
  226: 'IM usado',
  300: 'Múltiples opciones',
  301: 'Movido permanentemente',
  302: 'Encontrado',
  303: 'Ver otro',
  304: 'No modificado',
  305: 'Usar proxy',
  307: 'Redirección temporal',
  308: 'Redirección permanente',
  400: 'Solicitud incorrecta',
  401: 'No autorizado',
  402: 'Pago requerido',
  403: 'Prohibido',
  404: 'No encontrado',
  405: 'Método no permitido',
  406: 'No aceptable',
  407: 'Autenticación de proxy requerida',
  408: 'Tiempo de solicitud agotado',
  409: 'Conflicto',
  410: 'Ya no disponible',
  411: 'Longitud requerida',
  412: 'Condición previa fallida',
  413: 'Contenido demasiado grande',
  414: 'URI demasiado largo',
  415: 'Tipo de medio no soportado',
  416: 'Rango no satisfecho',
  417: 'Expectativa fallida',
  418: 'Soy una tetera',
  421: 'Solicitud mal dirigida',
  422: 'Entidad no procesable',
  423: 'Bloqueado',
  424: 'Dependencia fallida',
  425: 'Demasiado pronto',
  426: 'Actualización requerida',
  428: 'Condición previa requerida',
  429: 'Demasiadas solicitudes',
  431: 'Cabeceras demasiado grandes',
  451: 'No disponible por razones legales',
  500: 'Error interno del servidor',
  501: 'No implementado',
  502: 'Puerta de enlace incorrecta',
  503: 'Servicio no disponible',
  504: 'Tiempo de espera de la puerta de enlace',
  505: 'Versión HTTP no soportada',
  506: 'Negociación de variante',
  507: 'Almacenamiento insuficiente',
  508: 'Bucle detectado',
  510: 'Extensión necesaria',
  511: 'Autenticación de red requerida',
};

const KIND_BY_CATEGORY: Record<number, RequestStatusKind> = {
  1: 'informational',
  2: 'success',
  3: 'redirect',
  4: 'client-error',
  5: 'server-error',
};

const TONE_BY_KIND: Record<RequestStatusKind, RequestStatusTone> = {
  informational: 'pending',
  success: 'ok',
  redirect: 'warning',
  'client-error': 'error',
  'server-error': 'error',
  'network-error': 'error',
  pending: 'pending',
  empty: 'muted',
};

const KIND_LABEL: Record<RequestStatusKind, string> = {
  informational: 'respuesta provisional',
  success: 'respuesta correcta',
  redirect: 'redirección',
  'client-error': 'error del cliente',
  'server-error': 'error del servidor',
  'network-error': 'sin respuesta',
  pending: 'pendiente',
  empty: 'sin estado',
};

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function reasonPhrase(statusCode: number): string {
  const known = REASON_PHRASE[statusCode];
  if (known !== undefined) return known;
  const category = Math.floor(statusCode / 100);
  switch (category) {
    case 1:
      return 'Respuesta provisional';
    case 2:
      return 'Correcta';
    case 3:
      return 'Redirección';
    case 4:
      return 'Error del cliente';
    case 5:
      return 'Error del servidor';
    default:
      return 'Código desconocido';
  }
}

export interface RequestStatusInput {
  statusCode: number | null;
  outcome: RequestOutcome;
  error?: string | null;
  backendObserved?: boolean | null;
}

function statusKind(input: RequestStatusInput): RequestStatusKind {
  if (input.outcome === 'pending') return 'pending';
  if (input.outcome === 'failed') return 'network-error';
  if (input.statusCode === null) return 'empty';
  return KIND_BY_CATEGORY[Math.floor(input.statusCode / 100)] ?? 'empty';
}

function phaseText(kind: RequestStatusKind, backendObserved: boolean | null | undefined): string {
  switch (kind) {
    case 'pending':
      return 'Enviada · esperando respuesta del servidor';
    case 'network-error':
      return 'Enviada · el servidor no respondió';
    case 'empty':
      return 'Enviada · sin estado reportado';
    case 'informational':
      return 'Recibida · respuesta provisional del servidor';
    case 'success':
      return backendObserved === true
        ? 'Recibida · ejecución del backend capturada'
        : backendObserved === false
          ? 'Recibida · ejecución del backend no capturada'
          : 'Recibida · respuesta correcta';
    case 'redirect':
      return 'Recibida · redirección';
    case 'client-error':
      return 'Recibida · rechazada por el cliente o la ruta';
    case 'server-error':
      return 'Recibida · falló el servidor';
  }
}

export function requestStatusView(input: RequestStatusInput): RequestStatusView {
  const kind = statusKind(input);
  const tone = TONE_BY_KIND[kind];
  const observed = input.backendObserved ?? null;
  const backendNote =
    observed === true
      ? 'ejecución del backend capturada'
      : observed === false
        ? 'sin evidencia de ejecución del backend'
        : null;

  let code: string;
  let reason: string;
  if (kind === 'network-error') {
    code = 'ERR';
    reason = 'Sin respuesta';
  } else if (kind === 'pending') {
    code = '···';
    reason = 'Pendiente';
  } else if (input.statusCode === null) {
    code = '—';
    reason = 'Sin estado';
  } else {
    code = String(input.statusCode);
    reason = reasonPhrase(input.statusCode);
  }

  const category =
    input.statusCode !== null && kind !== 'empty'
      ? `${String(Math.floor(input.statusCode / 100))}xx`
      : null;

  const parts: string[] = [KIND_LABEL[kind]];
  if (
    kind === 'network-error' &&
    input.error !== null &&
    input.error !== undefined &&
    input.error.length > 0
  ) {
    parts.push(input.error);
  }
  if (backendNote !== null) {
    parts.push(backendNote);
  }
  const detail = parts.join(' · ');
  const phase = phaseText(kind, observed);

  const search = normalizeSearchText(
    [
      code,
      reason,
      ...(category !== null ? [category] : []),
      KIND_LABEL[kind],
      phase,
      detail,
      kind,
      input.outcome,
      observed === true ? 'backend capturado' : '',
      observed === false ? 'backend no capturado' : '',
    ]
      .filter((part) => part.length > 0)
      .join(' '),
  );

  return {
    kind,
    tone,
    code,
    reason,
    label: `${code} · ${reason}`,
    phase,
    detail,
    search,
  };
}

export function requestStatusSearch(input: RequestStatusInput): string {
  return requestStatusView(input).search;
}
