/**
 * Tests de la FUENTE de una unidad de flujo: de dónde salen sus issues.
 *
 * Esto nace de dos cosas medidas en Linear (2026-09-05):
 *  - Matcher y Plataforma son EQUIPOS de Linear con 110 y 105 issues vivas, y
 *    ninguna lleva label de «Squad»: midiendo solo por label son invisibles.
 *  - Una unidad sin label acabó midiendo el workspace ENTERO (243 completadas,
 *    101 WIP), porque un filtro sin label no filtra nada. Eso no es una unidad
 *    rota que da datos raros: es una unidad rota que da datos creíbles.
 */
import { describe, it, expect } from 'vitest';
import { unitSource, linearIssueFilter, sourceLabel } from './source.js';

const DESDE = '2026-07-11T00:00:00.000Z';

describe('unitSource: qué mide esta unidad', () => {
  it('un equipo de Linear, cuando lo declara', () => {
    expect(unitSource({ linearTeamKey: 'MAT' })).toEqual({ kind: 'team', value: 'MAT' });
  });

  it('un label, que es lo de siempre', () => {
    expect(unitSource({ linearLabel: 'CAEs' })).toEqual({ kind: 'label', value: 'CAEs' });
  });

  it('el equipo manda sobre el label: es el filtro más específico de los dos', () => {
    expect(unitSource({ linearTeamKey: 'MAT', linearLabel: 'CAEs' })).toEqual({ kind: 'team', value: 'MAT' });
  });

  it('sin nada que medir lo dice, en vez de dejarlo en blanco', () => {
    expect(unitSource({})).toEqual({ kind: 'none', value: '' });
    expect(unitSource({ linearLabel: '   ' })).toEqual({ kind: 'none', value: '' });
    expect(unitSource()).toEqual({ kind: 'none', value: '' });
  });
});

describe('linearIssueFilter: el filtro que se le manda a Linear', () => {
  it('por equipo', () => {
    expect(linearIssueFilter({ linearTeamKey: 'PLA' }, DESDE))
      .toEqual({ team: { key: { eq: 'PLA' } }, updatedAt: { gte: DESDE } });
  });

  it('por label', () => {
    expect(linearIssueFilter({ linearLabel: 'Trust' }, DESDE))
      .toEqual({ labels: { name: { eq: 'Trust' } }, updatedAt: { gte: DESDE } });
  });

  it('sin fuente devuelve null: NO se pregunta por todo', () => {
    // Es el fallo que dejó una unidad midiendo el workspace entero. Un filtro
    // vacío no es «sin filtro», es «tráemelo todo», y el número resultante
    // parece una métrica de equipo.
    expect(linearIssueFilter({}, DESDE)).toBeNull();
  });
});

describe('sourceLabel: qué se le enseña a quien configura', () => {
  it('nombra la fuente, sin hacer adivinar', () => {
    expect(sourceLabel({ linearTeamKey: 'MAT' })).toBe('Equipo MAT');
    expect(sourceLabel({ linearLabel: 'CAEs' })).toBe('Label «CAEs»');
    expect(sourceLabel({})).toBe('Sin fuente');
  });
});
