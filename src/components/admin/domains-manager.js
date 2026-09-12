/**
 * <domains-manager> — catálogo de DOMINIOS y SUBDOMINIOS
 * (ADR «De squads a dominios y subdominios»).
 *
 * Un dominio es un producto o ámbito grande; un subdominio, la unidad fina donde
 * ocurre el trabajo. Sustituyen al squad, que mezclaba «dónde se trabaja» con
 * «quién pertenece»: con equipos fluidos lo segundo deja de tener sentido.
 *
 * Lo que esta pantalla tiene que dejar claro por encima de todo es la diferencia
 * entre la CLAVE y el NOMBRE. La clave es el contrato con el portal —se asigna
 * una vez y no se toca— y el nombre es un rótulo que se puede cambiar cuando se
 * quiera. Confundirlos es lo que hoy parte las series históricas al renombrar,
 * así que aquí la clave se enseña siempre, y al editar solo se ofrece el nombre.
 */
import { LitElement, html, css } from 'lit';
import { noteStyles } from '../common/note-styles.js';
import {
  listDomains, listSubdomains, createDomainWithCore, createSubdomain,
  renameScope, deleteSubdomain,
} from '../../lib/domains.js';
import {
  suggestKey, coreKeyFor, validateKey, groupByDomain, CORE_NAME,
} from '../../tools/team/domain/domains.js';

export class DomainsManager extends LitElement {
  static properties = {
    ready: { type: Boolean },
    readOnly: { type: Boolean, attribute: 'read-only' },
    _domains: { state: true },
    _subdomains: { state: true },
    _newDomain: { state: true },
    _newDomainKey: { state: true },
    _newSub: { state: true },
    _editing: { state: true },
    _editValue: { state: true },
    _confirmRemove: { state: true },
    _error: { state: true },
    _notice: { state: true },
    _busy: { state: true },
    /** ¿Está el catálogo en la mano? Sin él no se puede validar la unicidad. */
    _cargado: { state: true },
  };

  static styles = [noteStyles, css`
    :host { display: block; }
    h2 { font-size: 1.1rem; margin: 0 0 1rem; }
    .domain {
      border: 1px solid var(--rm-border, #e5e7eb); border-radius: 12px;
      padding: 0.85rem 1rem; margin: 0 0 0.9rem; background: var(--rm-surface, #fff);
    }
    .domain-head { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
    .domain-head .name { font-weight: 800; font-size: 0.98rem; }
    .key {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem;
      background: var(--rm-chip, #eef2f7); border: 1px solid var(--rm-border, #d1d5db);
      border-radius: 999px; padding: 0.05rem 0.5rem; color: var(--rm-muted, #5b6b7d);
    }
    .subs { list-style: none; margin: 0.7rem 0 0; padding: 0; display: grid; gap: 0.4rem; }
    .subs li {
      display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
      padding: 0.4rem 0.6rem; border-radius: 8px;
      background: color-mix(in srgb, var(--rm-text, #111827) 3%, transparent);
    }
    .subs .name { font-weight: 600; font-size: 0.9rem; }
    .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-top: 0.6rem; }
    input {
      padding: 0.4rem 0.55rem; border-radius: 8px; border: 1px solid var(--rm-border, #d1d5db);
      font: inherit; font-size: 0.88rem; background: var(--rm-field, #eef2f6); color: var(--rm-text, #111827);
    }
    input.key-input { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; width: 12rem; }
    button {
      padding: 0.35rem 0.7rem; border-radius: 8px; border: 1px solid var(--rm-border, #d1d5db);
      background: var(--rm-surface, #fff); font: inherit; font-size: 0.85rem; cursor: pointer;
    }
    button.primary { background: var(--rm-accent, #2a9d8f); color: var(--rm-on-accent, #fff); border-color: transparent; }
    button:disabled { opacity: 0.5; cursor: default; }
    .del { color: var(--rm-danger, #b91c1c); border-color: currentColor; margin-left: auto; }
    .error { color: var(--rm-danger, #b91c1c); font-size: 0.85rem; margin: 0.5rem 0 0; }
    .notice { color: var(--rm-ok, #15803d); font-size: 0.85rem; margin: 0.5rem 0 0; }
    .muted { color: var(--rm-muted, #5b6b7d); font-size: 0.82rem; }
    .confirm { display: inline-flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; font-size: 0.82rem; margin-left: auto; }
  `];

  constructor() {
    super();
    this.ready = false;
    this.readOnly = false;
    this._domains = [];
    this._subdomains = [];
    this._newDomain = '';
    this._newDomainKey = '';
    this._newSub = {};
    this._editing = null;
    this._editValue = '';
    this._confirmRemove = null;
    this._error = '';
    this._notice = '';
    this._busy = false;
    this._cargado = false;
    this._loaded = false;
  }

