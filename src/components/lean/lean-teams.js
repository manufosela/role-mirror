/**
 * <lean-teams> — configuración de las unidades de flujo (equipos = label del grupo
 * Squad de Linear; gremios = grupo Chapter). Botón «Descubrir desde Linear»
 * (auto-poblado), «Recalcular» y alta/baja manual. Props: persistence, canEdit,
 * refresh, discover.
 */
import { LitElement, html, css } from 'lit';
import { tableStyles } from '../common/table-styles.js';
import { skeletonLines } from '../app-skeleton.js';
import { addUnit, listUnits, removeUnit, linkUnitToSubdomain, classifyUnit } from '../../tools/lean/application/usecases.js';
import { classifyUnits } from '../../tools/lean/domain/scope.js';
import { sourceLabel } from '../../tools/lean/domain/source.js';
import { subdomainChoices } from '../../tools/team/domain/domains.js';
import { listDomains, listSubdomains } from '../../lib/domains.js';

const dateFmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
const fmtWhen = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');
const KIND_LABEL = { squad: 'Equipos', chapter: 'Gremios' };

export class LeanTeams extends LitElement {
  static properties = {
    persistence: { attribute: false },
    canEdit: { attribute: false },
    refresh: { attribute: false },
    discover: { attribute: false },
    listTeams: { attribute: false },
    _units: { state: true },
    _subdomains: { state: true },
    _choices: { state: true },
    _label: { state: true },
    _source: { state: true },
    _team: { state: true },
    _teams: { state: true },
    _kind: { state: true },
    _name: { state: true },
    _refreshing: { state: true },
    _discovering: { state: true },
    _confirmId: { state: true },
    _error: { state: true },
    _loading: { state: true },
    _info: { state: true },
  };

  static styles = [tableStyles, css`
    :host { display: block; }
    .bar { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin: 0 0 1rem; }
    .btn { border: 1px solid var(--rm-border, #d1d5db); background: var(--rm-surface, #fff); color: var(--rm-text, #111827); border-radius: 8px; padding: 0.45rem 0.85rem; font: inherit; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
    .btn.primary { background: var(--rm-accent, #2a9d8f); border-color: var(--rm-accent, #2a9d8f); color: #fff; }
    .btn.danger { color: var(--rm-danger, #dc2626); border-color: var(--rm-danger, #dc2626); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .spacer { flex: 1; }
    .info { font-size: 0.82rem; color: var(--rm-muted, #5b6b7d); margin: 0 0 1rem; }
    details.manual { margin: 0 0 1rem; }
    details.manual summary { cursor: pointer; font-size: 0.82rem; color: var(--rm-muted, #5b6b7d); }
    .manual .row { display: flex; gap: 0.6rem; align-items: end; flex-wrap: wrap; margin: 0.6rem 0 0; }
    label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.76rem; color: var(--rm-muted, #5b6b7d); font-weight: 600; }
    input, select { font: inherit; padding: 0.4rem 0.55rem; border: 1px solid var(--rm-border, #d1d5db); border-radius: 8px; background: var(--rm-field, #eef2f6); color: var(--rm-text, #111827); }
    h4 { font-size: 0.85rem; color: var(--rm-navy, #1e3a5f); margin: 1.1rem 0 0.4rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--rm-border, #eef0f2); }
    th { color: var(--rm-muted, #5b6b7d); font-weight: 600; }
    .label-cell { font-weight: 700; }
    .muted { color: var(--rm-muted, #5b6b7d); }
    .err { color: var(--rm-danger, #dc2626); font-size: 0.8rem; }
    .empty { color: var(--rm-muted, #5b6b7d); font-size: 0.9rem; }
    .error { color: var(--rm-danger, #dc2626); font-size: 0.85rem; }
    .warn { color: var(--rm-text, #111827); background: color-mix(in srgb, var(--rm-warn, #b45309) 12%, transparent); border-left: 3px solid var(--rm-warn, #b45309); border-radius: 6px; padding: 0.45rem 0.7rem; font-size: 0.82rem; margin: 0 0 0.6rem; }
    .actions { display: flex; gap: 0.35rem; justify-content: flex-end; }
  `];

