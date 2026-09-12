/**
 * CAPAS del hub (ADR «Tres capas en el hub: TRIBBU, Ingeniería y la
 * administración como enlace»).
 *
 * El hub era una parrilla plana de quince tarjetas donde Moving Motivators
 * —que usa toda la empresa— aparecía con el mismo peso que DORA. Ahora cada
 * herramienta pertenece a una capa: TRIBBU es lo que sirve a cualquiera, e
 * Ingeniería lo que no tiene sentido fuera de ingeniería.
 *
 * REGLA QUE SOSTIENE ESTE MÓDULO: las pestañas se derivan de las tarjetas que
 * YA han quedado visibles tras aplicar políticas, ficha y vista simulada. No se
 * calculan desde el rol en paralelo. Calcularlas aparte daría dos fuentes de
 * verdad, y el síntoma sería una pestaña vacía o una pestaña que aparece al
 * simular un rol que no la tiene — que miente con aspecto de verdad.
 *
 * Y no protegen: quien navegue directo por URL se topa igual con el gate de
 * página, la política de la herramienta y las reglas de Firestore.
 *
 * Puro: sin DOM ni Firebase, para poder probar todas las reglas sin montar nada.
 *
 * @typedef {'tribbu'|'ingenieria'} LayerId
 * @typedef {{ id: LayerId, label: string }} Layer
 */

/**
 * Las capas, en el orden en que se pintan. TRIBBU va primero porque es lo que ve
 * TODO el mundo; ingeniería es el añadido de quien además es de ingeniería.
 * @type {ReadonlyArray<Layer>}
 */
export const LAYERS = Object.freeze([
  Object.freeze({ id: 'tribbu', label: 'TRIBBU' }),
  Object.freeze({ id: 'ingenieria', label: 'Ingeniería' }),
]);

/**
 * Pestañas a pintar, a partir de las capas que tienen alguna tarjeta visible.
 *
 * Con una sola capa NO se pintan: una pestaña sola no es una pestaña, solo un
 * adorno que sugiere que hay algo más en otro sitio.
 *
 * @param {{ layersWithCards?: ReadonlyArray<string> }} [input]
 * @returns {{ visible: boolean, tabs: Layer[] }}
 */
export function layerTabs(input = {}) {
  const conTarjetas = new Set(input.layersWithCards ?? []);
  const tabs = LAYERS.filter((l) => conTarjetas.has(l.id)).map((l) => ({ ...l }));
  return { visible: tabs.length > 1, tabs };
}

/**
 * Pestaña abierta: la que se estaba mirando si sigue disponible, y si no, la
 * primera. Lo segundo pasa al simular otro rol —estabas en Ingeniería y ese rol
 * no la tiene—: sin esta caída, el hub seguiría enseñando una pestaña que ya no
 * existe.
 *
 * @param {{ layersWithCards?: ReadonlyArray<string>, remembered?: string|null }} [input]
 * @returns {LayerId|null}
 */
export function activeTab(input = {}) {
  const { tabs } = layerTabs(input);
  if (tabs.length === 0) return null;
  const recordada = tabs.find((t) => t.id === input.remembered);
  return (recordada ?? tabs[0]).id;
}
