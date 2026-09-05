/**
 * <lean-app> — shell de la herramienta LEAN / Flujo (métricas de cómo fluye el
 * trabajo del equipo, desde Linear). Dos pestañas: Equipos (config) y Métricas.
 * Extiende MetricsToolApp (base compartida con DORA). Recibe persistence, canEdit
 * y refresh inyectados desde client/lean.js.
 */
import { html } from 'lit';
import './lean-teams.js';
import './lean-metrics.js';
import './lean-old-issues.js';
import { MetricsToolApp } from '../shared/metrics-tool-app.js';

export class LeanApp extends MetricsToolApp {
  static properties = {
    ...MetricsToolApp.properties,
    discover: { attribute: false },
    listTeams: { attribute: false },
    interpret: { attribute: false },
    loadSaved: { attribute: false },
    canInterpret: { attribute: false },
  };

  static tabs = [
    { id: 'teams', label: 'Equipos' },
    { id: 'metrics', label: 'Métricas' },
    { id: 'atascos', label: 'Atascos' },
  ];

  constructor() {
    super();
    this.discover = null;
    this.listTeams = null;
    this.interpret = null;
    this.loadSaved = null;
    this.canInterpret = false;
  }

  get disclaimer() {
    return html`Las métricas de flujo miden cómo <strong>fluye el trabajo del equipo</strong> (throughput, ciclo, WIP, atascos), no el rendimiento de personas concretas. Complementan a DORA; no las uses para evaluar a ingenieros individuales.`;
  }

  renderView() {
    if (this.view === 'teams') {
      return html`<lean-teams .persistence=${this.persistence} .canEdit=${this.canEdit} .refresh=${this.refresh} .discover=${this.discover} .listTeams=${this.listTeams}></lean-teams>`;
    }
    if (this.view === 'atascos') {
      return html`<lean-old-issues .persistence=${this.persistence} .refresh=${this.refresh}></lean-old-issues>`;
    }
    return html`<lean-metrics
      .persistence=${this.persistence}
      .refresh=${this.refresh}
      .interpret=${this.interpret}
      .loadSaved=${this.loadSaved}
      .canInterpret=${this.canInterpret}
    ></lean-metrics>`;
  }
}

if (!customElements.get('lean-app')) {
  customElements.define('lean-app', LeanApp);
}
