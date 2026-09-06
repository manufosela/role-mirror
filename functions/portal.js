/**
 * Push de métricas DORA/LEAN por SUBDOMINIO al Firestore del portal de management
 * (RMR-TSK-0352, contrato revisado en RMR-TSK-0478). Escribe EXCLUSIVAMENTE
 * `metrics_dora/{key}` y `metrics_lean/{key}` en OTRO proyecto (el portal), vía
 * una segunda app de Firebase Admin NOMBRADA (no la de GREBLA). Solo agregados:
 * nunca datos ni identificadores de persona.
 *
 * La clave es el `key` ALMACENADO del subdominio, y cada documento lleva
 * `subdomain` y `domain` explícitos. Antes se fabricaba con `slugify(nombre)`, y
 * por eso renombrar una entidad partía su serie histórica en dos: un rótulo es
 * editable por definición y no puede ser clave primaria (ADR «De squads a
 * dominios y subdominios»).
 *
 * Dominio espejo de src/tools/portal/domain/snapshot.js y de la agregación DORA
 * de src/tools/dora/domain/aggregate.js (functions es un bundle aislado).
 *
 * Unidades del portal: leadTimeForChanges/timeToRestore/cycleTime en HORAS;
 * changeFailureRate/flowEfficiency fracción 0..1; deploymentFrequency/throughput
 * por semana; wip entero.
 */
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

const PORTAL_PROJECT_ID = 'tribbu-dev-portal';
const SERIES_CAP = 8;
const round1 = (n) => Math.round(n * 10) / 10;

// ── Agregación DORA por equipo (espejo de src/tools/dora/domain/aggregate.js) ──

/** Agrega las métricas DORA de un conjunto de repos (medias PONDERADAS). */
export function aggregateMetrics(repos) {
  const list = Array.isArray(repos) ? repos : [];
  const measured = list.filter((r) => r.metrics && !r.metrics.error);
  let deployments = 0, freq = 0, leadWeighted = 0, leadWeight = 0;
  let realLeadWeighted = 0, realLeadWeight = 0;
  let deploymentsFailed = 0, deploymentsTotal = 0;
  let downtimeHoursTotal = 0, incidentsResolved = 0;
  for (const r of measured) {
    const m = r.metrics;
    deployments += m.deployments || 0;
    freq += m.deployFrequencyPerWeek || 0;
    if (m.leadTimeHoursAvg != null && (m.deployments || 0) > 0) {
      leadWeighted += m.leadTimeHoursAvg * m.deployments;
      leadWeight += m.deployments;
    }
    if (m.leadTimeCommitDeployHoursAvg != null && (m.changesDeployed ?? 0) > 0) {
      realLeadWeighted += m.leadTimeCommitDeployHoursAvg * m.changesDeployed;
      realLeadWeight += m.changesDeployed;
    }
    deploymentsFailed += m.deploymentsFailed ?? 0;
    deploymentsTotal += m.deploymentsTotal ?? 0;
    downtimeHoursTotal += m.downtimeHoursTotal ?? 0;
    incidentsResolved += m.incidentsResolved ?? 0;
  }
  return {
    measured: measured.length,
    deployFrequencyPerWeek: round1(freq),
    leadTimeHoursAvg: leadWeight > 0 ? round1(leadWeighted / leadWeight) : null,
    leadTimeCommitDeployHoursAvg: realLeadWeight > 0 ? round1(realLeadWeighted / realLeadWeight) : null,
    changeFailureRatePct: deploymentsTotal > 0 ? round1((deploymentsFailed / deploymentsTotal) * 100) : null,
    mttrHoursAvg: incidentsResolved > 0 ? round1(downtimeHoursTotal / incidentsResolved) : null,
  };
}

/** Agrupa los repos por su equipo (`team`) y agrega cada grupo. */
export function aggregateByTeam(repos) {
  const groups = new Map();
  for (const r of Array.isArray(repos) ? repos : []) {
    const key = r.team || '(sin equipo)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].map(([key, rs]) => ({ key, ...aggregateMetrics(rs) }));
}

// ── Dominio del snapshot (espejo de src/tools/portal/domain/snapshot.js) ──

/**
 * Ámbito publicado de un subdominio: su clave y la de su dominio, o `null` si no
 * está en el catálogo — y entonces NO se publica. Aquí no se fabrica ninguna
 * clave: solo se lee la que ya está almacenada.
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
 * lleva ese nombre. Es una BÚSQUEDA en lo ya almacenado, no una derivación.
 * Temporal: cuando los repos DORA tengan su propio enganche, esto sobra.
 */
export function subdomainKeyForTeam(team, units = []) {
  const wanted = String(team ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const unit = units.find((u) => String(u?.name || u?.linearLabel || '').trim().toLowerCase() === wanted);
  return String(unit?.subdomainKey ?? '').trim() || null;
}

const numOrNull = (v) => (Number.isFinite(v) ? v : null);
const intOrNull = (v) => (Number.isInteger(v) ? v : (Number.isFinite(v) ? Math.round(v) : null));
const fractionFromPct = (pct) => (Number.isFinite(pct) ? Math.round((pct / 100) * 10000) / 10000 : null);

/** ¿Falló el cálculo del squad? (no publicar snapshots a medias). */
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

/** `current` LEAN. `flowEfficiency` aún no lo calcula GREBLA → null. */
export function leanCurrent(metrics) {
  return {
    cycleTime: numOrNull(metrics?.cycleTimeP50Hours),
    throughput: numOrNull(metrics?.throughputPerWeek),
    wip: intOrNull(metrics?.wip),
    flowEfficiency: numOrNull(metrics?.flowEfficiency),
  };
}

/** ¿El `current` tiene al menos un número real? */
export function hasAnyNumber(current) {
  return Object.values(current ?? {}).some((v) => Number.isFinite(v));
}

/** Acumula la serie: reemplaza la misma semana, ordena y conserva las últimas `cap`. */
export function accumulateSeries(prevSeries, point, cap = SERIES_CAP) {
  const kept = (Array.isArray(prevSeries) ? prevSeries : [])
    .filter((p) => p && typeof p.periodStart === 'string' && p.periodStart !== point.periodStart);
  return [...kept, point]
    .sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0))
    .slice(-cap);
}

