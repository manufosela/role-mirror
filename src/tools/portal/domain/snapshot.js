/**
 * Dominio del PUSH de métricas al portal de management (RMR-TSK-0352). Puro (sin
 * Firebase): mapea las métricas que GREBLA ya calcula (DORA por equipo, LEAN por
 * squad) al ESQUEMA EXACTO que el portal lee, con las unidades correctas, y
 * acumula la serie semanal snapshot a snapshot.
 *
 * Unidades del portal (obligatorio):
 *  - leadTimeForChanges, timeToRestore, cycleTime → HORAS
 *  - changeFailureRate, flowEfficiency           → fracción 0..1
 *  - deploymentFrequency, throughput             → número por semana
 *  - wip                                          → entero
 */

const SERIES_CAP = 8; // ~6-8 periodos semanales

/**
 * Ámbito publicado de un subdominio: su propia clave y la de su dominio.
 * Devuelve `null` si la clave no está en el catálogo — y entonces NO se publica:
 * medir algo que no está en el catálogo es lo que produjo el desajuste que este
 * contrato corrige.
 *
 * Aquí no se fabrica ninguna clave. Antes se hacía `slugify(nombre)`, y por eso
 * renombrar una entidad partía su serie histórica en dos: un rótulo es editable
 * por definición y no puede ser clave primaria.
 *
 * @param {string} subdomainKey
 * @param {ReadonlyArray<{ key: string, domainKey: string }>} subdomains
 * @param {ReadonlyArray<{ key: string }>} domains
 * @returns {{ subdomain: string, domain: string }|null}
 */
export function scopeOf(subdomainKey, subdomains = [], domains = []) {
  const key = String(subdomainKey ?? '').trim();
  if (!key) return null;
  const sub = subdomains.find((s) => s.key === key);
  if (!sub) return null;
  const domain = domains.find((d) => d.key === sub.domainKey);
  if (!domain) return null;
  return { subdomain: sub.key, domain: domain.key };
}

/**
 * Clave del subdominio que mide un equipo DORA, buscando la unidad LEAN que
 * lleva ese nombre. Es una BÚSQUEDA en lo ya almacenado, no una derivación: la
 * clave sigue saliendo del `subdomainKey` de la unidad.
 *
 * Es temporal: cuando los repos DORA tengan su propio enganche, esto sobra. Se
 * compara sin distinguir mayúsculas porque «CAEs» y «CAES» son la misma entidad
 * escrita de dos formas.
 *
 * @param {string} team  nombre del equipo tal y como está en el repo
 * @param {ReadonlyArray<{ name?: string, linearLabel?: string, subdomainKey?: string }>} units
 * @returns {string|null}
 */
export function subdomainKeyForTeam(team, units = []) {
  const wanted = String(team ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const unit = units.find((u) => String(u?.name || u?.linearLabel || '').trim().toLowerCase() === wanted);
  return String(unit?.subdomainKey ?? '').trim() || null;
}

/** Número finito o `null` (no inventa 0 para datos ausentes). */
const numOrNull = (v) => (Number.isFinite(v) ? v : null);
/** Entero finito o `null`. */
const intOrNull = (v) => (Number.isInteger(v) ? v : (Number.isFinite(v) ? Math.round(v) : null));
/** Porcentaje 0..100 → fracción 0..1 (4 decimales); `null`/no numérico → `null`. */
const fractionFromPct = (pct) => (Number.isFinite(pct) ? Math.round((pct / 100) * 10000) / 10000 : null);

/**
 * ¿Falló el cálculo de este squad? (no publicar snapshots a medias). Un objeto de
 * métricas con `.error` o ausente cuenta como fallo.
 */
export function calcFailed(metrics) {
  return !metrics || typeof metrics === 'string' || typeof metrics.error === 'string';
}

/** `current` DORA en el esquema del portal, con unidades convertidas. */
export function doraCurrent(agg) {
  return {
    deploymentFrequency: numOrNull(agg?.deployFrequencyPerWeek),
    leadTimeForChanges: numOrNull(agg?.leadTimeCommitDeployHoursAvg ?? agg?.leadTimeHoursAvg),
    changeFailureRate: fractionFromPct(agg?.changeFailureRatePct),
    timeToRestore: numOrNull(agg?.mttrHoursAvg),
  };
}

/** `current` LEAN en el esquema del portal. `flowEfficiency` aún no lo calcula GREBLA → null. */
export function leanCurrent(metrics) {
  return {
    cycleTime: numOrNull(metrics?.cycleTimeP50Hours),
    throughput: numOrNull(metrics?.throughputPerWeek),
    wip: intOrNull(metrics?.wip),
    flowEfficiency: numOrNull(metrics?.flowEfficiency),
  };
}

/** ¿El `current` tiene al menos un número real? (si todo es null, no hay nada que publicar). */
export function hasAnyNumber(current) {
  return Object.values(current ?? {}).some((v) => Number.isFinite(v));
}

/**
 * Acumula la serie: reemplaza el punto de la MISMA semana (idempotente), ordena
 * por `periodStart` y conserva los últimos `cap` (~8) periodos.
 */
export function accumulateSeries(prevSeries, point, cap = SERIES_CAP) {
  const kept = (Array.isArray(prevSeries) ? prevSeries : [])
    .filter((p) => p && typeof p.periodStart === 'string' && p.periodStart !== point.periodStart);
  return [...kept, point]
    .sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0))
    .slice(-cap);
}

/**
 * Ensambla el documento del portal (`metrics_dora/{key}` o `metrics_lean/{key}`,
 * donde `key` es el del SUBDOMINIO) respetando el esquema campo a campo.
 * `prevSeries` es la serie del doc anterior del portal (para acumular). El punto
 * de la serie es la semana `periodStart`.
 *
 * Lleva SIEMPRE `subdomain` y `domain` explícitos —también los degenerados, como
 * `internal-products-core` dentro de `internal-products`— para que el portal
 * agregue por dominio leyendo un campo, sin parsear ids nunca.
 *
 * `squad` se mantiene con el mismo valor que `subdomain`: el portal ya lo lee, y
 * quitárselo de golpe le rompería el informe a mitad de la transición.
 */
export function buildSnapshot({ subdomain, domain, name, updatedAt, periodStart, current, prevSeries, period = 'weekly' }) {
  const point = { periodStart, ...current };
  return {
    squad: subdomain,
    subdomain,
    domain,
    // El rótulo humano viaja con el dato: así el portal escribe «CAEs» en el
    // mensaje sin tener que buscarlo en una config indexada por nombre.
    name: name ?? subdomain,
    updatedAt,
    period,
    current,
    series: accumulateSeries(prevSeries, point),
  };
}

