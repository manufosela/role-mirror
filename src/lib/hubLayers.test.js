/**
 * Tests de las CAPAS del hub (ADR «Tres capas en el hub», RMR-TSK-0487).
 *
 * La regla que sostiene todo esto: las pestañas se derivan de las tarjetas que
 * YA han quedado visibles, nunca de un cálculo paralelo a partir del rol. Si se
 * calcularan aparte habría dos fuentes de verdad, y el síntoma sería una pestaña
 * vacía o —peor— una pestaña que aparece simulando un rol que no la tiene, que
 * miente con aspecto de verdad.
 */
import { describe, it, expect } from 'vitest';
import { LAYERS, layerTabs, activeTab } from './hubLayers.js';

describe('layerTabs: qué pestañas se pintan', () => {
  it('con herramientas de las dos capas, las dos pestañas', () => {
    const tabs = layerTabs({ layersWithCards: ['tribbu', 'ingenieria'] });
    expect(tabs.visible).toBe(true);
    expect(tabs.tabs).toEqual([
      { id: 'tribbu', label: 'TRIBBU' },
      { id: 'ingenieria', label: 'Ingeniería' },
    ]);
  });

  it('con una sola capa NO se pintan pestañas: una pestaña sola no es una pestaña', () => {
    // Es el caso de quien no es de ingeniería: ve sus herramientas y punto,
    // sin un control que sugiera que hay algo más en otro sitio.
    expect(layerTabs({ layersWithCards: ['tribbu'] }).visible).toBe(false);
  });

  it('el orden es siempre el mismo, dé igual cómo lleguen las capas', () => {
    // TRIBBU primero porque es lo que ve TODO el mundo; ingeniería es el añadido.
    const tabs = layerTabs({ layersWithCards: ['ingenieria', 'tribbu'] });
    expect(tabs.tabs.map((t) => t.id)).toEqual(['tribbu', 'ingenieria']);
  });

  it('una capa sin ninguna tarjeta visible no genera pestaña', () => {
    // Si las políticas dejan a alguien sin nada de ingeniería, la pestaña no se
    // pinta: una pestaña que se abre y no tiene nada dentro es un callejón.
    const tabs = layerTabs({ layersWithCards: ['tribbu'] });
    expect(tabs.tabs.map((t) => t.id)).toEqual(['tribbu']);
  });

  it('sin nada visible no hay pestañas ni se rompe', () => {
    expect(layerTabs({ layersWithCards: [] })).toEqual({ visible: false, tabs: [] });
    expect(layerTabs()).toEqual({ visible: false, tabs: [] });
  });

  it('ignora capas que no existen, en vez de inventarles pestaña', () => {
    const tabs = layerTabs({ layersWithCards: ['tribbu', 'ingenieria', 'marketing'] });
    expect(tabs.tabs.map((t) => t.id)).toEqual(['tribbu', 'ingenieria']);
  });
});

describe('activeTab: cuál queda abierta', () => {
  const dos = ['tribbu', 'ingenieria'];

  it('por defecto, la primera', () => {
    expect(activeTab({ layersWithCards: dos })).toBe('tribbu');
  });

  it('respeta la que se estaba mirando', () => {
    expect(activeTab({ layersWithCards: dos, remembered: 'ingenieria' })).toBe('ingenieria');
  });

  it('si la recordada ya no está disponible, cae a la primera', () => {
    // Pasa al simular otro rol: estabas en Ingeniería y ese rol no la tiene.
    // Sin esto, el hub se quedaría enseñando una pestaña que ya no existe.
    expect(activeTab({ layersWithCards: ['tribbu'], remembered: 'ingenieria' })).toBe('tribbu');
  });

  it('sin capas no hay pestaña activa', () => {
    expect(activeTab({ layersWithCards: [] })).toBeNull();
  });
});

describe('LAYERS: el catálogo de capas', () => {
  it('son dos, y la general va primero', () => {
    expect(LAYERS.map((l) => l.id)).toEqual(['tribbu', 'ingenieria']);
  });
});