/** Ensambla el documento del portal respetando el esquema campo a campo. */
export function buildSnapshot({ subdomain, domain, name, updatedAt, periodStart, current, prevSeries, period = 'weekly' }) {
  return {
    // `squad` se mantiene con el mismo valor que `subdomain` mientras dure la
    // transición: el portal ya lo lee y quitárselo de golpe le rompe el informe.
    squad: subdomain,
    subdomain,
    domain,
    // El rótulo humano viaja con el dato: así el portal escribe «CAEs» en el
    // mensaje sin buscarlo en una config indexada por nombre.
    name: name ?? subdomain,
    updatedAt,
    period,
    current,
    series: accumulateSeries(prevSeries, { periodStart, ...current }),
  };
}

// ── Segunda app de Firebase Admin (el portal) ──

/**
 * ¿La credencial del portal es real (no un placeholder de otra instancia)? Evita
 * intentar el push donde el portal no aplica (p. ej. el demo).
 */
export function portalConfigured(saKeyJson) {
  try {
    const c = JSON.parse(saKeyJson);
    return c && c.project_id === PORTAL_PROJECT_ID && typeof c.private_key === 'string';
  } catch {
    return false;
  }
}

/** Firestore del PORTAL vía app Admin NOMBRADA. Se reutiliza si ya existe. */
export function getPortalDb(saKeyJson) {
  const app = getApps().find((a) => a.name === 'portal')
    || initializeApp({ credential: cert(JSON.parse(saKeyJson)), projectId: PORTAL_PROJECT_ID }, 'portal');
  return getFirestore(app);
}

/** Inicio de la semana ISO (lunes) de una fecha, como `YYYY-MM-DD` (UTC). */
export function weekStart(dateIso) {
  const d = new Date(dateIso);
  const mondayOffset = (d.getUTCDay() + 6) % 7; // 0 = lunes
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  return d.toISOString().slice(0, 10);
}

/**
 * Publica el snapshot de cada SUBDOMINIO al portal. Lee de GREBLA lo YA calculado
 * (DORA por repo → agregado por equipo; LEAN por equipo en `leanTeams`), lo mapea
 * al esquema del portal y hace SET idempotente en `metrics_dora`/`metrics_lean`,
 * acumulando la serie. Aislado por entidad: un fallo no tumba el resto. Nunca
 * escribe otras colecciones ni vuelca la credencial en los logs.
 *
 * Lo que no está enganchado a un subdominio del catálogo NO se publica y se
 * registra: publicar algo que el catálogo no conoce es el desajuste que este
 * contrato corrige, y en silencio nadie lo vería.
 */
export async function publishSquadMetrics({ greblaDb, portalDb, nowIso }) {
  const periodStart = weekStart(nowIso);
  const results = { dora: 0, lean: 0, skipped: 0, failed: 0 };

  const [subsSnap, domainsSnap] = await Promise.all([
    greblaDb.collection('subdomains').get(),
    greblaDb.collection('domains').get(),
  ]);
  const subdomains = subsSnap.docs.map((d) => d.data());
  const domains = domainsSnap.docs.map((d) => d.data());

  const publish = async (collection, subdomainKey, current, quien) => {
    const scope = scopeOf(subdomainKey, subdomains, domains);
    if (!scope) {
      results.skipped += 1;
      logger.info('portal push skipped: sin subdominio en el catálogo', { collection, quien, subdomainKey: subdomainKey ?? null });
      return;
    }
    if (!hasAnyNumber(current)) { results.skipped += 1; return; }
    try {
      const ref = portalDb.collection(collection).doc(scope.subdomain);
      const prev = (await ref.get()).data();
      const snapshot = buildSnapshot({ ...scope, name: quien, updatedAt: nowIso, periodStart, current, prevSeries: prev?.series });
      await ref.set(snapshot);
      results[collection === 'metrics_dora' ? 'dora' : 'lean'] += 1;
    } catch (err) {
      results.failed += 1;
      logger.error('portal push failed', { collection, subdomain: scope.subdomain, message: err?.message ?? 'unknown' });
    }
  };

  // LEAN: equipos en leanTeams (kind 'squad') con métricas persistidas. Su
  // `subdomainKey` es lo que dice a qué subdominio miden.
  const unitsSnap = await greblaDb.collection('leanTeams').where('kind', '==', 'squad').get();
  const units = unitsSnap.docs.map((d) => d.data());
  for (const unit of units) {
    if (calcFailed(unit.metrics)) { results.skipped += 1; continue; }
    await publish('metrics_lean', unit.subdomainKey, leanCurrent(unit.metrics), unit.name || unit.linearLabel);
  }

  // DORA: repos con métricas persistidas → agregado por equipo. El equipo del
  // repo se resuelve contra la unidad LEAN que lo mide, que es quien guarda la
  // clave; el día que el repo tenga su propio enganche, esto se simplifica.
  const reposSnap = await greblaDb.collection('dora').get();
  const repos = reposSnap.docs.map((d) => d.data());
  for (const agg of aggregateByTeam(repos)) {
    if (agg.key === '(sin equipo)' || agg.measured === 0) { results.skipped += 1; continue; }
    await publish('metrics_dora', subdomainKeyForTeam(agg.key, units), doraCurrent(agg), agg.key);
  }

  return results;
}
