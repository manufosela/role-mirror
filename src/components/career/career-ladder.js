/**
 * <career-ladder> — LA ESCALERA: todos los itinerarios con sus niveles y lo que
 * se espera en cada dimensión (RMR-TSK-0471, extraído en RMR-TSK-0488).
 *
 * Vivía dentro de «Mi espacio › Mi carrera» y solo se llegaba metiéndose en una
 * sub-pestaña de una herramienta personal. Saber qué se espera de cada nivel no
 * es un detalle de tu ficha: es la referencia que se mira antes de una promoción
 * o de un 1:1 de desarrollo. Ahora es un componente propio y se usa en los dos
 * sitios —en Mi carrera y como herramienta— sin duplicar el contenido.
 *
 * Si se le pasa una persona, marca dónde está y, si lo ha declarado, a dónde va.
 * Sin persona pinta la escalera igual: el marco de niveles es de la organización,
 * no de quien lo mira.
 */
import { LitElement, html, css } from 'lit';
import { careerLadder } from '../../tools/career/data/framework.js';

export class CareerLadder extends LitElement {
  static properties = {
    framework: { attribute: false },
    person: { attribute: false },
    /**
     * Expectativas desplegadas de entrada. En la herramienta sí: se viene a
     * consultar qué implica cada nivel, y encontrarlo plegado es el mismo
     * recoveco con otra forma. Dentro de «Mi carrera» no, porque ahí la
     * escalera acompaña a otras cosas y ocuparía la pantalla entera.
     */
    open: { type: Boolean },
  };

  static styles = css`
    :host { display: block; }
    .intro { font-size: 0.85rem; color: var(--rm-muted, #5b6b7d); margin: 0 0 1rem; }
    .empty { color: var(--rm-muted, #5b6b7d); font-size: 0.9rem; }

    /* Un bloque por itinerario y un peldaño por nivel. El peldaño propio se
       marca con el acento, no con un color nuevo. */
    .track { margin: 0 0 1.6rem; }
    .track h3 { font-size: 0.95rem; margin: 0 0 0.15rem; color: var(--rm-text, #111827); }
    .track-desc { font-size: 0.82rem; color: var(--rm-muted, #5b6b7d); margin: 0 0 0.7rem; }
    .rung {
      border: 1px solid var(--rm-border, #e5e7eb); border-radius: 10px;
      padding: 0.7rem 0.9rem; margin: 0 0 0.6rem; background: var(--rm-surface, #fff);
    }
    .rung.mine { border-color: var(--rm-accent, #2a9d8f); border-left-width: 4px; }
    .rung header { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
    .rung .code { font-weight: 800; color: var(--rm-accent, #2a9d8f); font-size: 0.9rem; }
    .rung .title { font-weight: 700; font-size: 0.9rem; }
    .rung .mark {
      font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--rm-on-accent, #fff); background: var(--rm-accent, #2a9d8f);
      border-radius: 999px; padding: 0.1rem 0.5rem;
    }
    .rung .profile { font-size: 0.78rem; color: var(--rm-muted, #5b6b7d); margin-left: auto; }
    .rung .desc { font-size: 0.85rem; margin: 0.35rem 0 0.5rem; }
    .rung .exps { border-top: 1px solid var(--rm-border, #eef0f2); }

    .fold { border-top: 1px solid var(--rm-border, #eef0f2); }
    .fold summary { cursor: pointer; padding: 0.45rem 0; font-size: 0.85rem; }
    .fold summary::-webkit-details-marker { color: var(--rm-muted, #5b6b7d); }
    .fold summary:focus-visible { outline: 2px solid var(--rm-accent, #2a9d8f); outline-offset: 2px; border-radius: 4px; }
    .fold .dim { font-weight: 700; }
    .fold-body { font-size: 0.83rem; color: var(--rm-text, #111827); margin: 0.1rem 0 0.5rem; padding-left: 1.1rem; }
    .fold-empty { display: flex; gap: 0.4rem; align-items: baseline; padding: 0.45rem 0; font-size: 0.85rem; }
    .fold-empty .todo { color: var(--rm-muted, #5b6b7d); font-style: italic; }
    @media (prefers-reduced-motion: no-preference) {
      .fold[open] .fold-body { animation: fold-in 0.16s ease-out; }
      @keyframes fold-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
    }
  `;

  constructor() {
    super();
    this.framework = null;
    this.person = null;
    this.open = false;
  }

  render() {
    const escalera = careerLadder(this.framework);
    if (escalera.length === 0) {
      return html`<p class="empty">El framework de carrera aún no está configurado.</p>`;
    }
    const miNivel = this.person?.levelId ?? null;
    const miObjetivo = this.person?.careerTargetLevelId ?? null;
    return html`
      ${this._renderIntro(miNivel, miObjetivo)}
      ${escalera.map(({ track, levels }) => html`
        <section class="track">
          <h3>${track.name}</h3>
          ${track.description ? html`<p class="track-desc">${track.description}</p>` : null}
          ${levels.map((l) => this._renderLevel(l, miNivel, miObjetivo))}
        </section>`)}
    `;
  }

  /** Sin persona no se promete ninguna marca: el marco es de la organización. */
  _renderIntro(miNivel, miObjetivo) {
    if (!miNivel && !miObjetivo) {
      return html`<p class="intro">Todos los itinerarios y sus niveles, con lo que se espera en cada dimensión.</p>`;
    }
    return html`
      <p class="intro">
        Todos los itinerarios y sus niveles, con lo que se espera en cada dimensión.
        Tu nivel actual va marcado${miObjetivo ? ' y tu objetivo también' : ''}.
      </p>`;
  }

  _renderLevel(l, miNivel, miObjetivo) {
    const marca = this._mark(l.id, miNivel, miObjetivo);
    return html`
      <article class="rung ${marca ? 'mine' : ''}">
        <header>
          <span class="code">${l.code}</span>
          <span class="title">${l.title}</span>
          ${marca ? html`<span class="mark">${marca}</span>` : null}
          ${l.typicalProfile ? html`<span class="profile">${l.typicalProfile}</span>` : null}
        </header>
        ${l.description ? html`<p class="desc">${l.description}</p>` : null}
        ${l.expectations.length > 0
          ? html`<div class="exps">${l.expectations.map((e) => this._fold(e.dimension.name, e.text))}</div>`
          : html`<p class="empty">Sin expectativas escritas todavía.</p>`}
      </article>`;
  }

  /** Etiqueta de «estás aquí» / «vas aquí», o null. Sin ternarios anidados. */
  _mark(levelId, miNivel, miObjetivo) {
    if (levelId === miNivel) return 'Estás aquí';
    if (levelId === miObjetivo) return 'Tu objetivo';
    return null;
  }

  /** Una expectativa: plegada si tiene texto, y dicha como pendiente si no. */
  _fold(name, text) {
    if (!text) {
      return html`
        <div class="fold fold-empty">
          <span class="dim">${name}</span>
          <span class="todo">pendiente de definir</span>
        </div>`;
    }
    return html`
      <details class="fold" ?open=${this.open}>
        <summary><span class="dim">${name}</span></summary>
        <p class="fold-body">${text}</p>
      </details>`;
  }
}

if (!customElements.get('career-ladder')) {
  customElements.define('career-ladder', CareerLadder);
}
