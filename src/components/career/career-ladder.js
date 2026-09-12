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
      margin: 0 0 0.4rem; background: var(--rm-surface, #fff);
    }
    .rung.mine { border-color: var(--rm-accent, #2a9d8f); border-left-width: 4px; }
    .rung > summary {
      display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap;
      padding: 0.6rem 0.9rem; cursor: pointer; border-radius: 10px;
    }
    .rung > summary:focus-visible { outline: 2px solid var(--rm-accent, #2a9d8f); outline-offset: 2px; }
    /* Con el summary en flex, Chrome esconde el marcador nativo y la fila
       parece muerta: se pone uno propio para que se vea que abre. */
    .rung > summary::-webkit-details-marker { display: none; }
    .rung > summary::marker { content: ''; }
    .chev {
      color: var(--rm-muted, #5b6b7d); font-weight: 700; line-height: 1;
      transition: transform 0.15s ease-out; display: inline-block;
    }
    .rung[open] > summary .chev { transform: rotate(90deg); }
    @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
    .rung[open] > summary { border-bottom: 1px solid var(--rm-border, #eef0f2); border-radius: 10px 10px 0 0; }
    .detail { padding: 0.6rem 0.9rem 0.8rem; }
    .rung .code { font-weight: 800; color: var(--rm-accent, #2a9d8f); font-size: 0.9rem; }
    .rung .title { font-weight: 700; font-size: 0.9rem; }
    .rung .mark {
      font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--rm-on-accent, #fff); background: var(--rm-accent, #2a9d8f);
      border-radius: 999px; padding: 0.1rem 0.5rem;
    }
    .rung .profile { font-size: 0.78rem; color: var(--rm-muted, #5b6b7d); margin-left: auto; }
    .rung .desc { font-size: 0.85rem; margin: 0 0 0.7rem; }
    .exps { display: grid; gap: 0.5rem; }
    .exp { border-top: 1px solid var(--rm-border, #eef0f2); padding-top: 0.45rem; }
    .exp .dim { font-weight: 700; font-size: 0.83rem; }
    .exp-text { font-size: 0.83rem; color: var(--rm-text, #111827); margin: 0.15rem 0 0; }
    .exp .todo { color: var(--rm-muted, #5b6b7d); font-style: italic; font-size: 0.83rem; margin-left: 0.4rem; }
    @media (prefers-reduced-motion: no-preference) {
      .rung[open] .detail { animation: fold-in 0.16s ease-out; }
      @keyframes fold-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
    }
  `;

  constructor() {
    super();
    this.framework = null;
    this.person = null;
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

  /**
   * Un peldaño: en la lista solo su código, su título y a quién describe. El
   * detalle se despliega a voluntad — con los doce niveles y sus expectativas
   * abiertos de golpe, la página es un muro de texto y no se ve nada.
   */
  _renderLevel(l, miNivel, miObjetivo) {
    const marca = this._mark(l.id, miNivel, miObjetivo);
    return html`
      <details class="rung ${marca ? 'mine' : ''}">
        <summary>
          <span class="chev" aria-hidden="true">›</span>
          <span class="code">${l.code}</span>
          <span class="title">${l.title}</span>
          ${marca ? html`<span class="mark">${marca}</span>` : null}
          ${l.typicalProfile ? html`<span class="profile">${l.typicalProfile}</span>` : null}
        </summary>
        <div class="detail">
          ${l.description ? html`<p class="desc">${l.description}</p>` : null}
          ${l.expectations.length > 0
            ? html`<div class="exps">${l.expectations.map((e) => this._exp(e.dimension.name, e.text))}</div>`
            : html`<p class="empty">Sin expectativas escritas todavía.</p>`}
        </div>
      </details>`;
  }

  /** Etiqueta de «estás aquí» / «vas aquí», o null. Sin ternarios anidados. */
  _mark(levelId, miNivel, miObjetivo) {
    if (levelId === miNivel) return 'Estás aquí';
    if (levelId === miObjetivo) return 'Tu objetivo';
    return null;
  }

  /** Lo que se espera en una dimensión. A la vista: el plegado ya lo hace el nivel. */
  _exp(name, text) {
    return html`
      <div class="exp">
        <span class="dim">${name}</span>
        ${text ? html`<p class="exp-text">${text}</p>` : html`<span class="todo">pendiente de definir</span>`}
      </div>`;
  }
}

if (!customElements.get('career-ladder')) {
  customElements.define('career-ladder', CareerLadder);
}
