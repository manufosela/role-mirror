import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryLeanPersistence } from '../infrastructure/memory/index.js';
import { addUnit, listUnits, removeUnit, getFlowSummary, linkUnitToSubdomain, classifyUnit } from './usecases.js';

describe('LEAN usecases (unidades = labels de Linear)', () => {
  let p;
  beforeEach(() => { p = createMemoryLeanPersistence(); });

  it('addUnit trimea el label, exige que no esté vacío y guarda el kind', async () => {
    const id = await addUnit(p, { linearLabel: ' Trust ', kind: 'squad', name: 'Equipo Trust' });
    const [u] = await listUnits(p);
    expect(u.id).toBe(id);
    expect(u.linearLabel).toBe('Trust');
    expect(u.kind).toBe('squad');
    expect(u.name).toBe('Equipo Trust');
    expect(() => addUnit(p, { linearLabel: '  ', kind: 'squad' })).toThrow(/label o un equipo/);
  });

  it('addUnit acepta un EQUIPO de Linear, para lo que no lleva label', async () => {
    // Matcher y Plataforma son equipos de Linear cuyas issues no llevan label de
    // «Squad»: por label serían invisibles.
    const id = await addUnit(p, { linearTeamKey: 'MAT', kind: 'squad', name: 'Matcher' });
    const [u] = await listUnits(p);
    expect(u.id).toBe(id);
    expect(u.linearTeamKey).toBe('MAT');
    expect(u.linearLabel).toBeUndefined();
  });

  it('sin nombre, el del equipo sirve de rótulo', async () => {
    await addUnit(p, { linearTeamKey: 'PLA', kind: 'squad' });
    expect((await listUnits(p))[0].name).toBe('PLA');
  });

  it('name por defecto = label; kind inválido cae a squad', async () => {
    await addUnit(p, { linearLabel: 'Backend', kind: 'nope' });
    const [u] = await listUnits(p);
    expect(u.name).toBe('Backend');
    expect(u.kind).toBe('squad');
  });

  it('removeUnit quita la unidad', async () => {
    const id = await addUnit(p, { linearLabel: 'Trust', kind: 'squad' });
    await removeUnit(p, id);
    expect(await listUnits(p)).toEqual([]);
  });

  it('getFlowSummary separa squads (equipos) y chapters (gremios) con su global', async () => {
    const seed = [
      { id: '1', linearLabel: 'Trust', kind: 'squad', name: 'Trust', metrics: { completed: 10, throughputPerWeek: 2.5, wip: 3, cycleTimeP50Hours: 20, cycleTimeP85Hours: 40, agingDaysMax: 5 } },
      { id: '2', linearLabel: 'Backend', kind: 'chapter', name: 'Backend', metrics: { completed: 6, throughputPerWeek: 1.5, wip: 2, cycleTimeP50Hours: 12, cycleTimeP85Hours: 30, agingDaysMax: 9 } },
    ];
    const pp = createMemoryLeanPersistence(seed);
    const { squads, chapters } = await getFlowSummary(pp);
    expect(squads.units).toHaveLength(1);
    expect(chapters.units).toHaveLength(1);
    expect(squads.global.completed).toBe(10);
    expect(chapters.global.completed).toBe(6);
  });

  it('linkUnitToSubdomain guarda la CLAVE del subdominio, no su nombre', async () => {
    const id = await addUnit(p, { linearLabel: 'The Mario Netas', kind: 'squad' });
    await linkUnitToSubdomain(p, id, 'tribbu-app-core');
    const [unit] = await listUnits(p);
    expect(unit.subdomainKey).toBe('tribbu-app-core');
    // El rótulo de Linear se queda como está: no es la identidad.
    expect(unit.name).toBe('The Mario Netas');
  });

  it('linkUnitToSubdomain con cadena vacía desengancha', async () => {
    const id = await addUnit(p, { linearLabel: 'Trust', kind: 'squad' });
    await linkUnitToSubdomain(p, id, 'trust');
    await linkUnitToSubdomain(p, id, '  ');
    expect((await listUnits(p))[0].subdomainKey).toBe('');
  });

  it('classifyUnit convierte una unidad sin tipo en equipo o gremio', async () => {
    const pp = createMemoryLeanPersistence([{ id: 'huerfana', name: 'tMWx2F7QK2cqoCiqDqi1' }]);
    await classifyUnit(pp, 'huerfana', 'chapter');
    expect((await listUnits(pp))[0].kind).toBe('chapter');
  });

  it('classifyUnit rechaza un tipo que no existe, en vez de guardarlo', async () => {
    // Guardar un kind inventado deja la unidad igual de rota que sin kind, pero
    // con pinta de arreglada.
    const pp = createMemoryLeanPersistence([{ id: 'huerfana', name: 'x' }]);
    await expect(classifyUnit(pp, 'huerfana', 'tribu')).rejects.toThrow('Tipo de unidad desconocido');
  });
});
