/**
 * Tests del PUENTE GREBLA→portal (RMR-TSK-0478): qué se publica, con qué clave y
 * qué se deja fuera.
 *
 * La causa raíz que esto fija es concreta: el publicador hacía
 * `slugify(unit.name || unit.linearLabel || doc.id)`, o sea, convertía un rótulo
 * editable en clave primaria. Renombrar una entidad partía su serie histórica en
 * dos sin avisar. Aquí la clave se LEE del catálogo, y lo que no está en él no
 * se publica.
 */
import { describe, it, expect } from 'vitest';
import {
  publishSquadMetrics, scopeOf, subdomainKeyForTeam, buildSnapshot, leanCurrent, doraCurrent,
} from './portal.js';
import * as puro from '../src/tools/portal/domain/snapshot.js';

const SUBDOMAINS = [
  { key: 'caes', name: 'CAES', domainKey: 'tribbu-app' },
  { key: 'tribbu-app-core', name: 'Core', domainKey: 'tribbu-app' },
  { key: 'internal-products-core', name: 'Core', domainKey: 'internal-products' },
];
const DOMAINS = [{ key: 'tribbu-app' }, { key: 'internal-products' }];

const METRICS = { cycleTimeP50Hours: 166.7, throughputPerWeek: 6.9, wip: 25 };

/** Firestore de GREBLA de mentira: solo lo que el publicador lee. */
function fakeGrebla({ units = [], repos = [], subdomains = SUBDOMAINS, domains = DOMAINS } = {}) {
  const data = { leanTeams: units, dora: repos, subdomains, domains };
  const snap = (rows) => ({ docs: rows.map((r) => ({ id: r.id ?? 'x', data: () => r })) });
  return {
    collection(name) {
      return {
        get: async () => snap(data[name] ?? []),
        where: (field, _op, value) => ({ get: async () => snap((data[name] ?? []).filter((r) => r[field] === value)) }),
      };
    },
  };
}

/** Firestore del portal de mentira, que recuerda lo escrito. */
function fakePortal(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    written: store,
    collection(name) {
      return {
        doc: (id) => ({
          get: async () => ({ data: () => store.get(`${name}/${id}`) }),
          set: async (doc) => { store.set(`${name}/${id}`, doc); },
        }),
      };
    },
  };
}

describe('publishSquadMetrics: la clave sale del catálogo, no del nombre', () => {
  it('publica en el key del subdominio, no en el slug del nombre', async () => {
    // «The Mario Netas» es el nombre informal del Core en Linear. Antes se
    // publicaba en `the-mario-netas`; ahora, donde dice su enganche.
    const grebla = fakeGrebla({
      units: [{ id: 'u1', kind: 'squad', name: 'The Mario Netas', subdomainKey: 'tribbu-app-core', metrics: METRICS }],
    });
    const portal = fakePortal();
    const res = await publishSquadMetrics({ greblaDb: grebla, portalDb: portal, nowIso: '2026-09-07T06:00:00Z' });

    expect(res.lean).toBe(1);
    // Un documento, y solo uno: se acabó la doble escritura de la transición.
    expect([...portal.written.keys()]).toEqual(['metrics_lean/tribbu-app-core']);
    expect(portal.written.get('metrics_lean/tribbu-app-core')).toMatchObject({
      subdomain: 'tribbu-app-core', domain: 'tribbu-app', squad: 'tribbu-app-core',
      name: 'The Mario Netas',
    });
  });

  it('el rótulo humano viaja con el dato, para el mensaje de Slack', async () => {
    const grebla = fakeGrebla({
      units: [{ id: 'u1', kind: 'squad', name: 'CAEs', subdomainKey: 'caes', metrics: METRICS }],
    });
    const portal = fakePortal();
    await publishSquadMetrics({ greblaDb: grebla, portalDb: portal, nowIso: '2026-09-07T06:00:00Z' });
    // Sin esto, el portal tendría que buscar el nombre en su config indexada
    // por nombre, que es justo lo que estamos dejando de usar como clave.
    expect(portal.written.get('metrics_lean/caes').name).toBe('CAEs');
  });


  it('renombrar la unidad NO cambia dónde se publica: la serie no se parte', async () => {
    const conNombre = (name) => fakeGrebla({
      units: [{ id: 'u1', kind: 'squad', name, subdomainKey: 'caes', metrics: METRICS }],
    });
    const antes = fakePortal();
    const despues = fakePortal();
    await publishSquadMetrics({ greblaDb: conNombre('CAEs'), portalDb: antes, nowIso: '2026-09-07T06:00:00Z' });
    await publishSquadMetrics({ greblaDb: conNombre('CAES renombrado'), portalDb: despues, nowIso: '2026-09-07T06:00:00Z' });

    expect([...antes.written.keys()]).toEqual([...despues.written.keys()]);
  });

  it('acumula la serie del documento anterior en lugar de empezar de cero', async () => {
    const portal = fakePortal({
      'metrics_lean/caes': { series: [{ periodStart: '2026-08-31', throughput: 6.9 }] },
    });
    const grebla = fakeGrebla({
      units: [{ id: 'u1', kind: 'squad', name: 'CAEs', subdomainKey: 'caes', metrics: METRICS }],
    });
    await publishSquadMetrics({ greblaDb: grebla, portalDb: portal, nowIso: '2026-09-07T06:00:00Z' });

    const doc = portal.written.get('metrics_lean/caes');
    expect(doc.series.map((p) => p.periodStart)).toEqual(['2026-08-31', '2026-09-07']);
  });

  it('lo que no está enganchado, o apunta fuera del catálogo, no se publica', async () => {
    const grebla = fakeGrebla({
      units: [
        { id: 'u1', kind: 'squad', name: 'Sin enganchar', metrics: METRICS },
        { id: 'u2', kind: 'squad', name: 'Rota', subdomainKey: 'ya-no-existe', metrics: METRICS },
        { id: 'u3', kind: 'chapter', name: 'Backend', subdomainKey: 'caes', metrics: METRICS },
      ],
    });
    const portal = fakePortal();
    const res = await publishSquadMetrics({ greblaDb: grebla, portalDb: portal, nowIso: '2026-09-07T06:00:00Z' });

    expect(portal.written.size).toBe(0);
    // El gremio ni siquiera llega: el publicador solo mira los equipos.
    expect(res).toMatchObject({ lean: 0, skipped: 2, failed: 0 });
  });

  it('un cálculo fallido no publica un snapshot a medias', async () => {
    const grebla = fakeGrebla({
      units: [{ id: 'u1', kind: 'squad', name: 'CAEs', subdomainKey: 'caes', metrics: { error: 'Linear 500' } }],
    });
    const portal = fakePortal();
    await publishSquadMetrics({ greblaDb: grebla, portalDb: portal, nowIso: '2026-09-07T06:00:00Z' });
    expect(portal.written.size).toBe(0);
  });

  it('DORA publica en el subdominio de la unidad que mide ese equipo', async () => {
    const grebla = fakeGrebla({
      units: [{ id: 'u1', kind: 'squad', name: 'CAEs', subdomainKey: 'caes' }],
      repos: [{ id: 'r1', team: 'CAEs', metrics: { deployments: 4, deployFrequencyPerWeek: 2, deploymentsTotal: 4, deploymentsFailed: 1 } }],
    });
    const portal = fakePortal();
    await publishSquadMetrics({ greblaDb: grebla, portalDb: portal, nowIso: '2026-09-07T06:00:00Z' });

    expect(portal.written.get('metrics_dora/caes')).toMatchObject({ subdomain: 'caes', domain: 'tribbu-app' });
  });

  it('un repo cuyo equipo no mide ningún subdominio no se publica', async () => {
    const grebla = fakeGrebla({
      units: [{ id: 'u1', kind: 'squad', name: 'CAEs', subdomainKey: 'caes' }],
      repos: [{ id: 'r1', team: 'Matcher', metrics: { deployments: 4, deployFrequencyPerWeek: 2 } }],
    });
    const portal = fakePortal();
    await publishSquadMetrics({ greblaDb: grebla, portalDb: portal, nowIso: '2026-09-07T06:00:00Z' });
    expect(portal.written.size).toBe(0);
  });
});