  updated() {
    if (this.ready && !this._loaded) {
      this._loaded = true;
      this._load();
    }
  }

  async _load() {
    try {
      const [domains, subdomains] = await Promise.all([listDomains(), listSubdomains()]);
      this._domains = domains;
      this._subdomains = subdomains;
      this._cargado = true;
    } catch {
      this._error = 'No se pudo cargar el catálogo de dominios.';
    }
  }

  /** Envuelve una escritura: bloquea, limpia avisos y recarga al terminar. */
  async _write(fn, okMessage) {
    this._busy = true;
    this._error = '';
    this._notice = '';
    try {
      await fn();
      await this._load();
      this._notice = okMessage;
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'No se pudo guardar.';
    } finally {
      this._busy = false;
    }
  }

  /** La clave se propone desde el nombre, pero solo AL CREAR: nunca se recalcula. */
  _onNewDomainName(value) {
    const antes = suggestKey(this._newDomain);
    this._newDomain = value;
    // Si no se ha tocado a mano, sigue la sugerencia; en cuanto se edita, manda.
    if (!this._newDomainKey || this._newDomainKey === antes) this._newDomainKey = suggestKey(value);
  }

  async _addDomain() {
    // Sin catálogo no se crea nada: validar la unicidad de la clave contra una
    // lista vacía la daría por libre SIEMPRE, y dos entidades con la misma clave
    // son indistinguibles para el resto de sistemas.
    if (!this._cargado) return;
    const name = this._newDomain.trim();
    const key = this._newDomainKey.trim();
    if (!name) { this._error = 'El dominio necesita un nombre.'; return; }
    // Se comprueba contra TODO el catálogo, dominios y subdominios: la clave
    // identifica la entidad para el resto de sistemas, y dos entidades con la
    // misma clave son indistinguibles ahí fuera. Y con ella, la de su «Core»,
    // que nace en la misma escritura — validar solo una deja pasar la otra.
    const todas = [...this._domains, ...this._subdomains];
    const check = validateKey(key, todas);
    if (!check.ok) { this._error = check.reason; return; }
    const core = validateKey(coreKeyFor(key), todas);
    if (!core.ok) { this._error = `Su ${CORE_NAME} no cabe: ${core.reason}`; return; }
    await this._write(async () => {
      // El dominio y su «Core» nacen en la misma escritura: las métricas siempre
      // cuelgan de un subdominio, y un dominio a medio crear sería inmedible.
      await createDomainWithCore({ key, name, coreKey: coreKeyFor(key), coreName: CORE_NAME });
      this._newDomain = '';
      this._newDomainKey = '';
    }, `Dominio «${name}» creado, con su ${CORE_NAME}.`);
  }

  async _addSubdomain(domain) {
    if (!this._cargado) return;
    const name = String(this._newSub[domain.key] ?? '').trim();
    if (!name) { this._error = 'El subdominio necesita un nombre.'; return; }
    const key = suggestKey(name);
    const check = validateKey(key, [...this._domains, ...this._subdomains]);
    if (!check.ok) { this._error = check.reason; return; }
    await this._write(async () => {
      await createSubdomain({ key, name, domainKey: domain.key });
      this._newSub = { ...this._newSub, [domain.key]: '' };
    }, `Subdominio «${name}» añadido a ${domain.name}.`);
  }

  /** Abre la edición del nombre en su sitio, sin diálogos del navegador. */
  _startRename(entity) {
    this._editing = entity.id;
    this._editValue = entity.name;
    this._error = '';
  }

  async _commitRename(kind, entity) {
    const value = String(this._editValue ?? '').trim();
    this._editing = null;
    if (!value || value === entity.name) return;
    // La clave NO se toca: ese es el punto del modelo.
    await this._write(() => renameScope(kind, entity.id, value),
      `Renombrado a «${value}». Su clave sigue siendo «${entity.key}».`);
  }

  /** Nombre editable en línea, o el rótulo con su botón. */
  _renderName(kind, entity) {
    if (this._editing === entity.id) {
      return html`<input type="text" .value=${this._editValue} aria-label="Nombre de ${entity.name}"
        @input=${(e) => { this._editValue = e.target.value; }}
        @keydown=${(e) => {
          if (e.key === 'Enter') this._commitRename(kind, entity);
          if (e.key === 'Escape') this._editing = null;
        }}
        @blur=${() => this._commitRename(kind, entity)} />`;
    }
    return html`<span class="name">${entity.name}</span>`;
  }

