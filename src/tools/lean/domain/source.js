/**
 * FUENTE de una unidad de flujo: de dónde salen las issues que se miden.
 *
 * Al principio solo había una: un LABEL de Linear del grupo «Squad» o «Chapter».
 * Al mirar los datos de verdad apareció el hueco: Matcher y Plataforma son
 * EQUIPOS de Linear —110 y 105 issues vivas— y ninguna de sus issues lleva
 * label de Squad. Medirlos por label es imposible, así que una unidad puede
 * declarar también el equipo.
 *
 * Y una regla que no estaba: una unidad SIN fuente no mide. Antes, un filtro sin
 * label no filtraba nada y devolvía el workspace entero; el resultado (243
 * completadas, 101 WIP) tenía toda la pinta de una métrica de equipo. Un dato
 * roto que parece bueno es peor que un error.
 *
 * Puro: sin red, para poder probar el filtro sin llamar a Linear.
 *
 * @typedef {{ linearLabel?: string, linearTeamKey?: string }} UnitLike
 * @typedef {{ kind: 'team'|'label'|'none', value: string }} Source
 */

const limpia = (v) => String(v ?? '').trim();

/**
 * Qué mide una unidad. El EQUIPO manda sobre el label cuando están los dos: es
 * el filtro más específico, y mezclarlos contaría dos veces lo mismo.
 * @param {UnitLike} [unit]
 * @returns {Source}
 */
export function unitSource(unit) {
  const team = limpia(unit?.linearTeamKey);
  if (team) return { kind: 'team', value: team };
  const label = limpia(unit?.linearLabel);
  if (label) return { kind: 'label', value: label };
  return { kind: 'none', value: '' };
}

/**
 * Filtro de issues para la API de Linear, o `null` si la unidad no tiene nada
 * que medir. `null` es una respuesta legítima y hay que tratarla: preguntar sin
 * filtro trae TODO el workspace.
 * @param {UnitLike} unit
 * @param {string} sinceIso  desde cuándo mirar (ventana de cálculo)
 * @returns {object|null}
 */
export function linearIssueFilter(unit, sinceIso) {
  const { kind, value } = unitSource(unit);
  const updatedAt = { gte: sinceIso };
  if (kind === 'team') return { team: { key: { eq: value } }, updatedAt };
  if (kind === 'label') return { labels: { name: { eq: value } }, updatedAt };
  return null;
}

/**
 * Cómo se nombra la fuente en la interfaz, para que quien configura vea qué
 * está midiendo sin tener que deducirlo.
 * @param {UnitLike} unit
 * @returns {string}
 */
export function sourceLabel(unit) {
  const { kind, value } = unitSource(unit);
  if (kind === 'team') return `Equipo ${value}`;
  if (kind === 'label') return `Label «${value}»`;
  return 'Sin fuente';
}