describe('scopeOf y subdomainKeyForTeam (espejo del dominio puro)', () => {
  it('el Core degenerado lleva su dominio', () => {
    expect(scopeOf('internal-products-core', SUBDOMAINS, DOMAINS))
      .toEqual({ subdomain: 'internal-products-core', domain: 'internal-products' });
  });

  it('«CAEs» y «CAES» son la misma entidad escrita de dos formas', () => {
    expect(subdomainKeyForTeam('CAES', [{ name: 'CAEs', subdomainKey: 'caes' }])).toBe('caes');
  });
});

describe('el espejo no se desvía del dominio puro', () => {
  // functions/ es un bundle aislado y no puede importar src/, así que el dominio
  // está DUPLICADO a mano. La copia ya se desvió una vez —el snapshot llevaba el
  // cálculo en línea— y solo se vio porque falló un test de aquí. Esto lo fija:
  // ante la misma entrada, los dos lados devuelven exactamente lo mismo.
  const entrada = {
    subdomain: 'tribbu-app-core', domain: 'tribbu-app',
    updatedAt: '2026-09-07T06:00:00Z', periodStart: '2026-09-07',
    current: { cycleTime: 31, throughput: 10, wip: 7, flowEfficiency: 0.42 },
    prevSeries: [{ periodStart: '2026-08-31', throughput: 9 }],
  };

  it('buildSnapshot devuelve lo mismo en los dos lados', () => {
    expect(buildSnapshot(entrada)).toEqual(puro.buildSnapshot(entrada));
  });


  it('scopeOf y subdomainKeyForTeam también', () => {
    const units = [{ name: 'CAEs', subdomainKey: 'caes' }];
    expect(scopeOf('caes', SUBDOMAINS, DOMAINS)).toEqual(puro.scopeOf('caes', SUBDOMAINS, DOMAINS));
    expect(scopeOf('no-existe', SUBDOMAINS, DOMAINS)).toEqual(puro.scopeOf('no-existe', SUBDOMAINS, DOMAINS));
    expect(subdomainKeyForTeam('CAES', units)).toEqual(puro.subdomainKeyForTeam('CAES', units));
  });

  it('y el mapeo de unidades al esquema del portal', () => {
    const lean = { cycleTimeP50Hours: 166.7, throughputPerWeek: 6.9, wip: 25 };
    const dora = { deployFrequencyPerWeek: 4.3, leadTimeCommitDeployHoursAvg: 18, changeFailureRatePct: 8, mttrHoursAvg: 3.1 };
    expect(leanCurrent(lean)).toEqual(puro.leanCurrent(lean));
    expect(doraCurrent(dora)).toEqual(puro.doraCurrent(dora));
  });
});