  render() {
    if (!this.ready) return html`<p class="muted">Cargando…</p>`;
    const { tree, orphans } = groupByDomain(this._domains, this._subdomains);
    return html`
      <section>
        <h2>Dominios y subdominios</h2>
        <p class="info-note">
          El <strong>dominio</strong> es el producto o ámbito grande; el <strong>subdominio</strong>,
          la unidad fina donde ocurre el trabajo, y es la que se mide. La <strong>clave</strong> de
          cada uno es su identidad para el resto de sistemas: se asigna al crearlo y no cambia nunca.
          El nombre, en cambio, se puede cambiar cuando haga falta.
        </p>
        ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : null}
        ${this._notice ? html`<p class="notice">${this._notice}</p>` : null}

        ${tree.length === 0 && orphans.length === 0
          ? html`<p class="muted">Todavía no hay ningún dominio. El primero que crees nacerá con su «${CORE_NAME}».</p>`
          : null}
        ${tree.map(({ domain, subdomains }) => this._renderDomain(domain, subdomains))}
        ${orphans.length > 0 ? this._renderOrphans(orphans) : null}
        ${this.readOnly ? null : this._renderNewDomain()}
      </section>`;
  }

  _renderDomain(domain, subdomains) {
    return html`
      <article class="domain">
        <header class="domain-head">
          ${this._renderName('domain', domain)}
          <span class="key" title="Identidad de este dominio para el resto de sistemas. No cambia.">${domain.key}</span>
          ${this.readOnly || this._editing === domain.id ? null : html`<button ?disabled=${this._busy}
            @click=${() => this._startRename(domain)}>Renombrar</button>`}
        </header>
        <ul class="subs">
          ${subdomains.map((s) => html`<li>
            ${this._renderName('subdomain', s)}
            <span class="key">${s.key}</span>
            ${this.readOnly ? null : this._renderSubActions(s)}
          </li>`)}
        </ul>
        ${this.readOnly ? null : html`<div class="row">
          <input type="text" placeholder="Nuevo subdominio" .value=${this._newSub[domain.key] ?? ''}
            @input=${(e) => { this._newSub = { ...this._newSub, [domain.key]: e.target.value }; }} />
          <button ?disabled=${this._busy || !this._cargado}
            @click=${() => this._addSubdomain(domain)}>Añadir subdominio</button>
        </div>`}
      </article>`;
  }

  /** Un subdominio cuyo dominio ya no existe: se enseña para poder arreglarlo. */
  _renderOrphans(orphans) {
    return html`
      <article class="domain">
        <header class="domain-head"><span class="name">Sin dominio</span></header>
        <p class="info-note strong">
          Estos subdominios apuntan a un dominio que no existe. No se pueden medir mientras sigan así:
          el portal no sabría a qué sumarlos.
        </p>
        <ul class="subs">
          ${orphans.map((s) => html`<li>
            <span class="name">${s.name}</span>
            <span class="key">${s.key}</span>
            <span class="muted">apunta a «${s.domainKey}»</span>
          </li>`)}
        </ul>
      </article>`;
  }

  _renderNewDomain() {
    return html`
      <div class="row">
        <input type="text" placeholder="Nuevo dominio" .value=${this._newDomain}
          @input=${(e) => this._onNewDomainName(e.target.value)} />
        <input class="key-input" type="text" placeholder="clave" .value=${this._newDomainKey}
          @input=${(e) => { this._newDomainKey = e.target.value; }} />
        <button class="primary" ?disabled=${this._busy || !this._cargado}
          @click=${() => this._addDomain()}>Añadir dominio</button>
      </div>
      <p class="muted">Nace con su «${CORE_NAME}»: las métricas siempre cuelgan de un subdominio.</p>`;
  }

  /**
   * Acciones de un subdominio, con la confirmación EN SU FILA: quitarlo con
   * métricas publicadas deja su serie sin dueño en el portal, así que se dice lo
   * que implica antes de hacerlo — y sin diálogos del navegador.
   */
  _renderSubActions(sub) {
    if (this._confirmRemove === sub.id) {
      return html`<span class="confirm">
        Si ya tiene métricas, su serie se queda sin dueño. ¿Quitar?
        <button class="del" ?disabled=${this._busy} @click=${() => this._removeSub(sub)}>Sí, quitar</button>
        <button @click=${() => { this._confirmRemove = null; }}>No</button>
      </span>`;
    }
    return html`
      ${this._editing === sub.id ? null : html`<button ?disabled=${this._busy}
        @click=${() => this._startRename(sub)}>Renombrar</button>`}
      <button class="del" ?disabled=${this._busy} @click=${() => { this._confirmRemove = sub.id; }}>Quitar</button>`;
  }

  async _removeSub(sub) {
    this._confirmRemove = null;
    await this._write(() => deleteSubdomain(sub.id), `«${sub.name}» retirado.`);
  }
}

if (!customElements.get('domains-manager')) {
  customElements.define('domains-manager', DomainsManager);
}
