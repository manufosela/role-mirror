/**
 * Casos de uso LEAN: alta/baja/listado de unidades de flujo (equipos = label del
 * grupo Squad de Linear; gremios = grupo Chapter) y el resumen de flujo separado
 * por tipo. La UI nunca toca el repo directamente.
 *
 * @typedef {import('../domain/ports.js').LeanPersistence} LeanPersistence
 * @typedef {import('../domain/types.js').LeanUnit} LeanUnit
 * @typedef {import('../domain/types.js').LeanUnitKind} LeanUnitKind
 */
import { aggregateFlow } from '../domain/aggregate.js';

const KINDS = new Set(['squad', 'chapter']);

/**
 * Da de alta una unidad de flujo: mide un LABEL de Linear o un EQUIPO entero.
 *
 * El equipo hace falta porque hay equipos cuyo trabajo no lleva label de
 * «Squad» —Matcher y Plataforma— y por label son invisibles. Una unidad sin
 * ninguna de las dos cosas no se crea: medir sin filtro devuelve el workspace
 * entero, y ese número pasa por una métrica de equipo.
 *
 * @param {LeanPersistence} persistence
 * @param {{ linearLabel?: string, linearTeamKey?: string, kind: LeanUnitKind, name?: string }} input
 * @returns {Promise<string>}
 */
export function addUnit(persistence, input) {
  const linearLabel = String(input.linearLabel ?? '').trim();
  const linearTeamKey = String(input.linearTeamKey ?? '').trim();
  if (!linearLabel && !linearTeamKey) throw new Error('La unidad necesita un label o un equipo de Linear');
  const kind = KINDS.has(input.kind) ? input.kind : 'squad';
  const name = String(input.name ?? '').trim() || linearLabel || linearTeamKey;
  const unit = { kind, name, createdAt: new Date().toISOString() };
  if (linearLabel) unit.linearLabel = linearLabel;
  if (linearTeamKey) unit.linearTeamKey = linearTeamKey;
  return persistence.units.add(unit);
}

/** @param {LeanPersistence} persistence */
export function listUnits(persistence) {
  return persistence.units.list();
}

/**
 * Clasifica una unidad como equipo o gremio. Existen unidades sin `kind` —restos
 * de altas antiguas— que no se miden ni se publican: se arreglan clasificándolas,
 * no escondiéndolas.
 * @param {LeanPersistence} persistence
 * @param {string} id
 * @param {LeanUnitKind} kind
 * @returns {Promise<void>}
 */
export async function classifyUnit(persistence, id, kind) {
  // `async` a propósito: el error llega SIEMPRE como promesa rechazada, así
  // quien la llama no tiene que protegerse de dos formas distintas de fallar.
  if (!id) throw new Error('La unidad es obligatoria');
  if (!KINDS.has(kind)) throw new Error(`Tipo de unidad desconocido: ${kind}`);
  await persistence.units.update(id, { kind });
}

/**
 * Engancha una unidad de flujo a un subdominio del catálogo, o la desengancha
 * con la cadena vacía. Se guarda la CLAVE, no el nombre: renombrar el
 * subdominio no puede romper el enganche — ese es el punto del modelo.
 *
 * No se valida aquí que la clave exista: quien la valida es el dominio
 * (`classifyUnits`) al publicar, y así una clave que se queda huérfana porque
 * borraron su subdominio se ve como lo que es, en vez de desaparecer sin ruido.
 *
 * @param {LeanPersistence} persistence
 * @param {string} id
 * @param {string} subdomainKey  clave del subdominio, o '' para desenganchar
 * @returns {Promise<void>}
 */
export function linkUnitToSubdomain(persistence, id, subdomainKey) {
  if (!id) throw new Error('La unidad es obligatoria');
  return persistence.units.update(id, { subdomainKey: String(subdomainKey ?? '').trim() });
}

/** @param {LeanPersistence} persistence @param {string} id */
export function removeUnit(persistence, id) {
  return persistence.units.remove(id);
}

/**
 * Resumen de flujo separado por tipo: equipos (squad) y gremios (chapter), cada
 * grupo con sus unidades y su agregado global.
 * @param {LeanPersistence} persistence
 * @returns {Promise<{ squads: { units: LeanUnit[], global: ReturnType<typeof aggregateFlow> }, chapters: { units: LeanUnit[], global: ReturnType<typeof aggregateFlow> } }>}
 */
export async function getFlowSummary(persistence) {
  const all = await persistence.units.list();
  const squads = all.filter((u) => u.kind === 'squad');
  const chapters = all.filter((u) => u.kind === 'chapter');
  return {
    squads: { units: squads, global: aggregateFlow(squads) },
    chapters: { units: chapters, global: aggregateFlow(chapters) },
  };
}