  constructor() {
    super();
    this.persistence = null;
    this.canEdit = false;
    this.refresh = null;
    this.discover = null;
    this.listTeams = null;
    this._units = [];
    this._subdomains = [];
    this._choices = [];
    this._label = '';
    this._source = 'label';
    this._team = '';
    this._teams = [];
    this._kind = 'squad';
    this._name = '';
    this._refreshing = false;
    this._discovering = false;
    this._confirmId = '';
    this._error = '';
    this._loading = false;
    this._info = '';
    this._loaded = false;
  }

  updated(changed) {
    if (changed.has('persistence') && this.persistence && !this._loaded) {
      this._loaded = true;
      this._load();
    }
    // Un <select> que pinta sus <option> en la misma plantilla NO refleja su
    // valor: hay que ponérselo después de pintar, o todas las filas enseñarían
    // la primera opción y el enganche parecería otro del que es.
    for (const select of this.renderRoot.querySelectorAll('select[data-unit]')) {
      const unit = this._units.find((u) => u.id === select.dataset.unit);
      select.value = unit?.subdomainKey ?? '';
    }
  }

  async _load() {
    this._loading = true;
    this._error = '';
    try {
      const [units, domains, subdomains] = await Promise.all([
        listUnits(this.persistence), listDomains(), listSubdomains(),
      ]);
      this._units = units;
      this._subdomains = subdomains;
      this._choices = subdomainChoices(subdomains, domains);
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'No se pudieron cargar las unidades.';
    } finally {
      this._loading = false;
    }
  }

  async _discoverUnits() {
    if (!this.discover || this._discovering) return;
    this._discovering = true;
    this._error = '';
    this._info = '';
    try {
      const res = await this.discover();
      const n = (res?.created ?? []).length;
      this._info = n ? `Se añadieron ${n} unidades desde Linear. Pulsa «Recalcular» para traer sus métricas.` : 'No había unidades nuevas que descubrir.';
      await this._load();
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'No se pudo descubrir desde Linear.';
    } finally {
      this._discovering = false;
    }
  }

  async _refreshMetrics() {
    if (!this.refresh || this._refreshing) return;
    this._refreshing = true;
    this._error = '';
    try {
      await this.refresh();
      await this._load();
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'No se pudo recalcular desde Linear.';
    } finally {
      this._refreshing = false;
    }
  }

  _canAdd() {
    return this._source === 'team' ? Boolean(this._team) : Boolean(this._label.trim());
  }

  /**
   * Los equipos se piden a Linear al elegir esa fuente, no al abrir la pantalla:
   * quien solo viene a mirar métricas no tiene por qué pagar una llamada a su API.
   */
  async _pickSource(source) {
    this._source = source;
    if (source !== 'team' || this._teams.length > 0 || !this.listTeams) return;
    try {
      const res = await this.listTeams();
      this._teams = res?.teams ?? [];
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'No se pudieron traer los equipos de Linear.';
    }
  }

  _renderTeamPicker() {
    return html`<label>Equipo de Linear
      <select .value=${this._team} @change=${(e) => { this._team = e.target.value; }}>
        <option value="">— Elige —</option>
        ${this._teams.map((t) => html`<option value=${t.key}>${t.name} (${t.key})</option>`)}
      </select>
    </label>`;
  }

  async _add() {
    if (!this._canAdd()) return;
    this._error = '';
    const input = this._source === 'team'
      ? { linearTeamKey: this._team, kind: this._kind, name: this._name.trim() }
      : { linearLabel: this._label.trim(), kind: this._kind, name: this._name.trim() };
    try {
      await addUnit(this.persistence, input);
      this._label = '';
      this._team = '';
      this._name = '';
      await this._load();
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'No se pudo añadir.';
    }
  }

  /** Engancha (o desengancha, con la opción vacía) un equipo a su subdominio. */
  async _link(id, subdomainKey) {
    this._error = '';
    try {
      await linkUnitToSubdomain(this.persistence, id, subdomainKey);
      await this._load();
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'No se pudo enganchar al subdominio.';
    }
  }

  async _remove(id) {
    this._error = '';
    try {
      await removeUnit(this.persistence, id);
      this._confirmId = '';
      await this._load();
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'No se pudo eliminar.';
    }
  }

  render() {
    return html`
      ${this.canEdit ? this._renderBar() : null}
      ${this._info ? html`<p class="info">${this._info}</p>` : null}
      ${this._error ? html`<p class="error">${this._error}</p>` : null}
      ${this.canEdit ? this._renderManual() : null}
      ${this._loading ? skeletonLines(4) : this._renderGroups()}
    `;
  }

  _renderBar() {
    return html`<div class="bar">
      <button class="btn primary" ?disabled=${this._discovering || !this.discover} @click=${() => this._discoverUnits()}>
        ${this._discovering ? 'Descubriendo…' : '✨ Descubrir equipos y gremios desde Linear'}
      </button>
      <span class="spacer"></span>
      <button class="btn" ?disabled=${this._refreshing || !this.refresh} @click=${() => this._refreshMetrics()}>
        ${this._refreshing ? 'Recalculando…' : '↻ Recalcular métricas'}
      </button>
    </div>`;
  }

  _renderManual() {
    return html`<details class="manual">
      <summary>Añadir una unidad a mano</summary>
      <div class="row">
        <label>Fuente
          <select .value=${this._source} @change=${(e) => this._pickSource(e.target.value)}>
            <option value="label">Label de Linear</option>
            <option value="team">Equipo de Linear</option>
          </select>
        </label>
        ${this._source === 'team' ? this._renderTeamPicker() : html`<label>Label de Linear
          <input type="text" placeholder="Trust" .value=${this._label} @input=${(e) => { this._label = e.target.value; }} />
        </label>`}
        <label>Tipo
          <select .value=${this._kind} @change=${(e) => { this._kind = e.target.value; }}>
            <option value="squad">Equipo (Squad)</option>
            <option value="chapter">Gremio (Chapter)</option>
          </select>
        </label>
        <label>Nombre (opcional)
          <input type="text" placeholder="Equipo Trust" .value=${this._name} @input=${(e) => { this._name = e.target.value; }} />
        </label>
        <button class="btn" ?disabled=${!this._canAdd()} @click=${() => this._add()}>Añadir</button>
      </div>
    </details>`;
  }

  _renderGroups() {
    if (this._units.length === 0) {
      return html`<p class="empty">Aún no hay unidades. Pulsa «✨ Descubrir equipos y gremios desde Linear» para poblarlas automáticamente.</p>`;
    }
    return html`
      ${this._renderKind('squad')}
      ${this._renderKind('chapter')}
      ${this._renderUnclassified()}
    `;
  }

  _renderKind(kind) {
    const units = this._units.filter((u) => u.kind === kind);
    if (units.length === 0) return null;
    // Solo los equipos miden un subdominio: un gremio cruza varios, y publicarlo
    // como si fuera uno sumaría el mismo trabajo dos veces.
    const conSubdominio = kind === 'squad';
    return html`
      <h4>${KIND_LABEL[kind]} (${units.length})</h4>
      ${conSubdominio ? this._renderUnlinkedWarning(units) : null}
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Mide en Linear</th><th>Nombre</th>
          ${conSubdominio ? html`<th>Subdominio</th>` : null}
          <th>Últimas métricas</th>${this.canEdit ? html`<th></th>` : null}
        </tr></thead>
        <tbody>${units.map((u) => this._renderRow(u, conSubdominio))}</tbody>
      </table></div>
    `;
  }

  /**
   * Unidades que no son ni equipo ni gremio: restos de altas antiguas, a veces
   * con el id por nombre. No se miden ni se publican, así que se enseñan y se
   * arreglan aquí mismo — esconderlas es como no tenerlas, y así es como una
   * unidad rota sobrevive meses sin que nadie sepa qué era.
   */
  _renderUnclassified() {
    const sueltas = this._units.filter((u) => u.kind !== 'squad' && u.kind !== 'chapter');
    if (sueltas.length === 0) return null;
    return html`
      <h4>Sin clasificar (${sueltas.length})</h4>
      <p class="warn unclassified">
        Estas unidades no son ni equipo ni gremio: no se miden ni se publican.
        Dales su tipo o quítalas.
      </p>
      <div class="table-wrap"><table>
        <thead><tr><th>Label</th><th>Nombre</th><th>Tipo</th>${this.canEdit ? html`<th></th>` : null}</tr></thead>
        <tbody>${sueltas.map((u) => this._renderUnclassifiedRow(u))}</tbody>
      </table></div>
    `;
  }

  _renderUnclassifiedRow(u) {
    return html`<tr>
      <td class="label-cell">${u.linearLabel || '—'}</td>
      <td>${u.name || '—'}</td>
      <td>${this._renderKindPicker(u)}</td>
      ${this.canEdit ? html`<td><div class="actions">${this._renderRowActions(u)}</div></td>` : null}
    </tr>`;
  }

  /** Darle su tipo es lo que la devuelve al redil: a partir de ahí se mide como el resto. */
  _renderKindPicker(u) {
    if (!this.canEdit) return html`<span class="err">Sin clasificar</span>`;
    return html`
      <select data-classify=${u.id} aria-label="Tipo de ${u.name || u.id}"
        @change=${(e) => this._classify(u.id, e.target.value)}>
        <option value="">— Sin clasificar —</option>
        <option value="squad">Equipo</option>
        <option value="chapter">Gremio</option>
      </select>`;
  }

  /** Le da su tipo a una unidad suelta: a partir de ahí ya se mide como el resto. */
  async _classify(id, kind) {
    if (!kind) return;
    this._error = '';
    try {
      await classifyUnit(this.persistence, id, kind);
      await this._load();
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'No se pudo clasificar la unidad.';
    }
  }

  /** Lo que no está enganchado no se publica: se dice aquí, no al echar de menos las métricas. */
  _renderUnlinkedWarning(units) {
    const sueltos = classifyUnits(units, this._subdomains).skipped;
    if (sueltos.length === 0) return null;
    return html`<p class="warn unlinked">
      ${sueltos.length === 1 ? 'Un equipo no mide ningún subdominio' : `${sueltos.length} equipos no miden ningún subdominio`}:
      sus métricas no se publican, porque no se sabría a qué sumarlas.
    </p>`;
  }

  _renderRow(u, conSubdominio) {
    return html`<tr>
      <td class="label-cell">${sourceLabel(u)}</td>
      <td>${u.name}</td>
      ${conSubdominio ? html`<td>${this._renderSubdomain(u)}</td>` : null}
      <td>${this._renderStatus(u.metrics)}</td>
      ${this.canEdit ? html`<td><div class="actions">${this._renderRowActions(u)}</div></td>` : null}
    </tr>`;
  }

  /**
   * A qué subdominio mide este equipo. Se guarda la CLAVE, así que renombrar el
   * subdominio no rompe nada; si la clave ya no está en el catálogo se dice,
   * en vez de enseñar un hueco que parece «sin enganchar».
   */
  _renderSubdomain(u) {
    const elegido = this._choices.find((c) => c.key === u.subdomainKey);
    if (!this.canEdit) {
      if (elegido) return html`<span>${elegido.label}</span>`;
      return html`<span class="err">${u.subdomainKey ? `«${u.subdomainKey}» ya no está en el catálogo` : 'Sin enganchar'}</span>`;
    }
    return html`
      <select data-unit=${u.id} aria-label="Subdominio de ${u.name}"
        @change=${(e) => this._link(u.id, e.target.value)}>
        <option value="">— Sin enganchar —</option>
        ${this._choices.map((c) => html`<option value=${c.key}>${c.label}</option>`)}
      </select>
      ${u.subdomainKey && !elegido
        ? html`<span class="err">«${u.subdomainKey}» ya no está en el catálogo</span>`
        : null}`;
  }

  _renderStatus(m) {
    if (m?.error) return html`<span class="err">Error: ${m.error}</span>`;
    const when = m?.computedAt ? fmtWhen(m.computedAt) : 'Sin calcular';
    return html`<span class="muted">${when}</span>`;
  }

  _renderRowActions(u) {
    if (this._confirmId === u.id) {
      return html`<button class="btn danger" @click=${() => this._remove(u.id)}>Confirmar</button>
        <button class="btn" @click=${() => { this._confirmId = ''; }}>Cancelar</button>`;
    }
    return html`<button class="btn danger" @click=${() => { this._confirmId = u.id; }}>Borrar</button>`;
  }
}

if (!customElements.get('lean-teams')) {
  customElements.define('lean-teams', LeanTeams);
}
