/**
 * <superadmin-panel>
 * Vista de gestión del superadmin (separada de la vista de manager). Lista los
 * managers de la instancia (alta por email vía Cloud Function, baja) y permite
 * ver el equipo de cada manager (personas y su perfil Role Mirror) en LECTURA.
 * Si el superadmin es además manager, "Usar como manager" lo lleva a las herramientas.
 * También gestiona el catálogo de accesos (pestaña Usuarios): quién tiene
 * acceso (superadmin/viewer/manager) y permite cambiar el rol de cada uno.
 *
 * Propiedades:
 *  - ready: boolean  (lo activa el glue cuando hay sesión de gestión)
 *  - isLeader: boolean  (si el superadmin también es manager → botón "Usar como manager")
 *  - readOnly: boolean  (viewer: mismo panel, sin controles mutables ni pestaña Usuarios)
 */
import { LitElement, html, css } from 'lit';
import { noteStyles } from './common/note-styles.js';
import './common/busy-overlay.js';
import { repeat } from 'lit/directives/repeat.js';
import './app-modal.js';
import './admin/game-editor.js';
import { listLeaders, listSupermanagers } from '../lib/leaders.js';
import './catalog-manager.js';
import './org-chart.js';
import './common/person-permissions.js';
import './admin/domains-manager.js';
import { listAllUsers, setUserRole, setUserAdmin, listLinkedUids, assignUserToLeader, deleteUnusedUser } from '../lib/users.js';
import { classifyAccountWithoutPerson } from '../lib/accessRoles.js';
import { createTeamContainer } from '../tools/team/composition/container.js';
import { listActivePeople } from '../tools/team/application/usecases/index.js';
import { getFramework, saveFramework } from '../lib/careerFramework.js';
import { listOrgRoles, saveOrgRole, setOrgRoleReportsTo, deleteOrgRole } from '../lib/orgRoles.js';
import { listOrgBranches, saveOrgBranch, deleteOrgBranch } from '../lib/orgBranches.js';
import { listJds, saveJd, publishJd, unpublishJd, deleteJd, polishJdRequirements } from '../lib/jobDescriptions.js';
import { generateJobDescription, validateJobDescription } from '../tools/career/domain/jobDescription.js';
import { frameworkToMarkdown } from '../tools/career/domain/frameworkMarkdown.js';

import { childrenOf, assertValidReportsTo, layerOf, orgRoleRows, branchColor, superiorCandidatesFor, treeGuideKinds, treeGuideBackground } from '../tools/team/domain/orgRoles.js';
import { listToolPolicies, saveToolPolicy } from '../lib/toolPolicies.js';
import { TOOLS } from '../tools/team/data/tools.js';

const CITY_KINDS = ['tech', 'skill', 'milestone'];
const REC_KINDS = ['curso', 'formacion', 'doc', 'titulo'];

/**
 * Genera un id estable a partir de un texto (nombre/código): minúsculas, sin
 * acentos, separadores → guiones. @param {string} text @returns {string}
 */
function slugify(text) {
  return String(text ?? '')
    .normalize('NFD').replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase().trim()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replace(/^-/u, '')
    .replace(/-$/u, '');
}

/**
 * Devuelve un id único añadiendo sufijos -2, -3… si `base` ya existe.
 * @param {string} base @param {Set<string>} existing @returns {string}
 */
function uniqueId(base, existing) {
  const root = base || 'item';
  let id = root;
  let n = 2;
  while (existing.has(id)) { id = `${root}-${n}`; n += 1; }
  return id;
}

/** Siguiente `order` disponible (max + 1). @param {ReadonlyArray<{order:number}>} items @returns {number} */
function nextOrder(items) {
  return items.reduce((max, it) => Math.max(max, Number(it.order) || 0), 0) + 1;
}

/** @type {Record<import('../lib/accessRoles.js').AccessRole, string>} */
/** Gobierno de instancia (ADR «Acceso en dos ejes»): excluyentes entre sí. */
const GOVERNANCE = /** @type {const} */ ([
  ['none', '—', 'Sin gobierno de instancia: solo ve su propio alcance'],
  ['admin', 'Superadmin', 'Gobierna la instancia y ve toda la organización'],
  ['viewer', 'Viewer', 'Ve toda la organización en solo lectura; no lidera equipo'],
]);

const ROLE_LABEL = { superadmin: 'Superadmin', supermanager: 'Head', viewer: 'Viewer', leader: 'Manager', none: 'Sin rol' };
// El violeta del Head contrasta AA sobre el texto blanco del badge, igual que los demás.
const ROLE_COLOR = { superadmin: '#dc2626', supermanager: '#6d28d9', viewer: '#6b7280', leader: '#3b82f6', none: '#9ca3af', surveyAdmin: '#0d9488' };
const loginFmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' });
/** @param {unknown} ts Firestore Timestamp | number | null */
function formatLogin(ts) {
  const ms = ts && typeof (/** @type {any} */ (ts).toMillis) === 'function'
    ? /** @type {any} */ (ts).toMillis()
    : (typeof ts === 'number' ? ts : 0);
  return ms ? loginFmt.format(new Date(ms)) : '—';
}

const VIEW_FLAG = 'grebla-view';
// «Managers» se retiró (RMR-PCS-0027 · F8e): dar el rol de mando se hace editando
// la persona en «Usuarios», sin una pestaña aparte que duplicaba el alta.
const TABS = ['organigrama', 'areas', 'guilds', 'dominios', 'labels', 'career', 'users', 'permisos'];
/** Hashes legados de las dos pestañas de carrera, ahora sub-pestañas de «career»
 *  (RMR-TSK-0262): siguen aterrizando en su sub-pestaña correcta. */
const LEGACY_CAREER_HASH = { careerMap: 'map', careerFramework: 'framework' };
/** «Herramientas» era una pestaña de primer nivel y ahora es el ámbito «por rol
 *  y rama» de Permisos (RMR-TSK-0460): los enlaces guardados siguen valiendo. */
const LEGACY_TAB_HASH = { herramientas: { tab: 'permisos', sub: 'rol' }, squads: { tab: 'dominios' } };
/** Traduce un hash a { tab, sub? }: los hashes legados van a donde vive hoy eso. */
function resolveHash(raw) {
  if (raw in LEGACY_CAREER_HASH) return { tab: 'career', sub: LEGACY_CAREER_HASH[raw] };
  if (raw in LEGACY_TAB_HASH) return { ...LEGACY_TAB_HASH[raw] };
  if (TABS.includes(raw)) return { tab: raw };
  return { tab: 'users' };
}

/** Sub-pestañas del framework de carrera: 4 catálogos + 2 matrices de cruce. */
const FW_SUBTABS = /** @type {const} */ ([
  ['tracks', 'Tracks y niveles'],
  ['disciplines', 'Disciplinas'],
  ['dimensions', 'Dimensiones'],
  ['expectations', 'Expectativas'],
  ['addendums', 'Addendums'],
]);

export class SuperadminPanel extends LitElement {
  static properties = {
    ready: { attribute: false },
    isLeader: { attribute: false },
    readOnly: { attribute: false },
    persistence: { attribute: false },
    currentUid: { attribute: false },
    _tab: { state: true },
    _careerSub: { state: true },
    _permSub: { state: true },
    leaders: { state: true },
    _supermanagers: { state: true },
    _error: { state: true },
    _framework: { state: true },
    _fwNew: { state: true },
    _fwExpLevel: { state: true },
    _fwAddDiscipline: { state: true },
    _fwConfirm: { state: true },
    _fwError: { state: true },
    _fwNotice: { state: true },
    _fwSaving: { state: true },
    _fwSubtab: { state: true },
    _users: { state: true },
    _usersError: { state: true },
    _usersNotice: { state: true },
    _linkedUids: { state: true },
    _assignFor: { state: true },
    _assignLeader: { state: true },
    _orgRoles: { state: true },
    _orgForm: { state: true },
    _orgError: { state: true },
    _orgNotice: { state: true },
    _orgConfirmDelete: { state: true },
    _editRoleId: { state: true },
    _editRoleLabel: { state: true },
    _editEmailId: { state: true },
    _editEmailValue: { state: true },
    _editPersonNameId: { state: true },
    _editPersonNameValue: { state: true },
    _toolPolicies: { state: true },
    _permPersonId: { state: true },
    _toolError: { state: true },
    _toolNotice: { state: true },
    _peopleList: { state: true },
    _peopleError: { state: true },
    _peopleNotice: { state: true },
    _confirmDeletePerson: { state: true },
    _confirmRemoveAccount: { state: true },
    _busy: { state: true },
    _newPersonName: { state: true },
    _newPersonEmail: { state: true },
    _newPersonRole: { state: true },
    _orgSubtab: { state: true },
    _orgBranches: { state: true },
    _newBranchLabel: { state: true },
    _editBranchId: { state: true },
    _editBranchLabel: { state: true },
    _branchError: { state: true },
    _branchDraft: { state: true },
    _jds: { state: true },
    _jdForm: { state: true },
    _jdPreview: { state: true },
    _jdError: { state: true },
    _jdNotice: { state: true },
    _jdBusy: { state: true },
    _jdCopiedId: { state: true },
    _fwExportLevel: { state: true },
    _confirmJd: { state: true },
  };

  static styles = [noteStyles, css`
    :host {
      display: block; font-family: var(--rm-font, system-ui, sans-serif); color: var(--rm-text, #111827);
      /* Fondo sutil de los campos (RMR-TSK-0266): los diferencia de la tarjeta
         sin rechinar. Derivado del tema (mezcla texto→superficie), así vale en
         claro (gris muy claro) y en oscuro (un pelín más claro que la tarjeta);
         al enfocar pasan a la superficie (campo activo). */
      --rm-field: color-mix(in srgb, var(--rm-text, #111827) 5%, var(--rm-surface, #fff));
    }
    .bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
    .bar h1 { font-size: 1.4rem; margin: 0; }
    /* Pestañas REALES (no botones-píldora): fila con una línea base común y la
       activa marcada por un subrayado de acento pegado a esa línea, conectada al
       contenido que va justo debajo. */
    .tabs { display: flex; gap: 0.1rem; margin-bottom: 1.25rem; flex-wrap: wrap; border-bottom: 2px solid var(--rm-border, #e5e7eb); }
    .tab {
      border: 0; background: none; color: var(--rm-muted, #5b6b7d);
      padding: 0.6rem 1rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
      border-bottom: 3px solid transparent; margin-bottom: -2px; border-radius: 6px 6px 0 0;
    }
    .tab.active { color: var(--rm-accent, #3b82f6); border-bottom-color: var(--rm-accent, #3b82f6); }
    .tab:hover:not(.active) { color: var(--rm-text, #111827); background: color-mix(in srgb, var(--rm-text, #111827) 5%, transparent); }
    .tab:focus-visible { outline: 2px solid var(--rm-accent, #3b82f6); outline-offset: -2px; border-radius: 6px; }
    /* Segundo nivel: mismo lenguaje de pestaña subrayada, un punto más pequeño. */
    .subtabs { display: flex; gap: 0.1rem; margin-bottom: 1.25rem; flex-wrap: wrap; border-bottom: 2px solid var(--rm-border, #e5e7eb); }
    .subtab {
      border: 0; background: none; color: var(--rm-muted, #5b6b7d);
      padding: 0.5rem 0.85rem; font-size: 0.85rem; font-weight: 600; cursor: pointer;
      border-bottom: 3px solid transparent; margin-bottom: -2px; border-radius: 6px 6px 0 0;
    }
    .subtab.active { color: var(--rm-accent, #3b82f6); border-bottom-color: var(--rm-accent, #3b82f6); }
    .subtab:hover:not(.active) { color: var(--rm-text, #111827); background: color-mix(in srgb, var(--rm-text, #111827) 5%, transparent); }
    .subtab:focus-visible { outline: 2px solid var(--rm-accent, #3b82f6); outline-offset: -2px; border-radius: 6px; }
    /* Sub-pestañas de «Carrera» (RMR-TSK-0262): estilo SUBRAYADO —distinto de las
       píldoras .subtab del editor de framework— para que no se apilen dos filas
       idénticas cuando el framework pinta sus propias sub-pestañas dentro. */
    .csubtabs { display: flex; gap: 1.1rem; margin: 0 0 1.25rem; border-bottom: 1px solid var(--rm-border, #e5e7eb); flex-wrap: wrap; }
    .csubtab {
      border: 0; background: none; color: var(--rm-muted, #5b6b7d); font-size: 0.92rem; font-weight: 700;
      padding: 0.45rem 0.1rem; margin-bottom: -1px; border-bottom: 2px solid transparent; cursor: pointer;
    }
    .csubtab.on { color: var(--rm-accent, #3b82f6); border-bottom-color: var(--rm-accent, #3b82f6); }
    .csubtab:hover:not(.on) { color: var(--rm-text, #111827); }
    .csubtab:focus-visible { outline: 2px solid var(--rm-accent, #3b82f6); outline-offset: 2px; }
    /* Grupo de track: contenedor plegable con sus niveles anidados dentro. */
    details.track-group { margin-bottom: 0.9rem; }
    details.track-group > summary { list-style: none; }
    details.track-group > summary::-webkit-details-marker { display: none; }
    .track-group .nested-levels { margin-top: 0.9rem; padding-top: 0.75rem; border-top: 1px dashed var(--rm-border, #e5e7eb); }
    .track-group .nested-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
    .track-group .nested-head .sub { margin: 0; }
    /* Glifo de la forma de casa de una comarca (RMR-TSK-0233): pista visual de
       qué silueta usarán sus casas en el mapa. */
    section {
      background: var(--rm-surface, #fff); border: 1px solid var(--rm-border, #e5e7eb);
      border-radius: var(--rm-radius, 12px); padding: 1.25rem 1.5rem; margin-bottom: 1.5rem;
    }
    h2 { font-size: 1.1rem; margin: 0 0 1rem; }
    .toolbar { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
    input {
      padding: 0.45rem 0.6rem; border-radius: 8px; border: 1px solid var(--rm-border, #d1d5db);
      font: inherit; font-size: 0.9rem; min-width: 16rem; background: var(--rm-field, #eef2f6); color: var(--rm-text, #111827);
    }
    /* Una casilla no es un campo de texto: el min-width de arriba la estiraba a
       16rem y empujaba su etiqueta fuera de la celda, que es por lo que la de
       «Superadmin» no se veía (RMR-BUG-0105). */
    input[type="checkbox"], input[type="radio"] { width: auto; min-width: 0; padding: 0; }
    input:focus, select:focus, textarea:focus { background: var(--rm-surface, #fff); }
    button {
      border: 1px solid var(--rm-border, #d1d5db); background: var(--rm-surface, #fff); color: var(--rm-text, #111827);
      border-radius: 8px; padding: 0.45rem 0.9rem; font-size: 0.85rem; font-weight: 600; cursor: pointer;
    }
    button.primary { background: var(--rm-accent, #3b82f6); border-color: var(--rm-accent, #3b82f6); color: var(--rm-on-accent, #fff); }
    button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    /* La tabla de usuarios hace scroll propio si no cabe, para no desbordar el
       panel. Ancho mínimo para que las columnas no se compriman. */
    /* Tablas anchas (RMR-BUG-0074): el scroll (vertical y horizontal) vive en la
       PROPIA tabla — así la barra horizontal siempre está a la vista sin llegar
       al fondo de la página. Cabecera pegajosa y PRIMERA COLUMNA FIJA para no
       perder de vista a la persona/rol al desplazarse en horizontal. */
    /* La barra horizontal vive en el borde INFERIOR de esta caja: si la caja es
       más alta que lo que queda de ventana, la barra cae fuera de la vista y hay
       que bajar toda la lista para encontrarla — que es justo lo que hacía
       inservible el desplazamiento (RMR-BUG-0108). Con una caja más baja, la
       barra entra en pantalla junto a la tabla; la cabecera es sticky, así que
       se sigue sabiendo qué columna es cada una.
       Se usa scroll y no auto: la barra se dibuja siempre, en vez de aparecer
       solo cuando ya estás desplazando. */
    .table-wrap { overflow-y: auto; overflow-x: auto; max-height: 60vh; }
    /* Un borde a la derecha recuerda que la tabla sigue más allá. */
    .table-wrap { border-right: 1px solid var(--rm-border, #e5e7eb); }
    .table-wrap table { min-width: 46rem; }
    .table-wrap thead th { position: sticky; top: 0; background: var(--rm-surface, #fff); z-index: 2; }
    .table-wrap th:first-child, .table-wrap td:first-child { position: sticky; left: 0; background: var(--rm-surface, #fff); z-index: 1; }
    .table-wrap thead th:first-child { z-index: 3; }
    /* Personas: ocho columnas de selects se salían de la pantalla y la casilla
       «Superadmin» quedaba fuera, con la barra de scroll al final de la tabla
       (RMR-BUG-0105). Con el ancho repartido cabe entera y no hay que arrastrar
       nada para llegar a lo que se venía a hacer. */
    /* Personas: la tabla toma el ancho que necesita su contenido y la caja da
       scroll cuando no quepa (RMR-BUG-0108). Antes se hizo al revés —anchos
       fijos por columna para que «cupiera»— y salió peor: la tabla nunca era
       más ancha que su caja, así que no había barra que arrastrar, y el
       contenido se recortaba dentro de cada celda («Mobile En», «Engineerin»).
       Un dato a medio leer sin forma de verlo entero es peor que un scroll. */
    table.people { min-width: 0; }
    /* Dos controles apilados en una celda: rol y rama van juntos porque se
       eligen juntos, y así la tabla CABE. Perseguir la barra de scroll fue un
       error: en Chrome es «overlay» y no se dibuja hasta que ya estás
       arrastrando, así que el usuario ve la tabla cortada y ninguna barra. */
    /* La celda apilada envuelve: «requiere cuenta» en dos líneas ocupa menos
       ancho que en una, y el ancho es lo escaso aquí. */
    table.people td.stack { display: table-cell; white-space: normal; }
    table.people td.stack > * { display: block; }
    table.people td.stack > * + * { margin-top: 0.35rem; }
    table.people td, table.people th { white-space: nowrap; }
    /* El nombre y el email sí envuelven: son lo más largo y no hace falta
       verlos en una línea para entenderlos. */
    table.people td.wrap { white-space: normal; word-break: break-word; min-width: 8rem; }
    table.people select { max-width: 10.5rem; width: 100%; }
    /* Los dos controles de acceso (excepción y acceso extra) caben en menos:
       el texto de sus opciones es corto y el ancho sobrante empujaba la tabla
       fuera de la caja. */
    table.people td.stack .access-inline + select { max-width: 10rem; }
    table.people th, table.people td { padding: 0.45rem 0.35rem; }
    table.people .access-inline { display: flex; align-items: center; gap: 0.35rem; margin: 0 0 0.35rem; font-size: 0.78rem; }
    /* Gobierno: tres opciones excluyentes en una línea. Ocupa menos que un
       desplegable y se lee de un vistazo cuál está puesta. */
    .gov { display: flex; flex-wrap: wrap; gap: 0.1rem 0.6rem; margin-bottom: 0.3rem; }
    .gov-opt { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.78rem; cursor: pointer; }
    .gov-opt input { cursor: pointer; }
    /* El email lleva debajo el estado de la cuenta: es lo mismo —la cuenta
       vinculada o la invitación—, y en columna aparte solo gastaba ancho. */
    table.people .acct { display: block; font-size: 0.78rem; margin-top: 0.15rem; }
    /* Resumen de ancho FIJO para que todas las celdas (— / Superadmin / People
       account) tengan el mismo ancho y la columna no baile. */
    .access summary { cursor: pointer; font-size: 0.82rem; font-weight: 600; color: var(--rm-text, #111827); list-style: none; padding: 0.25rem 0.6rem; border: 1px solid var(--rm-border, #d1d5db); border-radius: 6px; display: inline-flex; justify-content: space-between; align-items: center; gap: 0.5rem; min-width: 8.5rem; box-sizing: border-box; white-space: nowrap; }
    .access summary::-webkit-details-marker { display: none; }
    .access summary::after { content: '▾'; color: var(--rm-muted, #5b6b7d); }
    .access[open] summary { border-color: var(--rm-accent, #3b82f6); color: var(--rm-accent, #3b82f6); }
    /* Opciones FLOTANTES (position:fixed, posicionadas en JS): no empujan la tabla
       ni las recorta el scroll horizontal del contenedor. */
    .access-opts { position: fixed; z-index: 10000; display: flex; flex-direction: column; gap: 0.4rem; padding: 0.5rem 0.65rem; border: 1px solid var(--rm-border, #d1d5db); border-radius: 8px; background: var(--rm-surface, #fff); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); font-size: 0.82rem; white-space: nowrap; }
    .access-opts label { display: inline-flex; align-items: center; gap: 0.35rem; cursor: pointer; }
    .access-opts label.implied { color: var(--rm-muted, #5b6b7d); cursor: default; }
    th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--rm-border, #eef0f2); }
    th { color: var(--rm-muted, #5b6b7d); font-weight: 600; }
    /* Editor de roles agrupado por rama (RMR-TSK-0375): sin línea entre filas de
       la misma rama; línea separadora SOLO al inicio de cada bloque de rama
       (menos el primero, que es el borde superior de la tabla). */
    table.org-roles td { border-bottom: 0; }
    table.org-roles tbody tr.branch-start td { border-top: 2px solid var(--rm-border, #e5e7eb); }
    table.org-roles tbody tr:first-child td { border-top: 0; }
    .branch-draft { display: inline-flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; margin-top: 0.4rem; }
    .branch-draft input { min-width: 12rem; }
    /* Job Descriptions (RMR-PCS-0031 · F3): filas y formulario. */
    .egg-row { border: 1px solid var(--rm-border, #e5e7eb); border-radius: 10px; padding: 0.6rem 0.85rem; margin: 0.5rem 0; }
    .egg-head { display: flex; flex-wrap: wrap; gap: 0.5rem 0.9rem; align-items: center; }
    .egg-head .muted { color: var(--rm-muted, #5b6b7d); font-size: 0.82rem; }
    .egg-head a { color: var(--rm-accent, #2a9d8f); font-size: 0.82rem; word-break: break-all; }
    .egg-form { border: 1.5px solid var(--rm-accent, #2a9d8f); border-radius: 12px; padding: 0.9rem 1rem; margin-top: 0.75rem; display: grid; gap: 0.6rem; }
    .egg-form label { display: grid; gap: 0.25rem; font-size: 0.85rem; font-weight: 600; }
    .egg-form .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); gap: 0.6rem; }
    .egg-form label.chk { display: inline-flex; align-items: center; gap: 0.35rem; }
    .egg-form .actions-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    /* El details es ITEM del grid .egg-form: sin min-width:0, el min-content
       de la línea más larga del JSON estira TODO el grid (RMR-BUG-0086). */
    .jd-preview { min-width: 0; max-width: 100%; }
    .jd-preview pre { max-height: 22rem; overflow: auto; background: var(--rm-track, #f3f4f6); border-radius: 8px; padding: 0.7rem; font-size: 0.75rem; white-space: pre-wrap; word-break: break-word; }
    .rename-btn { border: 0; background: none; color: var(--rm-muted, #5b6b7d); cursor: pointer; font: inherit; padding: 0 0.25rem; opacity: 0.55; }
    .rename-btn:hover, .rename-btn:focus-visible { color: var(--rm-accent, #2a9d8f); opacity: 1; outline: none; }
    input.role-rename { min-width: 11rem; }
    tbody tr.clickable { cursor: pointer; }
    tbody tr.clickable:hover { background: var(--rm-surface-hover, #f9fafb); }
    tr.sel { background: var(--rm-surface-hover, #eef2ff); }
    .muted { color: var(--rm-muted, #5b6b7d); }
    .badge { display: inline-block; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.75rem; font-weight: 700; color: #fff; }
    .del-btn { border: 1px solid var(--rm-border, #d1d5db); background: var(--rm-surface, #fff); color: var(--rm-danger, #dc2626); border-radius: 6px; padding: 0.2rem 0.6rem; font-size: 0.75rem; font-weight: 600; cursor: pointer; }
    .access-inline { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.8rem; margin-right: 0.5rem; }
    /* Pirámide invertida del organigrama (RMR-PRP-0002) */
    .pyr-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; flex: none; }
    /* Guías de árbol en la tabla de Roles (RMR-TSK-0439). La celda usa el hack
       height:1px + hijo al 100% para que los segmentos ocupen TODA la altura de
       la fila y las verticales encadenen sin huecos entre filas. */
    .org-roles td.tree-cell { padding-block: 0; padding-right: 0.6rem; }
    .org-roles td.tree-cell > * { vertical-align: middle; }
    /* Guías del árbol pintadas como FONDO de la celda, no como cajas dentro de
       ella: el fondo cubre SIEMPRE el alto exacto del <td>, así que con filas
       contiguas las verticales se tocan y no queda ni un píxel de hueco, crezca
       lo que crezca la fila. Antes eran <span> con height:100% + min-height, que
       no resuelve dentro de un <td> y se quedaban cortos frente a la fila
       (la fila mide lo que miden sus <select>) — de ahí los trozos sueltos.
       Color: mezcla del texto con el fondo, legible en claro y en oscuro. */
    .org-roles td.tree-cell { --guide: color-mix(in srgb, var(--rm-text, #111827) 35%, transparent); }
    .ord-btn { border: 1px solid var(--rm-border, #d1d5db); background: var(--rm-surface, #fff); color: var(--rm-text, #111827); border-radius: 6px; padding: 0.2rem 0.5rem; font-size: 0.8rem; font-weight: 700; line-height: 1; cursor: pointer; }
    .ord-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .ord-btn:active { transform: scale(0.94); }
    .ord-btn.copied { border-color: var(--rm-accent, #2a9d8f); background: color-mix(in srgb, var(--rm-accent, #2a9d8f) 16%, var(--rm-surface, #fff)); color: var(--rm-text, #111827); transition: background 0.15s; }
    .empty { color: var(--rm-muted, #5b6b7d); font-size: 0.88rem; padding: 0.5rem 0; }
    .error { color: var(--rm-danger, #dc2626); font-size: 0.85rem; }
    .notice { color: var(--rm-accent, #2a9d8f); font-size: 0.85rem; font-weight: 600; }
    .sub { font-size: 0.95rem; margin: 1.25rem 0 0.6rem; color: var(--rm-text, #111827); cursor: pointer; }
    details { margin-bottom: 0.5rem; }
    details.city .city-head { cursor: pointer; }
    /* Editor de políticas de herramientas (RMR-PCS-0027 · F3) */
    details.tool { border: 1px solid var(--rm-border, #e5e7eb); border-radius: 10px; padding: 0.6rem 0.9rem; margin-bottom: 0.6rem; }
    details.tool > summary { cursor: pointer; font-size: 0.95rem; }
    /* Ve/usa y Gestiona apilados (cada uno a lo ancho) para que la columna de
       roles no se desborde con nombres largos (RMR-PCS-0027 · F3 fix). */
    .tool-body { display: grid; grid-template-columns: 1fr; gap: 0.9rem; margin-top: 0.8rem; }
    .tool-grant { border: 1px solid var(--rm-border, #eef0f2); border-radius: 8px; padding: 0.6rem 0.75rem; min-width: 0; }
    .grant-title { display: block; font-weight: 700; font-size: 0.85rem; margin-bottom: 0.5rem; color: var(--rm-navy, #1e3a5f); }
    .grant-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: 0.75rem 1.25rem; }
    .grant-cols > div { min-width: 0; }
    .grant-cols.dim { opacity: 0.45; pointer-events: none; }
    .grant-h { display: block; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: var(--rm-muted, #5b6b7d); margin-bottom: 0.3rem; }
    .grant .chk { display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; margin: 0.2rem 0; }
    .confirm { font-size: 0.78rem; color: var(--rm-muted, #5b6b7d); white-space: nowrap; }
    .confirm button { border: 0; background: none; cursor: pointer; font-weight: 700; font-size: 0.78rem; padding: 0 0.25rem; color: var(--rm-text, #111827); }
    .confirm .yes { color: var(--rm-danger, #dc2626); }
    .row-actions { display: inline-flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
    .superadmin-alta { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--rm-border, #e5e7eb); }
    .superadmin-alta h3 { font-size: 0.95rem; margin: 0 0 0.35rem; color: var(--rm-text, #111827); }
    .act { border: 1px solid var(--rm-border, #d1d5db); background: var(--rm-surface, #fff); color: var(--rm-text, #111827); border-radius: 6px; padding: 0.25rem 0.6rem; font-size: 0.78rem; font-weight: 600; cursor: pointer; }
    .act:hover { border-color: var(--rm-accent, #3b82f6); color: var(--rm-accent, #3b82f6); }
    .badge.linked { background: #0d9488; margin-left: 0.35rem; }
    .admin-col { text-align: center; }
    .admin-cell { text-align: center; }
    .admin-cell input { cursor: pointer; width: 1.1rem; height: 1.1rem; }
    .assign-body { display: flex; flex-direction: column; gap: 0.9rem; }
    .assign-field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; font-weight: 600; color: var(--rm-muted, #5b6b7d); }
    .assign-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    select { padding: 0.4rem 0.5rem; border-radius: 8px; border: 1px solid var(--rm-border, #d1d5db); background: var(--rm-field, #eef2f6); color: var(--rm-text, #111827); font: inherit; font-size: 0.85rem; }
    .cities { display: grid; gap: 0.9rem; }
    .city { border: 1px solid var(--rm-border, #e5e7eb); border-radius: 10px; padding: 0.8rem 1rem; background: var(--rm-surface, #fff); }
    .city-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.6rem; }
    .city-head .cid { font-weight: 700; font-family: ui-monospace, monospace; font-size: 0.85rem; }
    /* ── Tarjeta de NIVEL destacada (RMR-TSK-0266): badge de código + rail de
       acento, para que los niveles de un track se distingan de un vistazo. ── */
    .city.level { border-left: 4px solid var(--rm-accent, #3b82f6); background: linear-gradient(90deg, color-mix(in srgb, var(--rm-accent, #3b82f6) 5%, var(--rm-surface, #fff)) 0%, var(--rm-surface, #fff) 30%); }
    .lvl-id { display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
    .lvl-badge {
      flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
      min-width: 2.6rem; height: 1.95rem; padding: 0 0.55rem;
      background: var(--rm-accent, #3b82f6); color: var(--rm-on-accent, #fff);
      border-radius: 8px; font-weight: 800; font-size: 0.9rem; letter-spacing: 0.01em;
      font-variant-numeric: tabular-nums;
    }
    .lvl-title { font-weight: 700; font-size: 0.95rem; color: var(--rm-navy, #1e3a5f); min-width: 0; }
    .lvl-title .muted { font-weight: 500; font-family: ui-monospace, monospace; font-size: 0.76rem; }
    /* Cabecera del TRACK: acento propio + chevron de plegado, distinta de los
       niveles que contiene (jerarquía visual). */
    details.track-group > summary.city-head {
      background: color-mix(in srgb, var(--rm-navy, #1e3a5f) 8%, var(--rm-surface, #fff));
      margin: -0.8rem -1rem 0; padding: 0.7rem 1rem; border-radius: 9px 9px 0 0;
    }
    details.track-group > summary .cid::before {
      content: '▸'; display: inline-block; margin-right: 0.5rem; color: var(--rm-accent, #3b82f6);
      transition: transform 0.15s; font-size: 0.85em;
    }
    details.track-group[open] > summary .cid::before { transform: rotate(90deg); }
    details.track-group > summary .cid { color: var(--rm-navy, #1e3a5f); font-family: inherit; font-size: 0.95rem; }
    .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.6rem; }
    /* Afordancia de edición (RMR-TSK-0266): foco con acento; solo-lectura apagado. */
    .fields input:focus-visible, .fields select:focus-visible, .fields textarea:focus-visible {
      outline: 2px solid var(--rm-accent, #3b82f6); outline-offset: 1px; border-color: var(--rm-accent, #3b82f6);
    }
    .fields input:disabled, .fields select:disabled { background: var(--rm-track, #f3f4f6); color: var(--rm-muted, #5b6b7d); cursor: not-allowed; }
    .fields label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.75rem; color: var(--rm-muted, #5b6b7d); font-weight: 600; }
    .fields label.check { flex-direction: row; align-items: center; gap: 0.4rem; }
    .fields label.full { grid-column: 1 / -1; }
    .fields input, .fields select { min-width: 0; font-size: 0.85rem; }
    .recs-edit { margin-top: 0.75rem; border-top: 1px solid var(--rm-border, #eef0f2); padding-top: 0.6rem; }
    .recs-head { display: flex; align-items: center; justify-content: space-between; font-size: 0.75rem; font-weight: 700; color: var(--rm-muted, #5b6b7d); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.4rem; }
    .recs-head button { padding: 0.2rem 0.5rem; font-size: 0.75rem; }
    .rec-row { display: grid; grid-template-columns: 7rem 1fr 1fr auto; gap: 0.4rem; margin-bottom: 0.4rem; align-items: center; }
    .rec-row input { min-width: 0; }
    @media (max-width: 640px) { .rec-row { grid-template-columns: 1fr; } }
    /* Recursos de la tarjeta (MC-15): tipo + etiqueta + url + formato (libros). */
    .res-row { display: grid; grid-template-columns: 6rem 1fr 1fr 6rem auto; gap: 0.4rem; margin-bottom: 0.4rem; align-items: center; }
    .res-row input, .res-row select { min-width: 0; }
    @media (max-width: 640px) { .res-row { grid-template-columns: 1fr; } }
    textarea {
      font: inherit; font-size: 0.85rem; width: 100%; box-sizing: border-box;
      padding: 0.45rem 0.6rem; border: 1px solid var(--rm-border, #d1d5db); border-radius: 8px;
      background: var(--rm-field, #eef2f6); color: var(--rm-text, #111827); resize: vertical;
    }
    textarea:disabled { opacity: 0.6; cursor: not-allowed; }
    .matrix { display: grid; gap: 0.7rem; }
    .matrix-row { display: grid; grid-template-columns: 12rem 1fr; gap: 0.7rem; align-items: start; }
    .matrix-dim { padding-top: 0.4rem; font-size: 0.8rem; font-weight: 600; color: var(--rm-text, #111827); }
    .matrix-pick { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.75rem; color: var(--rm-muted, #5b6b7d); font-weight: 600; }
    @media (max-width: 640px) { .matrix-row { grid-template-columns: 1fr; } }
  `];

  constructor() {
    super();
    this.ready = false;
    this.isLeader = false;
    this.readOnly = false;
    const initial = resolveHash(location.hash.slice(1));
    /** @type {'leaders'|'areas'|'guilds'|'labels'|'career'|'users'} pestaña activa */
    this._tab = initial.tab;
    /** @type {'framework'|'map'} sub-pestaña de «Carrera» (RMR-TSK-0262). */
    this._careerSub = initial.sub ?? 'framework';
    /** @type {'rol'|'persona'} ámbito de «Permisos» (RMR-TSK-0460). */
    this._permSub = initial.tab === 'permisos' ? (initial.sub ?? 'rol') : 'rol';
    this._onHashChange = () => {
      const r = resolveHash(location.hash.slice(1));
      this._tab = r.tab;
      if (r.sub && r.tab === 'career') this._careerSub = r.sub;
      if (r.sub && r.tab === 'permisos') this._permSub = r.sub;
    };
    /** @type {import('../lib/leaders.js').Leader[]} */
    this.leaders = [];
    /** @type {Array<{uid:string,displayName:string|null,email:string|null}>} Heads para el selector de «reporta a» */
    this._supermanagers = [];
    this._error = '';
    /** @type {import('../tools/team/domain/ports.js').PersistencePort|null} persistencia del superadmin (viewAll) para los catálogos */
    this.persistence = null;
    /** @type {string|null} uid del superadmin (para <catalog-manager>) */
    this.currentUid = null;
    /** @type {import('../tools/career/data/framework.js').CareerFramework|null} */
    this._framework = null;
    this._fwNew = { track: '', discipline: '', dimension: '', levelCode: '', levelTitle: '' };
    /** @type {string} nivel seleccionado en la matriz de expectativas ('' → primero por orden) */
    this._fwExpLevel = '';
    /** @type {string} disciplina seleccionada en los addendums ('' → primera por orden) */
    this._fwAddDiscipline = '';
    /** @type {{ kind: 'tracks'|'levels'|'disciplines'|'dimensions', id: string }|null} */
    this._fwConfirm = null;
    this._fwError = '';
    this._fwNotice = '';
    this._fwSaving = false;
    /** @type {typeof FW_SUBTABS[number][0]} sub-pestaña activa del framework de carrera */
    this._fwSubtab = 'tracks';
    /** @type {import('../lib/accessRoles.js').AccessUser[]} */
    this._users = [];
    this._usersError = '';
    this._usersNotice = '';
    /** @type {string[]} uids ya vinculados a una persona (para no ofrecer "Asignar") */
    this._linkedUids = [];
    /** @type {import('../lib/accessRoles.js').AccessUser|null} usuario del modal "Asignar a equipo" */
    this._assignFor = null;
    /** @type {string} manager seleccionado en el modal "Asignar a equipo" */
    this._assignLeader = '';
    /** @type {import('../tools/team/domain/orgRoles.js').OrgRole[]} catálogo de roles del organigrama */
    this._orgRoles = [];
    /** @type {{ id: string, label: string, branch: string, reportsToRoleId: string }} borrador de rol nuevo */
    this._orgForm = { id: '', label: '', branch: 'engineering', reportsToRoleId: '' };
    this._orgError = '';
    this._orgNotice = '';
    /** @type {string|null} id de rol pendiente de confirmar borrado */
    this._orgConfirmDelete = null;
    /** @type {string|null} id de rol en edición de nombre (inline) */
    this._editRoleId = null;
    this._editRoleLabel = '';
    /** @type {string|null} id de persona en edición de email de invitación (inline) */
    this._editEmailId = null;
    this._editEmailValue = '';
    /** @type {string|null} id de persona en edición de nombre (inline) */
    this._editPersonNameId = null;
    this._editPersonNameValue = '';
    /** @type {import('../tools/team/domain/toolAccess.js').ToolPolicy[]} políticas de herramientas */
    this._toolPolicies = [];
    /** Persona cuyas excepciones de permisos se están viendo (RMR-TSK-0461). */
    this._permPersonId = '';
    this._toolError = '';
    this._toolNotice = '';
    /** @type {Array<Object>} personas /people (para verlas TODAS en Usuarios, F8c). */
    this._peopleList = [];
    this._peopleError = '';
    this._peopleNotice = '';
    /** @type {string|null} id de persona pendiente de confirmar baja. */
    this._confirmDeletePerson = null;
    this._confirmRemoveAccount = null;
    /** Mensaje del overlay mientras hay una escritura en curso, o null. */
    this._busy = null;
    this._newPersonName = '';
    this._newPersonEmail = '';
    this._newPersonRole = 'generico';
    /** @type {'editor'|'ramas'|'vista'} sub-pestaña del Organigrama. */
    this._orgSubtab = 'editor';
    /** @type {import('../lib/orgBranches.js').OrgBranch[]} catálogo de ramas. */
    this._orgBranches = [];
    this._newBranchLabel = '';
    this._editBranchId = null;
    this._editBranchLabel = '';
    this._branchError = '';
    /** @type {{for: string, label: string}|null} rama nueva en creación desde un select de rol ('__form__' = form de nuevo rol). */
    this._branchDraft = null;
    /** @type {import('../lib/jobDescriptions.js').JdRecord[]|null} JDs (lazy). */
    this._jds = null;
    /** @type {{ roleName: string, levelA: string, levelB: string, disciplineIds: string[], descriptionIntro: string, id?: string }|null} */
    this._jdForm = null;
    /** @type {Record<string, unknown>|null} payload de la vista previa. */
    this._jdPreview = null;
    this._jdError = '';
    this._jdNotice = '';
    /** JD cuyo enlace se acaba de copiar («✔ Copiado» temporal), o null. */
    this._jdCopiedId = null;
    /** Nivel a exportar en el MD del framework ('' = todos). */
    this._fwExportLevel = '';
    /** true mientras se pule/guarda una JD (capa bloqueante). */
    this._jdBusy = false;
    this._confirmJd = null;
    /** @type {string} etiqueta del nivel simbólico (usuarios del producto) en la cima. */
    this._loaded = false;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('hashchange', this._onHashChange);
  }

  disconnectedCallback() {
    window.removeEventListener('hashchange', this._onHashChange);
    super.disconnectedCallback();
  }

  /** @param {typeof TABS[number]} tab */
  _setTab(tab) {
    // Escribe el hash (recarga y atrás/adelante conservan la pestaña); el
    // listener de hashchange sincroniza _tab. Si el hash ya coincide, fija _tab.
    if (location.hash.slice(1) !== tab) location.hash = tab;
    else this._tab = tab;
  }

  updated() {
    if (this.ready && !this._loaded) {
      this._loaded = true;
      this._loadLeaders();
      this._loadFramework();
      this._loadOrgRoles();
      this._loadToolPolicies();
      // El viewer no gestiona usuarios: no hace falta cargar la pestaña.
      if (!this.readOnly) this._loadUsers();
    }
    this._syncOrgRoleSelects();
  }

  /** Fija el valor mostrado de los <select> del editor de roles DESPUÉS del render:
   *  sus <option> se generan en la misma plantilla y se crean tras el binding, así
   *  que el select no reflejaría el valor por sí solo. Sin esto, cambiar «Rama» o
   *  «Depende de» parecería no surtir efecto (el select vuelve a la 1ª opción). */
  _syncOrgRoleSelects() {
    const byId = new Map(this._orgRoles.map((r) => [r.id, r]));
    for (const sel of this.renderRoot.querySelectorAll('select[data-branch-for]')) {
      const role = byId.get(sel.dataset.branchFor);
      if (role && sel.value !== role.branch) sel.value = role.branch;
    }
    for (const sel of this.renderRoot.querySelectorAll('select[data-parent-for]')) {
      const role = byId.get(sel.dataset.parentFor);
      const want = role?.reportsToRoleId ?? '';
      if (role && sel.value !== want) sel.value = want;
    }
    // Select de rama del form «Nuevo rol»: reflejar siempre _orgForm.branch (nunca
    // el centinela «__new__»), aunque sus <option> se generen tras el binding.
    const formSel = this.renderRoot.querySelector('select[data-branch-form]');
    if (formSel && this._orgForm?.branch && formSel.value !== this._orgForm.branch) {
      formSel.value = this._orgForm.branch;
    }
  }


  // ── Framework de carrera (editor) ──────────────────────────────────────────

  async _loadFramework() {
    this._fwError = '';
    try {
      this._framework = await getFramework();
    } catch (err) {
      this._fwError = err instanceof Error ? err.message : 'No se pudo cargar el framework de carrera.';
    }
  }

  /** Reemplaza el framework de trabajo (copia inmutable para refrescar Lit). @param {Partial<import('../tools/career/data/framework.js').CareerFramework>} patch */
  _patchFramework(patch) {
    this._framework = { ...this._framework, ...patch };
    this._fwNotice = '';
  }

  /** @param {'tracks'|'levels'|'disciplines'|'dimensions'} kind @param {string} id */
  _isFwConfirm(kind, id) {
    return this._fwConfirm?.kind === kind && this._fwConfirm?.id === id;
  }

  /** @param {'tracks'|'levels'|'disciplines'|'dimensions'} kind @param {string} id @param {Record<string, unknown>} patch */
  _patchFwItem(kind, id, patch) {
    const list = /** @type {Array<any>} */ (this._framework[kind]).map((it) => (it.id === id ? { ...it, ...patch } : it));
    this._patchFramework({ [kind]: list });
  }

  /** Sube (-1) o baja (+1) un item intercambiando su `order` con el vecino. @param {'tracks'|'levels'|'disciplines'|'dimensions'} kind @param {string} id @param {-1|1} dir */
  _moveFwItem(kind, id, dir) {
    const sorted = /** @type {Array<any>} */ (this._framework[kind]).toSorted((a, b) => a.order - b.order);
    const pos = sorted.findIndex((it) => it.id === id);
    const swapPos = pos + dir;
    if (pos < 0 || swapPos < 0 || swapPos >= sorted.length) return;
    const a = sorted[pos];
    const b = sorted[swapPos];
    const list = /** @type {Array<any>} */ (this._framework[kind]).map((it) => {
      if (it.id === a.id) return { ...it, order: b.order };
      if (it.id === b.id) return { ...it, order: a.order };
      return it;
    });
    this._patchFramework({ [kind]: list });
  }

  /**
   * Reordena un nivel DENTRO de su track (no en la lista global): intercambia su
   * `order` con el del nivel vecino del mismo track. @param {string} trackId
   * @param {string} id @param {-1|1} dir
   */
  _moveLevelInTrack(trackId, id, dir) {
    const inTrack = this._framework.levels.filter((l) => l.trackId === trackId).toSorted((a, b) => a.order - b.order);
    const pos = inTrack.findIndex((l) => l.id === id);
    const swapPos = pos + dir;
    if (pos < 0 || swapPos < 0 || swapPos >= inTrack.length) return;
    const a = inTrack[pos];
    const b = inTrack[swapPos];
    const list = this._framework.levels.map((l) => {
      if (l.id === a.id) return { ...l, order: b.order };
      if (l.id === b.id) return { ...l, order: a.order };
      return l;
    });
    this._patchFramework({ levels: list });
  }

  /** Añade un track/disciplina/dimensión con id autogenerado y único. @param {'tracks'|'disciplines'|'dimensions'} kind @param {'track'|'discipline'|'dimension'} field @param {string} singular */
  _addNamed(kind, field, singular) {
    const name = this._fwNew[field].trim();
    this._fwError = '';
    if (!name) { this._fwError = `El ${singular} necesita un nombre.`; return; }
    const list = /** @type {Array<any>} */ (this._framework[kind]);
    const id = uniqueId(slugify(name), new Set(list.map((it) => it.id)));
    this._patchFramework({ [kind]: [...list, { id, name, order: nextOrder(list), description: '' }] });
    this._fwNew = { ...this._fwNew, [field]: '' };
  }

  /** @param {string} [preTrackId] track al que asignar el nivel (por defecto, el primero) */
  _addLevel(preTrackId) {
    const code = this._fwNew.levelCode.trim();
    const title = this._fwNew.levelTitle.trim();
    this._fwError = '';
    if (!code || !title) { this._fwError = 'El nivel necesita código y título.'; return; }
    const levels = this._framework.levels;
    const id = uniqueId(slugify(code) || slugify(title), new Set(levels.map((l) => l.id)));
    const trackId = this._framework.tracks.some((t) => t.id === preTrackId)
      ? /** @type {string} */ (preTrackId)
      : (this._framework.tracks[0]?.id ?? '');
    /** @type {import('../tools/career/data/framework.js').Level} */
    const level = { id, code, title, trackId, order: nextOrder(levels), description: '', typicalProfile: '', branchesFrom: null };
    this._patchFramework({ levels: [...levels, level] });
    this._fwNew = { ...this._fwNew, levelCode: '', levelTitle: '' };
  }

  /** @param {'tracks'|'levels'|'disciplines'|'dimensions'} kind @param {string} id */
  _deleteFwItem(kind, id) {
    this._fwError = '';
    // Un track en uso no se puede borrar: reasignar los niveles antes.
    if (kind === 'tracks') {
      const inUse = this._framework.levels.filter((l) => l.trackId === id);
      if (inUse.length) {
        this._fwConfirm = null;
        this._fwError = `No se puede borrar el track «${id}»: ${inUse.length} nivel(es) lo usan. Reasígnalos antes.`;
        return;
      }
    }
    const list = /** @type {Array<any>} */ (this._framework[kind]).filter((it) => it.id !== id);
    /** @type {Record<string, unknown>} */
    const patch = { [kind]: list };
    // Al borrar un nivel, limpia los branchesFrom que apuntaban a él.
    if (kind === 'levels') {
      patch.levels = list.map((l) => (l.branchesFrom === id ? { ...l, branchesFrom: null } : l));
    }
    this._patchFramework(patch);
    this._fwConfirm = null;
  }

  /** Catálogos simples (tracks/disciplinas/dimensiones): ids y nombres presentes,
   *  sin duplicados. Extraído de _validateFramework (Sonar S3776). */
  _validateCatalogs(fw) {
    for (const [kind, label] of /** @type {const} */ ([['tracks', 'track'], ['disciplines', 'disciplina'], ['dimensions', 'dimensión']])) {
      const seen = new Set();
      for (const it of fw[kind]) {
        if (!it.id.trim() || !it.name.trim()) return `Hay ${label}s sin id o sin nombre.`;
        if (seen.has(it.id)) return `${label} duplicad@: «${it.id}».`;
        seen.add(it.id);
      }
    }
    return null;
  }

  /** Niveles: id/título, sin duplicados, track existente y ramificación válida. */
  _validateLevels(fw) {
    const trackIds = new Set(fw.tracks.map((t) => t.id));
    const levelIds = new Set();
    for (const l of fw.levels) {
      if (!l.id.trim() || !l.title.trim()) return 'Hay niveles sin id o sin título.';
      if (levelIds.has(l.id)) return `Nivel duplicado: «${l.id}».`;
      levelIds.add(l.id);
      if (!trackIds.has(l.trackId)) return `El nivel «${l.id}» apunta a un track inexistente.`;
    }
    for (const l of fw.levels) {
      if (l.branchesFrom && !levelIds.has(l.branchesFrom)) return `El nivel «${l.id}» ramifica desde un nivel inexistente.`;
    }
    return null;
  }

  /** Valida el framework antes de guardar. @returns {string|null} mensaje de error o null */
  _validateFramework() {
    const fw = this._framework;
    return this._validateCatalogs(fw) ?? this._validateLevels(fw);
  }

  async _saveFramework() {
    this._fwError = '';
    this._fwNotice = '';
    const invalid = this._validateFramework();
    if (invalid) { this._fwError = invalid; return; }
    this._fwSaving = true;
    try {
      await saveFramework(this._framework);
      this._fwNotice = 'Framework guardado.';
    } catch (err) {
      this._fwError = err instanceof Error ? err.message : 'No se pudo guardar el framework.';
    } finally {
      this._fwSaving = false;
    }
  }

  // ── Matriz de expectativas (Nivel × Dimensión) ─────────────────────────────

  /** Texto de la celda {levelId, dimensionId} o '' si no existe. @param {string} levelId @param {string} dimensionId @returns {string} */
  _expectationText(levelId, dimensionId) {
    return this._framework.expectations.find((e) => e.levelId === levelId && e.dimensionId === dimensionId)?.text ?? '';
  }

  /** Crea/actualiza (o elimina si queda vacío) la celda de expectativa. @param {string} levelId @param {string} dimensionId @param {string} value */
  _setExpectation(levelId, dimensionId, value) {
    const list = this._framework.expectations;
    const idx = list.findIndex((e) => e.levelId === levelId && e.dimensionId === dimensionId);
    let next;
    if (!value.trim()) {
      next = idx >= 0 ? list.filter((_, i) => i !== idx) : list;
    } else if (idx >= 0) {
      next = list.map((e, i) => (i === idx ? { ...e, text: value } : e));
    } else {
      next = [...list, { levelId, dimensionId, text: value }];
    }
    this._patchFramework({ expectations: next });
  }

  // ── Addendums por disciplina (Disciplina × Dimensión) ──────────────────────

  /** Texto del addendum {disciplineId, dimensionId} o '' si no existe. @param {string} disciplineId @param {string} dimensionId @returns {string} */
  _addendumText(disciplineId, dimensionId) {
    return this._framework.addendums.find((a) => a.disciplineId === disciplineId && a.dimensionId === dimensionId)?.text ?? '';
  }

  /** Crea/actualiza (o elimina si queda vacío) el addendum. @param {string} disciplineId @param {string} dimensionId @param {string} value */
  _setAddendum(disciplineId, dimensionId, value) {
    const list = this._framework.addendums;
    const idx = list.findIndex((a) => a.disciplineId === disciplineId && a.dimensionId === dimensionId);
    let next;
    if (!value.trim()) {
      next = idx >= 0 ? list.filter((_, i) => i !== idx) : list;
    } else if (idx >= 0) {
      next = list.map((a, i) => (i === idx ? { ...a, text: value } : a));
    } else {
      next = [...list, { disciplineId, dimensionId, text: value }];
    }
    this._patchFramework({ addendums: next });
  }

  async _loadLeaders() {
    this._error = '';
    try {
      // Los Heads se cargan a la vez que los managers porque alimentan el
      // selector de «reporta a» (RMR-TSK-0295), pero son ACCESORIOS: si su
      // lectura falla, la lista de managers tiene que seguir viéndose igual que
      // antes de existir la jerarquía. Por eso allSettled y no all.
      const [leadersResult, headsResult] = await Promise.allSettled([listLeaders(), listSupermanagers()]);
      if (leadersResult.status === 'rejected') throw leadersResult.reason;
      this.leaders = leadersResult.value;
      this._supermanagers = headsResult.status === 'fulfilled' ? headsResult.value : [];
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'No se pudieron cargar los managers.';
    }
  }












  // ── Usuarios (accesos: superadmin / viewer / manager) ─────────────────────────

  async _loadUsers() {
    this._usersError = '';
    this._peopleError = '';
    // TODAS las personas dadas de alta (RMR-PCS-0027 · F8c), incluidas las que aún
    // no tienen cuenta: así el superadmin las ve y no las duplica. Se carga en
    // paralelo pero con estado de error PROPIO: un fallo NO se silencia (no mostrar
    // «no hay personas» en falso), se avisa en su sección.
    const peoplePromise = this.persistence ? listActivePeople(this.persistence) : Promise.resolve([]);
    try {
      const [users, linkedUids] = await Promise.all([listAllUsers(), listLinkedUids()]);
      this._users = users;
      this._linkedUids = linkedUids;
    } catch (err) {
      this._usersError = err instanceof Error ? err.message : 'No se pudieron cargar los usuarios.';
    }
    try {
      this._peopleList = await peoplePromise;
    } catch (err) {
      this._peopleError = err instanceof Error ? err.message : 'No se pudieron cargar las personas.';
    }
  }

  // ── Gestión de personas desde el panel (RMR-PCS-0027 · F8e) ────────────────

  /** Email visible: el de la ficha, o el de su cuenta vinculada, o la invitación. */
  _personEmail(p) {
    if (p.email) return p.email;
    if (p.uid) {
      const acc = this._users.find((u) => u.uid === p.uid);
      if (acc?.email) return acc.email;
    }
    return p.pendingEmail ?? null;
  }

  /** Cambia el rol organizativo de una persona (deriva la rama del catálogo). */
  async _setPersonRole(personId, roleId) {
    return this._withBusy('Actualizando el rol…', () => this._setPersonRoleImpl(personId, roleId));
  }

  async _setPersonRoleImpl(personId, roleId) {
    this._peopleError = '';
    this._peopleNotice = '';
    const branch = this._orgRoles.find((r) => r.id === roleId)?.branch ?? 'engineering';
    const before = this._peopleList.find((p) => p.id === personId);
    const prevRole = before?.orgRole ?? null;
    const prevBranch = before?.orgBranch ?? null;
    this._peopleList = this._peopleList.map((p) => (p.id === personId ? { ...p, orgRole: roleId, orgBranch: branch } : p));
    try {
      await this.persistence.people.update(personId, { orgRole: roleId, orgBranch: branch });
      this._peopleNotice = 'Rol actualizado.';
    } catch (err) {
      // Revert QUIRÚRGICO: solo si el valor sigue siendo el optimista de esta
      // llamada (no pisar un cambio posterior que sí guardó).
      this._peopleList = this._peopleList.map((p) => (p.id === personId && p.orgRole === roleId ? { ...p, orgRole: prevRole, orgBranch: prevBranch } : p));
      this._peopleError = 'No se pudo cambiar el rol.';
    }
  }

  /** Cambia el superior (reportsToPersonId) de una persona. */
  async _setPersonSuperior(personId, superiorId) {
    return this._withBusy('Actualizando el superior…', () => this._setPersonSuperiorImpl(personId, superiorId));
  }

  async _setPersonSuperiorImpl(personId, superiorId) {
    this._peopleError = '';
    this._peopleNotice = '';
    const val = superiorId || null;
    const before = this._peopleList.find((p) => p.id === personId);
    const prevSup = before?.reportsToPersonId ?? null;
    this._peopleList = this._peopleList.map((p) => (p.id === personId ? { ...p, reportsToPersonId: val } : p));
    try {
      await this.persistence.people.update(personId, { reportsToPersonId: val });
      this._peopleNotice = 'Superior actualizado.';
    } catch (err) {
      this._peopleList = this._peopleList.map((p) => (p.id === personId && p.reportsToPersonId === val ? { ...p, reportsToPersonId: prevSup } : p));
      this._peopleError = 'No se pudo cambiar el superior.';
    }
  }

  /** Cambia la RAMA de una persona (independiente de la del rol: p.ej. un Engineer
   *  que trabaja en Data). Optimista con rollback quirúrgico. */
  async _setPersonBranch(personId, branchId) {
    return this._withBusy('Actualizando la rama…', () => this._setPersonBranchImpl(personId, branchId));
  }

  async _setPersonBranchImpl(personId, branchId) {
    this._peopleError = '';
    this._peopleNotice = '';
    const val = branchId || null;
    const before = this._peopleList.find((p) => p.id === personId);
    const prev = before?.orgBranch ?? null;
    this._peopleList = this._peopleList.map((p) => (p.id === personId ? { ...p, orgBranch: val } : p));
    try {
      await this.persistence.people.update(personId, { orgBranch: val });
      this._peopleNotice = 'Rama actualizada.';
    } catch (err) {
      this._peopleList = this._peopleList.map((p) => (p.id === personId && p.orgBranch === val ? { ...p, orgBranch: prev } : p));
      this._peopleError = 'No se pudo cambiar la rama.';
    }
  }

  /** Da de baja a una persona (active:false, conserva el histórico). */
  async _removePerson(personId) {
    return this._withBusy('Dando de baja…', () => this._removePersonImpl(personId));
  }

  async _removePersonImpl(personId) {
    this._peopleError = '';
    this._peopleNotice = '';
    try {
      await this.persistence.people.deactivate(personId);
      this._peopleList = this._peopleList.filter((p) => p.id !== personId);
      this._confirmDeletePerson = null;
      this._peopleNotice = 'Persona dada de baja.';
    } catch (err) {
      this._peopleError = 'No se pudo dar de baja a la persona.';
    }
  }

  /** Alta de persona desde el panel: crea la ficha con su rol; si hay email,
   *  la pre-invita (pendingEmail: se vincula al primer login con ese email). */
  /**
   * Ejecuta una ESCRITURA con el DOM bloqueado (RMR-BUG-0100). Toda escritura
   * lleva overlay: mientras dura no se puede pulsar dos veces ni tocar otra
   * cosa. No captura errores —cada acción sigue gestionando los suyos—, solo
   * garantiza que el overlay se retira pase lo que pase.
   * @param {string} message lo que se está haciendo, en primera persona del plural
   * @param {() => Promise<unknown>} action
   */
  async _withBusy(message, action) {
    this._busy = message;
    try {
      return await action();
    } finally {
      this._busy = null;
    }
  }

  async _addPersonPanel() {
    return this._withBusy('Añadiendo la persona…', () => this._addPersonPanelImpl());
  }

  async _addPersonPanelImpl() {
    const name = this._newPersonName.trim();
    if (!name) { this._peopleError = 'El nombre es obligatorio.'; return; }
    this._peopleError = '';
    this._peopleNotice = '';
    const roleId = this._newPersonRole || 'generico';
    const branch = this._orgRoles.find((r) => r.id === roleId)?.branch ?? 'generico';
    const email = this._newPersonEmail.trim().toLowerCase();
    try {
      await this.persistence.people.create({
        name, orgRole: roleId, orgBranch: branch, active: true,
        startDate: new Date().toISOString().slice(0, 10),
        pendingEmail: email || null, guilds: [], disciplines: [], labels: [],
      });
      this._newPersonName = '';
      this._newPersonEmail = '';
      this._peopleNotice = 'Persona añadida.';
      await this._loadUsers();
    } catch (err) {
      this._peopleError = 'No se pudo añadir la persona.';
    }
  }

  /** Guarda el email de INVITACIÓN de una persona sin cuenta (RMR-BUG-0075):
   *  pendingEmail se vincula en su primer login vía Cloud Function. Vacío = quitar
   *  la invitación. Solo aplica a fichas sin uid (con cuenta, el email es el de la
   *  cuenta y no se edita aquí). */
  async _savePersonEmail(personId) {
    this._peopleError = '';
    this._peopleNotice = '';
    const person = this._peopleList.find((p) => p.id === personId);
    if (!person || person.uid) return;
    const email = this._editEmailValue.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this._peopleError = 'Ese email no parece válido.';
      return;
    }
    try {
      await this.persistence.people.update(personId, { pendingEmail: email || null });
      this._peopleList = this._peopleList.map((p) => (p.id === personId ? { ...p, pendingEmail: email || null } : p));
      this._editEmailId = null;
      this._editEmailValue = '';
      this._peopleNotice = email
        ? `Invitación guardada: «${person.name}» se vinculará en su primer login con ${email}.`
        : 'Invitación retirada.';
    } catch (err) {
      this._peopleError = err instanceof Error ? err.message : 'No se pudo guardar el email.';
    }
  }

  /** Guarda el nombre corregido de una persona (RMR-BUG-0076). El id no cambia:
   *  journey, O2O, notas y todo lo que referencia a la persona quedan intactos. */
  async _savePersonName(personId) {
    this._peopleError = '';
    this._peopleNotice = '';
    const person = this._peopleList.find((p) => p.id === personId);
    const name = this._editPersonNameValue.trim();
    if (!person) return;
    if (!name) { this._peopleError = 'El nombre no puede quedar vacío.'; return; }
    try {
      await this.persistence.people.update(personId, { name });
      this._peopleList = this._peopleList.map((p) => (p.id === personId ? { ...p, name } : p));
      this._editPersonNameId = null;
      this._editPersonNameValue = '';
      this._peopleNotice = `Nombre corregido a «${name}».`;
    } catch (err) {
      this._peopleError = err instanceof Error ? err.message : 'No se pudo guardar el nombre.';
    }
  }

  /** Celda de nombre de la tabla de personas: texto con lápiz de edición inline
   *  (Enter guarda, Esc cancela) — mismo patrón que el email (RMR-BUG-0076). */
  _renderPersonNameCell(p) {
    if (this._editPersonNameId === p.id) {
      return html`<input class="role-rename" .value=${this._editPersonNameValue}
          @input=${(e) => { this._editPersonNameValue = e.target.value; }}
          @keydown=${(e) => { if (e.key === 'Enter') this._savePersonName(p.id); else if (e.key === 'Escape') { this._editPersonNameId = null; } }}>
        <button type="button" class="ord-btn" @click=${() => this._savePersonName(p.id)}>Guardar</button>
        <button type="button" class="ord-btn" @click=${() => { this._editPersonNameId = null; }}>✕</button>`;
    }
    return html`${p.name}
      <button type="button" class="rename-btn" title="Editar nombre" aria-label="Editar nombre de ${p.name}"
        @click=${() => { this._editPersonNameId = p.id; this._editPersonNameValue = p.name; }}>✎</button>`;
  }

  /** Celda de email de la tabla de personas: con cuenta, solo lectura (el de la
   *  cuenta); sin cuenta, editable inline (lápiz → input, Enter guarda, Esc cancela). */
  _renderPersonEmailCell(p) {
    const email = this._personEmail(p);
    if (p.uid) return html`${email ?? html`<span class="muted">—</span>`}`;
    if (this._editEmailId === p.id) {
      return html`<input class="role-rename" type="email" placeholder="email@empresa.com" .value=${this._editEmailValue}
          @input=${(e) => { this._editEmailValue = e.target.value; }}
          @keydown=${(e) => { if (e.key === 'Enter') this._savePersonEmail(p.id); else if (e.key === 'Escape') { this._editEmailId = null; } }}>
        <button type="button" class="ord-btn" @click=${() => this._savePersonEmail(p.id)}>Guardar</button>
        <button type="button" class="ord-btn" @click=${() => { this._editEmailId = null; }}>✕</button>`;
    }
    return html`${email ?? html`<span class="muted">—</span>`}
      <button type="button" class="rename-btn" title="Editar email de invitación" aria-label="Editar email de ${p.name}"
        @click=${() => { this._editEmailId = p.id; this._editEmailValue = email ?? ''; }}>✎</button>`;
  }

  /** Estado de acceso (superadmin/viewer/People) de la cuenta vinculada a una persona. */
  _accessOf(uid) {
    return this._users.find((u) => u.uid === uid) ?? null;
  }

  /** Cuentas logadas que aún NO tienen ficha /people — para crearla desde aquí. */
  _orphanAccounts() {
    // Se compara con TODAS las personas, no solo las activas (RMR-BUG-0109):
    // `_peopleList` son las activas, así que dar de baja a alguien convertía su
    // cuenta en «sin ficha» y ofrecía crearle otra — dejándole dos fichas y el
    // historial partido. `_linkedUids` ya trae los uids de todas, de baja
    // incluidas; solo faltaba usarlo.
    const conFicha = new Set([
      ...(this._linkedUids ?? []),
      ...this._peopleList.map((p) => p.uid),
    ].filter(Boolean));
    return this._users.filter((u) => !conFicha.has(u.uid));
  }

  /**
   * Fila de una cuenta sin ficha. No todas son lo mismo: a un viewer se le dio
   * acceso de solo lectura a propósito y no necesita ficha, mientras que una
   * cuenta sin rol que no entra desde hace meses sí es residuo (RMR-TSK-0446).
   * Pintarlas igual convertía lo esperable en un problema y escondía el residuo
   * de verdad entre el ruido.
   */
  _renderOrphanRow(u) {
    const tipo = classifyAccountWithoutPerson(u, { ahora: Date.now() });
    const detalle = {
      // El rol derivado ya incluye el gobierno: repetirlo daba «Superadmin y superadmin».
      acceso: html`Tiene <strong>${ROLE_LABEL[u.role] ?? u.role}</strong>${u.isAdmin && u.role !== 'superadmin' ? ' y superadmin' : ''}: acceso concedido, sin ficha de persona.`,
      reciente: html`Ha entrado hace poco y todavía no tiene ficha de persona.`,
      residuo: html`Sin ningún acceso y sin actividad: se puede retirar.`,
    }[tipo];
    const retirando = this._confirmRemoveAccount === u.uid;
    return html`<tr>
      <td>${u.displayName ?? '—'} <span class="muted">(cuenta sin ficha)</span></td>
      <td>${u.email ?? html`<span class="muted">—</span>`}</td>
      <td colspan="2"><span class="muted">${detalle}</span></td>
      <td>
        ${retirando
          ? html`<span class="confirm">¿Retirar acceso? <button class="yes" @click=${() => this._removeAccount(u)}>Sí</button> <button @click=${() => { this._confirmRemoveAccount = null; }}>No</button></span>`
          : html`<button class="primary" @click=${() => this._createPersonForAccount(u)}>Crear ficha</button>
            ${tipo === 'residuo'
              ? html`<button class="del-btn" @click=${() => { this._confirmRemoveAccount = u.uid; }}>Retirar</button>`
              : null}`}
      </td>
    </tr>`;
  }

  /** Retira los roles y el registro de una cuenta residual. */
  async _removeAccount(u) {
    this._confirmRemoveAccount = null;
    return this._withBusy('Retirando la cuenta…', async () => {
      this._peopleError = '';
      this._peopleNotice = '';
      try {
        await deleteUnusedUser(u.uid);
        this._peopleNotice = 'Cuenta retirada.';
        await this._loadUsers();
      } catch (err) {
        // El mensaje de deleteUnusedUser explica qué reasignar antes: se enseña
        // tal cual, en vez de un «no se pudo» que no ayuda a nadie.
        this._peopleError = err instanceof Error ? err.message : 'No se pudo retirar la cuenta.';
      }
    });
  }

  /** Crea la ficha de una cuenta logada que aún no tiene persona (caso residual:
   *  se logueó pero no se le creó ficha). Nace como 'generico', ya vinculada. */
  async _createPersonForAccount(u) {
    return this._withBusy('Creando la ficha…', () => this._createPersonForAccountImpl(u));
  }

  async _createPersonForAccountImpl(u) {
    this._peopleError = '';
    this._peopleNotice = '';
    try {
      await this.persistence.people.create({
        name: u.displayName ?? u.email ?? 'Sin nombre',
        uid: u.uid, email: u.email ?? null,
        orgRole: 'generico', orgBranch: 'generico', active: true,
        startDate: new Date().toISOString().slice(0, 10),
        guilds: [], disciplines: [], labels: [],
      });
      this._peopleNotice = 'Ficha creada para la cuenta.';
      await this._loadUsers();
    } catch (err) {
      this._peopleError = 'No se pudo crear la ficha de la cuenta.';
    }
  }

  /** Celda de acceso de una persona: superadmin + acceso especial (viewer/People).
   *  Solo con cuenta vinculada (los roles de acceso son por uid). */
  _renderPersonAccess(p) {
    if (!p.uid) return html`<span class="muted">requiere cuenta</span>`;
    const acc = this._accessOf(p.uid);
    const gobierno = this._governanceOf(acc);
    const grupo = `gov-${p.uid}`;
    return html`
      <div class="gov" role="radiogroup" aria-label="Gobierno de ${p.name ?? 'la persona'}">
        ${GOVERNANCE.map(([value, label, ayuda]) => html`
          <label class="gov-opt" title=${ayuda}>
            <input type="radio" name=${grupo} value=${value} .checked=${gobierno === value}
              @change=${() => this._setGovernance(p, value)} />${label}
          </label>`)}
      </div>
`;
  }

  /** Gobierno actual de una cuenta: los dos valores son excluyentes por modelo. */
  _governanceOf(acc) {
    if (acc?.isAdmin) return 'admin';
    return acc?.role === 'viewer' ? 'viewer' : 'none';
  }

  /**
   * Fija el gobierno de instancia de una cuenta (ADR «Acceso en dos ejes»).
   * `admin` y `viewer` son mutuamente excluyentes —de ahí el radio y no dos
   * casillas: dos casillas dejarían marcar las dos y afirmar algo imposible—.
   * Solo se toca el rol de equipo si la cuenta ERA viewer o pasa a serlo: quitar
   * el gobierno no puede llevarse por delante su rol funcional.
   */
  async _setGovernance(p, value) {
    return this._withBusy('Actualizando el gobierno…', () => this._setGovernanceImpl(p, value));
  }

  async _setGovernanceImpl(p, value) {
    {
      this._peopleError = '';
      this._peopleNotice = '';
      const profile = { displayName: p.name, email: this._personEmail(p) };
      const antes = this._governanceOf(this._accessOf(p.uid));
      try {
        await setUserAdmin(p.uid, value === 'admin', profile);
        if (value === 'viewer') await setUserRole(p.uid, 'viewer', profile);
        else if (antes === 'viewer') await setUserRole(p.uid, 'none', profile);
        await this._loadUsers();
        this._peopleNotice = 'Gobierno actualizado.';
      } catch {
        this._peopleError = 'No se pudo cambiar el gobierno.';
      }
    }
  }

  _closeAssign() {
    this._assignFor = null;
    this._assignLeader = '';
  }

  /**
   * Crea una persona vinculada al usuario dentro del equipo del manager elegido y
   * refresca la lista (el usuario pasará a estar vinculado).
   */
  async _assign() {
    const user = this._assignFor;
    const leaderUid = this._assignLeader;
    if (!user || !leaderUid) return;
    this._usersError = '';
    try {
      await assignUserToLeader(user, leaderUid);
      this._assignFor = null;
      this._assignLeader = '';
      this._usersNotice = 'Usuario asignado a un equipo.';
      await this._loadUsers();
    } catch (err) {
      this._usersError = err instanceof Error ? err.message : 'No se pudo asignar el usuario.';
    }
  }





  _useAsLeader() {
    sessionStorage.setItem(VIEW_FLAG, 'leader');
    location.assign('/');
  }

  /** Un catálogo (áreas/gremios/labels) del superadmin: el componente ÚNICO
   * <catalog-manager> (mismo que en Ajustes). isAdmin=true salvo viewer. */
  _renderCatalogTab(kind, title) {
    return html`
      <section>
        <h2>${title}</h2>
        <catalog-manager
          .kind=${kind}
          .persistence=${this.persistence}
          .isAdmin=${!this.readOnly}
          .readOnly=${this.readOnly}
          .currentUid=${this.currentUid}
          .leaders=${this.leaders}
          .withMeta=${kind === 'labels' || kind === 'squads'}
          placeholder="Nuevo global…"
        ></catalog-manager>
      </section>
    `;
  }

  _renderTabContent() {
    switch (this._tab) {
      case 'organigrama':
        return this._renderOrgRoles();
      case 'areas':
        return this._renderCatalogTab('areas', 'Áreas de conocimiento (organización)');
      case 'guilds':
        return this._renderCatalogTab('guilds', 'Gremios (organización)');
      case 'dominios':
        // El catálogo de squads se sustituye por dominios y subdominios (ADR «De
        // squads a dominios y subdominios»). /squads sigue en los datos durante
        // la transición, pero ya no se gestiona desde aquí.
        return html`<domains-manager .ready=${this.ready} ?read-only=${this.readOnly}></domains-manager>`;
      case 'labels':
        return this._renderCatalogTab('labels', 'Labels (organización)');
      case 'career':
        return this._renderCareer();
      case 'permisos':
        return this._renderPermisos();
      case 'users':
        return this._renderUsers();
      default:
        return null;
    }
  }

  render() {
    return html`
      ${this._busy ? html`<busy-overlay message=${this._busy}></busy-overlay>` : null}
      <div class="bar">
        <h1>Gestión de la organización</h1>
        ${this.readOnly ? html`<span class="badge" style="background:var(--rm-muted, #5b6b7d)">Modo solo lectura (viewer)</span>` : null}
        ${this.isLeader && !this.readOnly
          ? html`<button class="primary" @click=${this._useAsLeader}>Usar como manager →</button>`
          : null}
      </div>
      <nav class="tabs" aria-label="Secciones de gestión">
        <button class="tab ${this._tab === 'organigrama' ? 'active' : ''}" @click=${() => this._setTab('organigrama')}>Organigrama</button>
        <button class="tab ${this._tab === 'areas' ? 'active' : ''}" @click=${() => this._setTab('areas')}>Áreas</button>
        <button class="tab ${this._tab === 'guilds' ? 'active' : ''}" @click=${() => this._setTab('guilds')}>Gremios</button>
        <button class="tab ${this._tab === 'dominios' ? 'active' : ''}" @click=${() => this._setTab('dominios')}>Dominios</button>
        <button class="tab ${this._tab === 'labels' ? 'active' : ''}" @click=${() => this._setTab('labels')}>Labels</button>
        <button class="tab ${this._tab === 'career' ? 'active' : ''}" @click=${() => this._setTab('career')}>Carrera</button>
        ${this.readOnly
          ? null
          : html`<button class="tab ${this._tab === 'users' ? 'active' : ''}" @click=${() => this._setTab('users')}>Usuarios</button>`}
        <button class="tab ${this._tab === 'permisos' ? 'active' : ''}" @click=${() => this._setTab('permisos')}>Permisos</button>
      </nav>
      ${this._error ? html`<p class="error">${this._error}</p>` : null}
      ${this._renderTabContent()}
    `;
  }

  /** «Carrera» con dos sub-pestañas (RMR-TSK-0262): el framework de rol (niveles/
   *  disciplinas/expectativas) y el mapa/archipiélago, antes dos pestañas de
   *  primer nivel con nombres casi iguales. Simétrico a «Mi carrera» del ingeniero. */
  /** Enruta la sub-pestaña de Carrera (framework/mapa/JD) sin ternarios anidados. */
  _renderCareerSub(sub) {
    if (sub === 'map') return this._renderCareerMap();
    if (sub === 'jd') return this._renderJds();
    return this._renderFramework();
  }

  // ── Job Descriptions (RMR-PCS-0031 · F3) ────────────────────────────────────

  /** Carga perezosa de las JDs (reintenta si falló: _jds queda null). */
  async _ensureJds() {
    if (this._jds !== null) return;
    try {
      this._jds = await listJds();
    } catch {
      this._jdError = 'No se pudieron cargar las Job Descriptions. Reabre la pestaña para reintentar.';
    }
  }

  /** Genera la vista previa (payload validado) desde el formulario. */
  /**
   * Genera y valida el payload desde el ESTADO ACTUAL del formulario (única
   * fuente de verdad: lo usan la vista previa y Guardar — así Guardar nunca
   * depende de haber pulsado antes la vista previa ni puede persistir un
   * payload desactualizado, RMR-BUG-0084). Fija el id en el form la primera
   * vez. @returns {Record<string, unknown>|null} null si no valida (deja el error puesto).
   */
  _buildJdPayload() {
    this._jdError = '';
    const f = this._jdForm;
    if (!f || !this._framework) return null;
    const levelIds = [f.levelA, f.levelB].filter(Boolean);
    try {
      const id = f.id ?? `jd-${slugify(f.roleName)}-${Date.now().toString(36)}`;
      const payload = generateJobDescription(this._framework, {
        jdId: id,
        roleName: f.roleName.trim(),
        levelIds,
        disciplineIds: f.disciplineIds,
        datePosted: new Date().toISOString().slice(0, 10),
        descriptionIntro: f.descriptionIntro,
      });
      const { valid, errors } = validateJobDescription(payload);
      if (!valid) { this._jdError = `El payload no valida: ${errors.join(' ')}`; return null; }
      this._jdForm = { ...f, id };
      return payload;
    } catch (err) {
      this._jdError = err instanceof Error ? err.message : 'No se pudo generar la JD.';
      return null;
    }
  }

  _previewJd() {
    this._jdPreview = this._buildJdPayload();
  }

  /** Guarda la JD (borrador; si ya existía conserva su estado). */
  /**
   * Pulido IA de los tres campos redactados (RMR-TSK-0418): Haiku corrige solo
   * concordancias; si la CF falla o no hay IA, devuelve el payload determinista
   * con un aviso (visible, nunca silencioso).
   * @param {Record<string, unknown>} payload
   * @returns {Promise<{ payload: Record<string, unknown>, notice: string }>}
   */
  async _polishJdPayload(payload) {
    const unbullet = (text) => String(text ?? '').split('\n').map((l) => l.replace(/^• /, '')).filter(Boolean);
    try {
      const polished = await polishJdRequirements({
        responsibilities: unbullet(payload.responsibilities),
        niceToHave: unbullet(payload['x-niceToHave'] ?? ''),
        month3: payload['x-onboardingExpectations'].month3,
      });
      const next = {
        ...payload,
        responsibilities: polished.responsibilities.map((i) => `• ${i}`).join('\n'),
        'x-niceToHave': payload['x-niceToHave'] ? polished.niceToHave.map((i) => `• ${i}`).join('\n') : null,
        'x-onboardingExpectations': { ...payload['x-onboardingExpectations'], month3: polished.month3 },
      };
      const { valid } = validateJobDescription(next);
      if (!valid) return { payload, notice: ' (el pulido IA no validó: se guardó la redacción determinista)' };
      return { payload: next, notice: polished.changed > 0 ? ` (IA: ${polished.changed} ítems afinados)` : '' };
    } catch (err) {
      console.error('[jd] pulido IA no disponible:', err);
      return { payload, notice: ' (sin pulido IA: se guardó la redacción determinista)' };
    }
  }

  async _saveJd() {
    // Regenera y valida SIEMPRE desde el form actual: no exige haber pulsado
    // la vista previa y nunca persiste un payload desactualizado (RMR-BUG-0084).
    const built = this._buildJdPayload();
    if (!built) return;
    const f = this._jdForm;
    this._jdNotice = '';
    this._jdBusy = true;
    const { payload, notice } = await this._polishJdPayload(built);
    try {
      await saveJd(f.id, {
        roleName: f.roleName.trim(),
        levelIds: [f.levelA, f.levelB].filter(Boolean),
        disciplineIds: f.disciplineIds,
        descriptionIntro: f.descriptionIntro,
        datePosted: payload.datePosted,
        payload,
      });
      const prev = (this._jds ?? []).find((j) => j.id === f.id);
      const next = {
        id: f.id,
        status: prev?.status ?? 'borrador',
        roleName: f.roleName.trim(),
        levelIds: [f.levelA, f.levelB].filter(Boolean),
        disciplineIds: f.disciplineIds,
        descriptionIntro: f.descriptionIntro,
        datePosted: payload.datePosted,
        payload,
        publishedAt: prev?.publishedAt ?? null,
      };
      this._jds = [...(this._jds ?? []).filter((j) => j.id !== f.id), next];
      this._jdForm = null;
      this._jdPreview = null;
      this._jdNotice = `JD «${next.roleName}» guardada${next.status === 'publicada' ? ' (sigue publicada, payload actualizado)' : ' como borrador'}${notice}.`;
    } catch (err) {
      this._jdError = err instanceof Error ? err.message : 'No se pudo guardar la JD.';
    } finally {
      this._jdBusy = false;
    }
  }

  /** Publica/despublica con rollback optimista. */
  async _toggleJdPublished(jdRecord) {
    this._jdError = '';
    const publish = jdRecord.status !== 'publicada';
    const prev = this._jds;
    this._jds = this._jds.map((j) => (j.id === jdRecord.id ? { ...j, status: publish ? 'publicada' : 'borrador' } : j));
    try {
      await (publish ? publishJd(jdRecord.id) : unpublishJd(jdRecord.id));
      this._jdNotice = publish ? `Publicada: /jd/${jdRecord.id}` : 'Despublicada (su URL responde 404).';
    } catch (err) {
      this._jds = prev;
      this._jdError = err instanceof Error ? err.message : 'No se pudo cambiar el estado.';
    }
  }

  async _removeJd(id) {
    this._jdError = '';
    try {
      await deleteJd(id);
      this._jds = (this._jds ?? []).filter((j) => j.id !== id);
      this._confirmJd = null;
      this._jdNotice = 'JD borrada.';
    } catch (err) {
      this._jdError = err instanceof Error ? err.message : 'No se pudo borrar.';
    }
  }

  _jdPublicUrl(id) {
    return `${globalThis.location?.origin ?? ''}/jd/${id}`;
  }

  _renderJds() {
    const jds = (this._jds ?? []).toSorted((a, b) => a.roleName.localeCompare(b.roleName));
    const levels = this._framework?.levels ?? [];
    const disciplines = this._framework?.disciplines ?? [];
    return html`
      <section>
        <h2>Job Descriptions desde el framework</h2>
        <p class="ro-note">Genera una JD desde tus niveles reales (nivel único o rango «entre niveles»), guárdala y PUBLÍCALA: obtiene una URL pública estable (<code>/jd/{id}</code>) con el JSON-LD estándar (JobPosting + x-careerLevel) que cualquier consumidor puede leer. Despublicar deja la URL en 404.</p>
        ${this._jdError ? html`<p class="error">${this._jdError}</p>` : null}
        ${this._jdNotice ? html`<p class="notice">${this._jdNotice}</p>` : null}
        ${jds.map((j) => this._renderJdRow(j))}
        ${this._jdBusy ? html`<busy-overlay message="Puliendo la redacción y guardando la JD…"></busy-overlay>` : null}
        ${this._jdForm ? this._renderJdForm(levels, disciplines) : html`<button class="primary" @click=${() => { this._jdForm = { roleName: '', levelA: levels.at(0)?.id ?? '', levelB: '', disciplineIds: [], descriptionIntro: '' }; this._jdPreview = null; }}>➕ Nueva Job Description</button>`}
      </section>`;
  }

  /**
   * Copia la URL pública con feedback INMEDIATO en el propio botón
   * (RMR-BUG-0085): «✔ Copiado» ~1,6s; si el portapapeles falla o no existe,
   * error visible — nunca un clic mudo.
   * @param {{ id: string }} j
   */
  async _copyJdUrl(j) {
    const url = this._jdPublicUrl(j.id);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard no disponible');
      await navigator.clipboard.writeText(url);
      this._jdError = '';
      this._jdCopiedId = j.id;
      setTimeout(() => {
        if (this._jdCopiedId === j.id) this._jdCopiedId = null;
      }, 1600);
    } catch (err) {
      console.error('[jd] no se pudo copiar la URL:', err);
      this._jdError = 'No se pudo copiar al portapapeles: copia el enlace a mano (clic derecho sobre él).';
    }
  }

  _renderJdRow(j) {
    const published = j.status === 'publicada';
    const url = this._jdPublicUrl(j.id);
    return html`<div class="egg-row">
      <div class="egg-head">
        <strong>${j.roleName}</strong>
        <span class="muted">${j.levelIds.join(' – ')}${j.disciplineIds.length ? ` · ${j.disciplineIds.join(', ')}` : ''}</span>
        ${published
          ? html`<a href=${url} target="_blank" rel="noopener">${url}</a>
            <button
              class="ord-btn ${this._jdCopiedId === j.id ? 'copied' : ''}"
              @click=${() => this._copyJdUrl(j)}
            >${this._jdCopiedId === j.id ? '✔ Copiado' : 'Copiar URL'}</button>`
          : html`<span class="muted">borrador</span>`}
        <button class="ord-btn" @click=${() => { this._jdForm = { id: j.id, roleName: j.roleName, levelA: j.levelIds[0] ?? '', levelB: j.levelIds[1] ?? '', disciplineIds: j.disciplineIds, descriptionIntro: j.descriptionIntro }; this._jdPreview = j.payload; }}>Editar</button>
        <button class="ord-btn" @click=${() => this._toggleJdPublished(j)}>${published ? 'Despublicar' : 'Publicar'}</button>
        ${this._confirmJd === j.id
          ? html`<span class="confirm">¿Borrar? <button @click=${() => this._removeJd(j.id)}>Sí</button> <button @click=${() => { this._confirmJd = null; }}>No</button></span>`
          : html`<button class="del-btn" @click=${() => { this._confirmJd = j.id; }}>Borrar</button>`}
      </div>
    </div>`;
  }

  _renderJdForm(levels, disciplines) {
    const f = this._jdForm;
    const patch = (p) => { this._jdForm = { ...this._jdForm, ...p }; this._jdPreview = null; };
    return html`<div class="egg-form">
      <h3>${f.id ? 'Editar JD' : 'Nueva JD'}</h3>
      <div class="fields">
        <label>Rol <input .value=${f.roleName} @input=${(e) => patch({ roleName: e.target.value })} placeholder="Backend Engineer"></label>
        <label>Nivel
          <select @change=${(e) => patch({ levelA: e.target.value })}>
            ${levels.map((l) => html`<option value=${l.id} ?selected=${f.levelA === l.id}>${l.code} · ${l.title}</option>`)}
          </select></label>
        <label>Hasta nivel (opcional: rango)
          <select @change=${(e) => patch({ levelB: e.target.value })}>
            <option value="" ?selected=${!f.levelB}>— solo un nivel —</option>
            ${levels.map((l) => html`<option value=${l.id} ?selected=${f.levelB === l.id}>${l.code} · ${l.title}</option>`)}
          </select></label>
      </div>
      <div class="fields">
        ${disciplines.map((d) => html`<label class="chk"><input type="checkbox"
          .checked=${f.disciplineIds.includes(d.id)}
          @change=${(e) => patch({ disciplineIds: e.target.checked ? [...f.disciplineIds, d.id] : f.disciplineIds.filter((x) => x !== d.id) })}> ${d.name}</label>`)}
      </div>
      <label class="wide">Intro opcional (encabezado de la descripción)
        <textarea rows="2" .value=${f.descriptionIntro} @input=${(e) => patch({ descriptionIntro: e.target.value })}></textarea></label>
      <div class="actions-row">
        <button @click=${() => this._previewJd()}>👁 Vista previa</button>
        <button class="primary" ?disabled=${!f.roleName.trim()} @click=${() => this._saveJd()}>Guardar</button>
        <button @click=${() => { this._jdForm = null; this._jdPreview = null; }}>Cancelar</button>
      </div>
      ${this._jdPreview ? html`<details open class="jd-preview"><summary>Vista previa (JSON-LD válido ✓)</summary><pre>${JSON.stringify(this._jdPreview, null, 2)}</pre></details>` : null}
    </div>`;
  }

  /**
   * Exporta el framework VIVO a Markdown (RMR-TSK-0428): completo o un nivel
   * concreto. Generación pura en dominio; descarga vía Blob en cliente.
   */
  _exportFrameworkMd() {
    try {
      const levelId = this._fwExportLevel || null;
      const md = frameworkToMarkdown(this._framework, {
        levelId,
        generatedAt: new Date().toISOString().slice(0, 10),
      });
      const level = levelId ? this._framework.levels.find((l) => l.id === levelId) : null;
      const name = level ? `framework-${level.code.toLowerCase()}.md` : 'framework-niveles.md';
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      this._fwError = err instanceof Error ? err.message : 'No se pudo exportar el framework.';
    }
  }

  _renderCareer() {
    const valid = ['map', 'jd'];
    const sub = valid.includes(this._careerSub) ? this._careerSub : 'framework';
    const subs = [
      ['framework', 'Framework (niveles y disciplinas)'],
      ['map', 'Mapa (archipiélago)'],
      ['jd', 'Job Descriptions'],
    ];
    return html`
      <div class="csubtabs" role="tablist" aria-label="Secciones de Carrera">
        ${subs.map(
          ([id, label]) => html`<button
            role="tab"
            aria-selected=${sub === id}
            class="csubtab ${sub === id ? 'on' : ''}"
            @click=${() => { this._careerSub = id; if (id === 'jd') this._ensureJds(); }}
          >${label}</button>`,
        )}
      </div>
      <div role="tabpanel">
        ${this._renderCareerSub(sub)}
      </div>
    `;
  }

  /** El editor del mapa (RMR-TSK-0259): el game-editor rediseñado, embebido en el
   *  panel (sin su cabecera propia). Un viewer no lo edita. */
  _renderCareerMap() {
    if (this.readOnly) {
      return html`<section>
        <h2>Plan de desarrollo</h2>
        <p class="ro-note">El editor del plan de desarrollo es solo para superadmin.</p>
      </section>`;
    }
    return html`<game-editor .ready=${this.ready} .embedded=${true}></game-editor>`;
  }

  // ── Framework de carrera (render) ──────────────────────────────────────────

  _renderFramework() {
    const fw = this._framework;
    return html`
      <section>
        <h2>Framework de carrera</h2>
        <p class="ro-note">Catálogo global de la organización: itinerarios (tracks), niveles, disciplinas y dimensiones. Los cambios se aplican al guardar.</p>
        ${this._fwError ? html`<p class="error">${this._fwError}</p>` : null}
        ${this._fwNotice ? html`<p class="notice">${this._fwNotice}</p>` : null}
        ${!fw
          ? html`<p class="empty">Cargando el framework…</p>`
          : html`
              <div class="subtabs" role="tablist">
                ${FW_SUBTABS.map(([id, label]) => html`
                  <button class="subtab ${this._fwSubtab === id ? 'active' : ''}" role="tab" aria-selected=${this._fwSubtab === id}
                    @click=${() => { this._fwSubtab = id; }}>${label}</button>`)}
              </div>
              ${this._renderFwActiveSubtab(fw)}
              <div class="toolbar" style="margin-top:1rem">
                ${this.readOnly
                  ? null
                  : html`<button class="primary" ?disabled=${this._fwSaving} @click=${() => this._saveFramework()}>
                      ${this._fwSaving ? 'Guardando…' : 'Guardar framework'}
                    </button>`}
                <select aria-label="Nivel a exportar" @change=${(e) => { this._fwExportLevel = e.target.value; }}>
                  <option value="" ?selected=${!this._fwExportLevel}>Todos los niveles</option>
                  ${(fw.levels ?? []).toSorted((a, b) => a.order - b.order).map(
                    (l) => html`<option value=${l.id} ?selected=${this._fwExportLevel === l.id}>${l.code} · ${l.title}</option>`,
                  )}
                </select>
                <button class="ord-btn" @click=${() => this._exportFrameworkMd()}>⬇ Exportar MD</button>
              </div>
            `}
      </section>
    `;
  }

  /**
   * Contenido de la sub-pestaña activa del framework. Un dispatch por `switch`
   * (en vez de ternarios encadenados dentro de la plantilla) mantiene baja la
   * complejidad de _renderFramework y evita ternarios anidados.
   * @param {import('../tools/career/data/framework.js').CareerFramework} fw
   */
  _renderFwActiveSubtab(fw) {
    switch (this._fwSubtab) {
      case 'disciplines':
        return this._renderNamedSection('disciplines', 'Disciplinas', 'disciplina', 'discipline', fw.disciplines, 'Disciplina = familia de carrera que matiza las expectativas de cada nivel; la gestiona el superadmin. Ejemplos: Backend, Web/Frontend, Infra/Platform, Data/ML, Mobile.');
      case 'dimensions':
        return this._renderNamedSection('dimensions', 'Dimensiones', 'dimensión', 'dimension', fw.dimensions, 'Ejes de evaluación de cada nivel. Ejemplos: Technical Excellence, Reliability, Product.');
      case 'expectations':
        return this._renderFwExpectations(fw);
      case 'addendums':
        return this._renderFwAddendums(fw);
      default:
        return this._renderFwTracksAndLevels(fw);
    }
  }

  /**
   * Sección de items con nombre (tracks/disciplinas/dimensiones: misma forma).
   * @param {'tracks'|'disciplines'|'dimensions'} kind
   * @param {string} title @param {string} singular
   * @param {'track'|'discipline'|'dimension'} field  clave en _fwNew
   * @param {Array<import('../tools/career/data/framework.js').NamedItem>} items
   * @param {string} [hint]  explicación breve del eje (qué es + ejemplos)
   */
  _renderNamedSection(kind, title, singular, field, items, hint = '') {
    const sorted = [...items].toSorted((a, b) => a.order - b.order);
    return html`
      <details open>
        <summary class="sub">${title} (${items.length})</summary>
        ${hint ? html`<p class="ro-note">${hint}</p>` : null}
        ${this.readOnly
          ? null
          : html`<div class="toolbar">
              <input type="text" placeholder=${`Nombre del ${singular}`} .value=${this._fwNew[field]}
                @input=${(e) => { this._fwNew = { ...this._fwNew, [field]: e.target.value }; }} />
              <button class="primary" ?disabled=${!this._fwNew[field].trim()} @click=${() => this._addNamed(kind, field, singular)}>Añadir ${singular}</button>
            </div>`}
        ${items.length === 0
          ? html`<p class="empty">Aún no hay ${singular}s.</p>`
          : html`<div class="cities">${sorted.map((it, i) => this._renderNamedCard(kind, it, i, sorted.length))}</div>`}
      </details>
    `;
  }

  /**
   * @param {'tracks'|'disciplines'|'dimensions'} kind
   * @param {import('../tools/career/data/framework.js').NamedItem} it
   * @param {number} pos @param {number} total
   */
  _renderNamedCard(kind, it, pos, total) {
    return html`
      <div class="city">
        <div class="city-head">
          <span class="cid">${it.name || it.id} <span class="muted">(${it.id})</span></span>
          <span>
            ${this.readOnly
              ? null
              : html`
                  <button class="ord-btn" ?disabled=${pos === 0} title="Subir" @click=${() => this._moveFwItem(kind, it.id, -1)}>↑</button>
                  <button class="ord-btn" ?disabled=${pos === total - 1} title="Bajar" @click=${() => this._moveFwItem(kind, it.id, 1)}>↓</button>
                  ${this._isFwConfirm(kind, it.id)
                    ? html`<span class="confirm">¿Borrar?
                        <button class="yes" @click=${() => this._deleteFwItem(kind, it.id)}>Sí</button>
                        <button @click=${() => { this._fwConfirm = null; }}>No</button>
                      </span>`
                    : html`<button class="del-btn" @click=${() => { this._fwConfirm = { kind, id: it.id }; this._fwError = ''; }}>Borrar</button>`}
                `}
          </span>
        </div>
        <div class="fields">
          <label>Nombre
            <input type="text" .value=${it.name} ?disabled=${this.readOnly} @input=${(e) => this._patchFwItem(kind, it.id, { name: e.target.value })} />
          </label>
          <label class="full">Descripción
            <input type="text" .value=${it.description ?? ''} ?disabled=${this.readOnly} @input=${(e) => this._patchFwItem(kind, it.id, { description: e.target.value })} />
          </label>
        </div>
      </div>
    `;
  }

  /**
   * Sub-pestaña «Tracks y niveles»: los tracks son los itinerarios y cada uno
   * contiene sus niveles anidados. Realiza la relación track→niveles de forma
   * visual (antes eran dos listas planas separadas).
   * @param {import('../tools/career/data/framework.js').CareerFramework} fw
   */
  _renderFwTracksAndLevels(fw) {
    const tracks = [...fw.tracks].toSorted((a, b) => a.order - b.order);
    const byTrack = Object.groupBy(fw.levels, (l) => l.trackId ?? '');
    const orphans = fw.levels.filter((l) => !tracks.some((t) => t.id === l.trackId));
    return html`
      <p class="ro-note">Itinerarios de carrera de la organización (p. ej. Individual Contributor, Management). Cada track contiene sus niveles: expándelo para verlos o añadir uno nuevo.</p>
      ${this.readOnly
        ? null
        : html`<div class="toolbar">
            <input type="text" placeholder="Nombre del track" .value=${this._fwNew.track}
              @input=${(e) => { this._fwNew = { ...this._fwNew, track: e.target.value }; }} />
            <button class="primary" ?disabled=${!this._fwNew.track.trim()} @click=${() => this._addNamed('tracks', 'track', 'track')}>Añadir track</button>
          </div>`}
      ${tracks.length === 0
        ? html`<p class="empty">Aún no hay tracks.</p>`
        : tracks.map((t, i) => this._renderTrackGroup(fw, t, i, tracks.length, [...(byTrack[t.id] ?? [])].toSorted((a, b) => a.order - b.order)))}
      ${orphans.length
        ? html`<div class="city track-group" style="margin-top:0.9rem">
            <div class="city-head"><span class="cid">Niveles sin track <span class="muted">(${orphans.length})</span></span></div>
            <p class="ro-note">Estos niveles apuntan a un track que ya no existe. Reasígnalos con su selector de Track.</p>
            <div class="cities">${[...orphans].toSorted((a, b) => a.order - b.order).map((l, i, arr) => this._renderLevelCard(fw, l, i, arr.length))}</div>
          </div>`
        : null}
    `;
  }

  /**
   * Acciones de la cabecera de un track (reordenar y borrar). Extraído para no
   * anidar el ternario confirmar/borrar dentro del de readOnly (Sonar S3358).
   * @param {import('../tools/career/data/framework.js').NamedItem} t
   * @param {number} pos @param {number} total
   */
  _renderTrackActions(t, pos, total) {
    return html`
      <button class="ord-btn" ?disabled=${pos === 0} title="Subir" @click=${() => this._moveFwItem('tracks', t.id, -1)}>↑</button>
      <button class="ord-btn" ?disabled=${pos === total - 1} title="Bajar" @click=${() => this._moveFwItem('tracks', t.id, 1)}>↓</button>
      ${this._isFwConfirm('tracks', t.id)
        ? html`<span class="confirm">¿Borrar track?
            <button class="yes" @click=${() => this._deleteFwItem('tracks', t.id)}>Sí</button>
            <button @click=${() => { this._fwConfirm = null; }}>No</button>
          </span>`
        : html`<button class="del-btn" @click=${() => { this._fwConfirm = { kind: 'tracks', id: t.id }; this._fwError = ''; }}>Borrar</button>`}
    `;
  }

  /**
   * Un track como contenedor plegable (colapsado por defecto) con sus niveles
   * anidados dentro y un alta de nivel pre-asignada a ese track.
   * @param {import('../tools/career/data/framework.js').CareerFramework} fw
   * @param {import('../tools/career/data/framework.js').NamedItem} t
   * @param {number} pos @param {number} total
   * @param {Array<import('../tools/career/data/framework.js').Level>} levels niveles del track, ya ordenados
   */
  _renderTrackGroup(fw, t, pos, total, levels) {
    return html`
      <details class="city track-group">
        <summary class="city-head">
          <span class="cid">${t.name || t.id} <span class="muted">(${levels.length} nivel${levels.length === 1 ? '' : 'es'})</span></span>
          <span @click=${(e) => e.stopPropagation()}>
            ${this.readOnly ? null : this._renderTrackActions(t, pos, total)}
          </span>
        </summary>
        <div class="fields">
          <label>Nombre
            <input type="text" .value=${t.name} ?disabled=${this.readOnly} @input=${(e) => this._patchFwItem('tracks', t.id, { name: e.target.value })} />
          </label>
          <label class="full">Descripción
            <input type="text" .value=${t.description ?? ''} ?disabled=${this.readOnly} @input=${(e) => this._patchFwItem('tracks', t.id, { description: e.target.value })} />
          </label>
        </div>
        <div class="nested-levels">
          <div class="nested-head">
            <span class="sub">Niveles (${levels.length})</span>
            ${this.readOnly
              ? null
              : html`<div class="toolbar">
                  <input type="text" placeholder="Código (p. ej. L2)" .value=${this._fwNew.levelCode}
                    @input=${(e) => { this._fwNew = { ...this._fwNew, levelCode: e.target.value }; }} />
                  <input type="text" placeholder="Título (p. ej. Senior Engineer)" .value=${this._fwNew.levelTitle}
                    @input=${(e) => { this._fwNew = { ...this._fwNew, levelTitle: e.target.value }; }} />
                  <button class="primary" ?disabled=${!this._fwNew.levelCode.trim() || !this._fwNew.levelTitle.trim()} @click=${() => this._addLevel(t.id)}>Añadir nivel</button>
                </div>`}
          </div>
          ${levels.length === 0
            ? html`<p class="empty">Este track aún no tiene niveles.</p>`
            : html`<div class="cities">${levels.map((l, i) => this._renderLevelCard(fw, l, i, levels.length))}</div>`}
        </div>
      </details>
    `;
  }

  /**
   * @param {import('../tools/career/data/framework.js').CareerFramework} fw
   * @param {import('../tools/career/data/framework.js').Level} l
   * @param {number} pos @param {number} total
   */
  _renderLevelCard(fw, l, pos, total) {
    return html`
      <div class="city level">
        <div class="city-head">
          <span class="lvl-id">
            <span class="lvl-badge">${l.code || '—'}</span>
            <span class="lvl-title">${l.title || l.code || l.id}<span class="muted"> · ${l.id}</span></span>
          </span>
          <span>
            ${this.readOnly
              ? null
              : html`
                  <button class="ord-btn" ?disabled=${pos === 0} title="Subir" @click=${() => this._moveLevelInTrack(l.trackId, l.id, -1)}>↑</button>
                  <button class="ord-btn" ?disabled=${pos === total - 1} title="Bajar" @click=${() => this._moveLevelInTrack(l.trackId, l.id, 1)}>↓</button>
                  ${this._isFwConfirm('levels', l.id)
                    ? html`<span class="confirm">¿Borrar nivel?
                        <button class="yes" @click=${() => this._deleteFwItem('levels', l.id)}>Sí</button>
                        <button @click=${() => { this._fwConfirm = null; }}>No</button>
                      </span>`
                    : html`<button class="del-btn" @click=${() => { this._fwConfirm = { kind: 'levels', id: l.id }; this._fwError = ''; }}>Borrar</button>`}
                `}
          </span>
        </div>
        <div class="fields">
          <label>Código
            <input type="text" .value=${l.code} ?disabled=${this.readOnly} @input=${(e) => this._patchFwItem('levels', l.id, { code: e.target.value })} />
          </label>
          <label>Título
            <input type="text" .value=${l.title} ?disabled=${this.readOnly} @input=${(e) => this._patchFwItem('levels', l.id, { title: e.target.value })} />
          </label>
          <label>Track
            <select ?disabled=${this.readOnly} @change=${(e) => this._patchFwItem('levels', l.id, { trackId: e.target.value })}>
              ${fw.tracks.map((t) => html`<option value=${t.id} ?selected=${t.id === l.trackId}>${t.name}</option>`)}
            </select>
          </label>
          <label>Ramifica desde
            <select ?disabled=${this.readOnly} @change=${(e) => this._patchFwItem('levels', l.id, { branchesFrom: e.target.value || null })}>
              <option value="" ?selected=${!l.branchesFrom}>— ninguno —</option>
              ${fw.levels
                .filter((o) => o.id !== l.id)
                .map((o) => html`<option value=${o.id} ?selected=${o.id === l.branchesFrom}>${o.code || o.title} (${o.id})</option>`)}
            </select>
          </label>
          <label>Perfil típico
            <input type="text" .value=${l.typicalProfile ?? ''} ?disabled=${this.readOnly} @input=${(e) => this._patchFwItem('levels', l.id, { typicalProfile: e.target.value })} />
          </label>
          <label>Etiqueta pública (JD)
            <input type="text" placeholder="Junior / Mid / Senior…" .value=${l.publicLabel ?? ''} ?disabled=${this.readOnly} @input=${(e) => this._patchFwItem('levels', l.id, { publicLabel: e.target.value })} />
          </label>
          <label class="full">Descripción
            <input type="text" .value=${l.description ?? ''} ?disabled=${this.readOnly} @input=${(e) => this._patchFwItem('levels', l.id, { description: e.target.value })} />
          </label>
        </div>
      </div>
    `;
  }

  /**
   * Matriz de expectativas: se elige un nivel y se edita, para ese nivel, la
   * expectativa de cada dimensión (una fila = una celda Nivel × Dimensión).
   * Editar por-nivel evita pintar toda la matriz (48 celdas) a la vez.
   * @param {import('../tools/career/data/framework.js').CareerFramework} fw
   */
  _renderFwExpectations(fw) {
    const levels = [...fw.levels].toSorted((a, b) => a.order - b.order);
    const dims = [...fw.dimensions].toSorted((a, b) => a.order - b.order);
    const levelId = levels.some((l) => l.id === this._fwExpLevel) ? this._fwExpLevel : (levels[0]?.id ?? '');
    return html`
      <details>
        <summary class="sub">Matriz de expectativas (${fw.expectations.length})</summary>
        ${levels.length === 0 || dims.length === 0
          ? html`<p class="empty">Necesitas al menos un nivel y una dimensión para editar la matriz.</p>`
          : html`
              <div class="toolbar">
                <label class="matrix-pick">Nivel
                  <select ?disabled=${this.readOnly} @change=${(e) => { this._fwExpLevel = e.target.value; }}>
                    ${levels.map((l) => html`<option value=${l.id} ?selected=${l.id === levelId}>${l.code} · ${l.title}</option>`)}
                  </select>
                </label>
              </div>
              <div class="matrix">
                ${dims.map((d) => html`
                  <label class="matrix-row">
                    <span class="matrix-dim">${d.name}</span>
                    <textarea rows="2" placeholder="Qué se espera en esta dimensión para el nivel elegido…"
                      ?disabled=${this.readOnly}
                      .value=${this._expectationText(levelId, d.id)}
                      @input=${(e) => this._setExpectation(levelId, d.id, e.target.value)}></textarea>
                  </label>
                `)}
              </div>`}
      </details>
    `;
  }

  /**
   * Addendums por disciplina: se elige una disciplina y se edita, para esa
   * disciplina, el foco de cada dimensión (sección 10 del documento).
   * @param {import('../tools/career/data/framework.js').CareerFramework} fw
   */
  _renderFwAddendums(fw) {
    const disciplines = [...fw.disciplines].toSorted((a, b) => a.order - b.order);
    const dims = [...fw.dimensions].toSorted((a, b) => a.order - b.order);
    const disciplineId = disciplines.some((d) => d.id === this._fwAddDiscipline) ? this._fwAddDiscipline : (disciplines[0]?.id ?? '');
    return html`
      <details>
        <summary class="sub">Addendums por disciplina (${fw.addendums.length})</summary>
        ${disciplines.length === 0 || dims.length === 0
          ? html`<p class="empty">Necesitas al menos una disciplina y una dimensión para editar los addendums.</p>`
          : html`
              <div class="toolbar">
                <label class="matrix-pick">Disciplina
                  <select ?disabled=${this.readOnly} @change=${(e) => { this._fwAddDiscipline = e.target.value; }}>
                    ${disciplines.map((d) => html`<option value=${d.id} ?selected=${d.id === disciplineId}>${d.name}</option>`)}
                  </select>
                </label>
              </div>
              <div class="matrix">
                ${dims.map((dim) => html`
                  <label class="matrix-row">
                    <span class="matrix-dim">${dim.name}</span>
                    <textarea rows="2" placeholder="Foco de esta dimensión en la disciplina elegida…"
                      ?disabled=${this.readOnly}
                      .value=${this._addendumText(disciplineId, dim.id)}
                      @input=${(e) => this._setAddendum(disciplineId, dim.id, e.target.value)}></textarea>
                  </label>
                `)}
              </div>`}
      </details>
    `;
  }


  /** Nombrar superadmin por email desde la pestaña Usuarios (RMR-TSK-0230). */



  // ── Organigrama: catálogo de roles configurable (RMR-PCS-0027 · F2) ─────────

  async _loadOrgRoles() {
    // Independientes: un fallo cargando ramas NO debe impedir cargar los roles.
    try {
      this._orgRoles = await listOrgRoles();
    } catch (err) {
      this._orgError = err instanceof Error ? err.message : 'No se pudieron cargar los roles.';
    }
    try {
      this._orgBranches = await listOrgBranches();
    } catch (err) {
      this._branchError = 'No se pudieron cargar las ramas.';
    }
  }

  /** Etiqueta visible de una rama por su id (del catálogo, con fallback al id). */
  _branchLabel(id) {
    return this._orgBranches.find((b) => b.id === id)?.label ?? id;
  }

  /** Crea una rama nueva (id derivado del nombre). */
  async _createBranch() {
    this._branchError = '';
    const label = this._newBranchLabel.trim();
    if (!label) { this._branchError = 'El nombre de la rama es obligatorio.'; return; }
    const id = slugify(label);
    if (!id) { this._branchError = 'No se pudo derivar un identificador.'; return; }
    if (this._orgBranches.some((b) => b.id === id)) { this._branchError = `Ya existe una rama «${id}».`; return; }
    try {
      await saveOrgBranch(id, label);
      this._orgBranches = [...this._orgBranches, { id, label }];
      this._newBranchLabel = '';
    } catch (err) {
      this._branchError = 'No se pudo crear la rama.';
    }
  }

  /** Renombra una rama (el id no cambia, así los roles no se rompen). */
  async _renameBranch(id) {
    this._branchError = '';
    const label = this._editBranchLabel.trim();
    if (!label) { this._branchError = 'El nombre no puede quedar vacío.'; return; }
    try {
      await saveOrgBranch(id, label);
      // Upsert: si la rama venía de un rol pero no estaba en el catálogo (huérfana),
      // renombrarla la incorpora; si ya estaba, solo cambia la etiqueta.
      this._orgBranches = this._orgBranches.some((b) => b.id === id)
        ? this._orgBranches.map((b) => (b.id === id ? { ...b, label } : b))
        : [...this._orgBranches, { id, label }];
      this._editBranchId = null;
      this._editBranchLabel = '';
    } catch (err) {
      this._branchError = 'No se pudo renombrar la rama.';
    }
  }

  /** Borra una rama solo si ningún rol la usa. Re-lee los roles FRESCOS antes de
   *  comprobar el invariante, para no borrar por un estado obsoleto del cliente.
   *  Si aun así quedara un role.branch huérfano, _branchLabel cae al id (no rompe). */
  async _removeBranch(id) {
    this._branchError = '';
    try {
      const roles = await listOrgRoles();
      this._orgRoles = roles;
      if (roles.some((r) => r.branch === id)) {
        this._branchError = 'No se puede borrar: hay roles en esa rama. Cámbialos antes.';
        return;
      }
      await deleteOrgBranch(id);
      this._orgBranches = this._orgBranches.filter((b) => b.id !== id);
    } catch (err) {
      this._branchError = 'No se pudo borrar la rama.';
    }
  }

  /**
   * Celda «Capa» (RMR-TSK-0434): la capa canónica del rol en la pirámide.
   * «Auto» = profundidad de su cadena (comportamiento de siempre); fijarla
   * coloca al rol a esa altura aunque su cadena sea corta (Data: ingenieros en
   * la capa de ICs aunque reporten a un Head).
   */
  _renderRoleLayerCell(role, readOnly) {
    const effective = layerOf(this._orgRoles, role);
    if (readOnly) return html`<span class="muted">${role.layer ?? `auto (${effective})`}</span>`;
    return html`<select title="Capa canónica: 0 = base (dirección); Auto = según la cadena"
        @change=${(e) => this._setRoleLayer(role.id, e.target.value)}>
      <option value="" ?selected=${role.layer == null}>Auto (${effective})</option>
      ${[0, 1, 2, 3, 4, 5].map((n) => html`<option value=${n} ?selected=${role.layer === n}>${n}${n === 0 ? ' · base' : ''}</option>`)}
    </select>`;
  }

  /** Fija (o devuelve a auto) la capa canónica de un rol. */
  async _setRoleLayer(roleId, value) {
    this._orgError = '';
    this._orgNotice = '';
    const role = this._orgRoles.find((r) => r.id === roleId);
    if (!role) return;
    const layer = value === '' ? null : Number(value);
    const prev = role.layer ?? null;
    this._orgRoles = this._orgRoles.map((r) => (r.id === roleId ? { ...r, layer } : r));
    try {
      await saveOrgRole(roleId, { label: role.label, branch: role.branch, reportsToRoleId: role.reportsToRoleId ?? null, layer });
      this._orgNotice = layer == null ? `«${role.label}» vuelve a capa automática.` : `«${role.label}» fijado en la capa ${layer}.`;
    } catch (err) {
      this._orgRoles = this._orgRoles.map((r) => (r.id === roleId ? { ...r, layer: prev } : r));
      this._orgError = err instanceof Error ? err.message : 'No se pudo cambiar la capa del rol.';
    }
  }

  /**
   * Líneas de guía del árbol en la tabla de Roles (RMR-TSK-0439): un segmento
   * por nivel de profundidad — vertical para los ancestros (la cadena sigue más
   * abajo, porque la tabla va en post-orden: los hijos ENCIMA de su base) y, en
   * el nivel propio, la esquina si arranca la rama (primer hijo) o el injerto si
   * es un hermano posterior. CSS puro, sin librería: la tabla sigue siendo
   * editable, solo se lee como árbol.
   * @param {number} depth @param {boolean} firstChild
   */
  /** Filas del árbol con el tipo de guía ya resuelto por columna. */
  _orgRoleRowsWithGuides() {
    const rows = this._orgRoleRows();
    const kinds = treeGuideKinds(rows);
    return rows.map((row, i) => ({ ...row, guides: kinds[i] }));
  }

  /** Estilo de la celda del árbol: guías como fondo (ver `treeGuideBackground`). */
  _treeGuideStyle(kinds) {
    const { background, paddingLeft } = treeGuideBackground(kinds);
    return `background:${background};padding-left:${paddingLeft}`;
  }

  /** Reasigna el superior de un rol validando ciclos contra el catálogo actual. */
  async _setRoleParent(roleId, parentId) {
    this._orgError = '';
    this._orgNotice = '';
    try {
      assertValidReportsTo(this._orgRoles, roleId, parentId || null);
      await setOrgRoleReportsTo(roleId, parentId || null);
      this._orgRoles = this._orgRoles.map((r) => (r.id === roleId ? { ...r, reportsToRoleId: parentId || null } : r));
      this._orgNotice = 'Organigrama actualizado.';
    } catch (err) {
      this._orgError = err instanceof Error ? err.message : 'No se pudo mover el rol.';
    }
  }

  /** Cambia la RAMA de un rol existente (mueve el rol a otra área del organigrama).
   *  Conserva label y reportsToRoleId (saveOrgRole hace merge). */
  async _setRoleBranch(roleId, branchId) {
    this._orgError = '';
    this._orgNotice = '';
    if (branchId === '__new__') { this._branchDraft = { for: roleId, label: '' }; return; }
    const role = this._orgRoles.find((r) => r.id === roleId);
    if (!role || !branchId || role.branch === branchId) return;
    const prevBranch = role.branch;
    this._orgRoles = this._orgRoles.map((r) => (r.id === roleId ? { ...r, branch: branchId } : r));
    try {
      await saveOrgRole(roleId, { label: role.label, branch: branchId, reportsToRoleId: role.reportsToRoleId ?? null, layer: role.layer ?? null });
      this._orgNotice = `«${role.label}» movido a ${this._branchLabel(branchId)}.`;
    } catch (err) {
      this._orgRoles = this._orgRoles.map((r) => (r.id === roleId ? { ...r, branch: prevBranch } : r));
      this._orgError = err instanceof Error ? err.message : 'No se pudo cambiar la rama del rol.';
    }
  }

  /** Renombra un rol (el id no cambia, así ni la jerarquía ni las personas que lo
   *  referencian se rompen — mismo patrón que renombrar ramas). */
  async _renameRole(roleId) {
    this._orgError = '';
    this._orgNotice = '';
    const role = this._orgRoles.find((r) => r.id === roleId);
    const label = this._editRoleLabel.trim();
    if (!role) return;
    if (!label) { this._orgError = 'El nombre no puede quedar vacío.'; return; }
    try {
      await saveOrgRole(roleId, { label, branch: role.branch, reportsToRoleId: role.reportsToRoleId ?? null, layer: role.layer ?? null });
      this._orgRoles = this._orgRoles.map((r) => (r.id === roleId ? { ...r, label } : r));
      this._editRoleId = null;
      this._editRoleLabel = '';
      this._orgNotice = `Rol renombrado a «${label}».`;
    } catch (err) {
      this._orgError = err instanceof Error ? err.message : 'No se pudo renombrar el rol.';
    }
  }

  /** Crea una rama nueva desde el select de rol y la asigna en el sitio (al rol o
   *  al form de «Nuevo rol»). Si el id ya existe, la reutiliza. */
  async _createBranchInline() {
    const draft = this._branchDraft;
    if (!draft) return;
    const label = draft.label.trim();
    if (!label) { this._orgError = 'El nombre de la rama es obligatorio.'; return; }
    const id = slugify(label);
    if (!id) { this._orgError = 'No se pudo derivar un identificador de rama.'; return; }
    try {
      if (!this._orgBranches.some((b) => b.id === id)) {
        await saveOrgBranch(id, label);
        this._orgBranches = [...this._orgBranches, { id, label }];
      }
      if (draft.for === '__form__') {
        this._orgForm = { ...this._orgForm, branch: id };
      } else {
        await this._setRoleBranch(draft.for, id);
      }
      this._branchDraft = null;
      this._orgNotice = `Rama «${label}» creada.`;
    } catch (err) {
      this._orgError = err instanceof Error ? err.message : 'No se pudo crear la rama.';
    }
  }

  /** Id de un rol nuevo a partir de su nombre: el slug tal cual si está libre; si
   *  choca, sufijado con la RAMA elegida (engineer → engineer-data) por legibilidad;
   *  y si también choca (o la rama ya viene en el nombre), -2, -3… */
  _deriveRoleId(label, taken) {
    const base = slugify(label);
    if (!base) return '';
    if (!taken.has(base)) return base;
    const branch = this._orgForm.branch;
    // Si la rama ya contiene el nombre (rama «engineer-data» para «Engineer»), el
    // id es directamente la rama — evita el duplicado «engineer-engineer-data».
    const withBranch = branch === base || branch?.startsWith(`${base}-`) ? branch : `${base}-${branch}`;
    if (branch && !base.endsWith(`-${branch}`) && !taken.has(withBranch)) return withBranch;
    return uniqueId(base, taken);
  }

  async _createRole() {
    this._orgError = '';
    this._orgNotice = '';
    const label = this._orgForm.label.trim();
    if (!label) { this._orgError = 'El nombre del rol es obligatorio.'; return; }
    const explicitId = this._orgForm.id.trim();
    const taken = new Set(this._orgRoles.map((r) => r.id));
    // Mismo NOMBRE en dos ramas es legítimo (Engineer en Engineering y en Data): si
    // el id derivado del nombre choca, se sufija primero con LA RAMA elegida
    // (engineer → engineer-data), que es legible; y solo si también choca, -2, -3…
    // Solo es error si el usuario tecleó un id explícito que ya existe.
    const id = explicitId || this._deriveRoleId(label, taken);
    if (!id) { this._orgError = 'No se pudo derivar un identificador del nombre.'; return; }
    if (explicitId && taken.has(explicitId)) { this._orgError = `Ya existe un rol con id «${explicitId}».`; return; }
    const parent = this._orgForm.reportsToRoleId || null;
    try {
      if (parent) assertValidReportsTo([...this._orgRoles, { id, label, branch: this._orgForm.branch, reportsToRoleId: null }], id, parent);
      await saveOrgRole(id, { label, branch: this._orgForm.branch, reportsToRoleId: parent });
      this._orgRoles = [...this._orgRoles, { id, label, branch: this._orgForm.branch, reportsToRoleId: parent }];
      this._orgForm = { id: '', label: '', branch: this._orgForm.branch, reportsToRoleId: '' };
      this._orgNotice = `Rol «${label}» creado.`;
    } catch (err) {
      this._orgError = err instanceof Error ? err.message : 'No se pudo crear el rol.';
    }
  }

  async _removeRole(id) {
    this._orgError = '';
    this._orgNotice = '';
    const children = childrenOf(this._orgRoles, id);
    if (children.length) {
      this._orgError = `No se puede borrar: ${children.length} rol(es) dependen de él. Reasígnalos antes.`;
      this._orgConfirmDelete = null;
      return;
    }
    try {
      await deleteOrgRole(id);
      this._orgRoles = this._orgRoles.filter((r) => r.id !== id);
      this._orgConfirmDelete = null;
      this._orgNotice = 'Rol borrado.';
    } catch (err) {
      this._orgError = err instanceof Error ? err.message : 'No se pudo borrar el rol.';
    }
  }

  /**
   * Filas del editor de roles ORDENADAS POR DEPENDENCIAS: cada árbol contiguo en
   * post-orden (hojas arriba, cada rol encima de su «depende de», la base al final
   * del bloque — pirámide invertida). La rama es un dato de la fila, no el criterio
   * de agrupación: una cadena que cruza de rama (head-eng→CPO) se mantiene junta.
   */
  _orgRoleRows() {
    return orgRoleRows(this._orgRoles);
  }

  /** Cambia de subtab del organigrama RE-LEYENDO de Firestore: así Roles/Ramas/Vista
   *  siempre reflejan el estado real aunque otra pestaña (u otro deploy) haya
   *  cambiado datos — sin necesidad de recargar la página. */
  _openOrgSubtab(sub) {
    this._orgSubtab = sub;
    this._loadOrgRoles();
  }

  _renderOrgRoles() {
    const sub = this._orgSubtab;
    return html`
      <section>
        <div class="subtabs">
          <button class="subtab ${sub === 'editor' ? 'active' : ''}" @click=${() => this._openOrgSubtab('editor')}>Roles</button>
          <button class="subtab ${sub === 'ramas' ? 'active' : ''}" @click=${() => this._openOrgSubtab('ramas')}>Ramas</button>
          <button class="subtab ${sub === 'vista' ? 'active' : ''}" @click=${() => this._openOrgSubtab('vista')}>Vista (pirámide invertida)</button>
        </div>
        ${sub === 'vista' ? this._renderOrgPyramid() : sub === 'ramas' ? this._renderOrgBranches() : this._renderOrgEditor()}
      </section>
    `;
  }

  _renderOrgEditor() {
    const ro = this.readOnly;
    const parentOptions = (roleId) => this._orgRoles
      .filter((r) => r.id !== roleId)
      .map((r) => html`<option value=${r.id}>${r.label}</option>`);
    return html`
      <div>
        <h2>Organigrama — roles y jerarquía</h2>
        <p class="ro-note">Cada rol tiene una <strong>Rama</strong> (el área donde se agrupa y colorea) y un <strong>«Depende de»</strong> (quién está por encima en la jerarquía). Son independientes: cambia la <strong>Rama</strong> para mover el rol a otra área, y <strong>«Depende de»</strong> para cambiar su línea de reporte (se impide crear ciclos). Un rol <strong>«sin inferior»</strong> es la <strong>base</strong> de su rama: <strong>al que nadie sostiene</strong> porque él sostiene a todos (liderazgo afectivo); en la pirámide invertida se dibuja en la punta de abajo, no arriba.</p>
        ${this._orgError ? html`<p class="error">${this._orgError}</p>` : null}
        ${this._orgNotice ? html`<p class="notice">${this._orgNotice}</p>` : null}
        ${this._orgRoles.length === 0
          ? html`<p class="empty">Aún no hay roles. Créalos abajo o ejecuta el seed inicial.</p>`
          : html`<div class="table-wrap"><table class="org-roles">
              <thead><tr><th>Rol</th><th>Rama</th><th>Depende de</th><th title="Capa canónica de la pirámide (RMR-TSK-0434)">Capa</th>${ro ? '' : html`<th></th>`}</tr></thead>
              <tbody>
                ${repeat(this._orgRoleRowsWithGuides(), ({ role }) => role.id, ({ role, firstOfTree, guides }) => html`<tr class=${firstOfTree ? 'branch-start' : ''}>
                  <td class="tree-cell" style=${this._treeGuideStyle(guides)}>${this._renderRoleName(role)}</td>
                  <td>${this._renderRoleBranchCell(role)}</td>
                  <td>${ro
                    ? (this._orgRoles.find((r) => r.id === role.reportsToRoleId)?.label ?? html`<span class="muted">— sin inferior (base) —</span>`)
                    : html`<select data-parent-for=${role.id} @change=${(e) => this._setRoleParent(role.id, e.target.value)}>
                        <option value="">— sin inferior (base) —</option>
                        ${this._orgRoles.filter((r) => r.id !== role.id).map((r) => html`<option value=${r.id}>${r.label}</option>`)}
                      </select>`}</td>
                  <td>${this._renderRoleLayerCell(role, ro)}</td>
                  ${ro ? '' : html`<td>${this._orgConfirmDelete === role.id
                    ? html`<span class="confirm">¿Borrar? <button @click=${() => this._removeRole(role.id)}>Sí</button> <button @click=${() => { this._orgConfirmDelete = null; }}>No</button></span>`
                    : html`<button class="del-btn" @click=${() => { this._orgConfirmDelete = role.id; }}>Borrar</button>`}</td>`}
                </tr>`)}
              </tbody>
            </table></div>`}
        ${ro ? null : html`
          <h3 class="sub">Nuevo rol</h3>
          <div class="toolbar">
            <input placeholder="Nombre (p.ej. Staff Engineer)" .value=${this._orgForm.label}
              @input=${(e) => { this._orgForm = { ...this._orgForm, label: e.target.value }; }}>
            <select data-branch-form @change=${(e) => { const v = e.target.value; if (v === '__new__') { this._branchDraft = { for: '__form__', label: '' }; } else { this._orgForm = { ...this._orgForm, branch: v }; } }}>
              ${this._orgBranches.map((b) => html`<option value=${b.id}>${b.label}</option>`)}
              <option value="__new__">➕ Nueva rama…</option>
            </select>
            <select .value=${this._orgForm.reportsToRoleId} @change=${(e) => { this._orgForm = { ...this._orgForm, reportsToRoleId: e.target.value }; }}>
              <option value="">— sin inferior (base) —</option>
              ${parentOptions('')}
            </select>
            <button class="primary" @click=${() => this._createRole()}>Crear rol</button>
          </div>
          ${this._branchDraft?.for === '__form__' ? this._renderBranchDraft() : null}`}
      </div>`;
  }

  /** Nombre del rol en su fila: texto con lápiz de renombrado inline (Enter guarda,
   *  Esc cancela). En solo-lectura, solo el texto. El id nunca cambia. */
  _renderRoleName(role) {
    if (this._editRoleId === role.id) {
      return html`<input class="role-rename" .value=${this._editRoleLabel}
          @input=${(e) => { this._editRoleLabel = e.target.value; }}
          @keydown=${(e) => { if (e.key === 'Enter') this._renameRole(role.id); else if (e.key === 'Escape') { this._editRoleId = null; } }}>
        <button type="button" class="ord-btn" @click=${() => this._renameRole(role.id)}>Guardar</button>
        <button type="button" class="ord-btn" @click=${() => { this._editRoleId = null; }}>✕</button>`;
    }
    const pencil = this.readOnly
      ? null
      : html` <button type="button" class="rename-btn" title="Renombrar" aria-label="Renombrar ${role.label}"
          @click=${() => { this._editRoleId = role.id; this._editRoleLabel = role.label; }}>✎</button>`;
    return html`${role.label} <span class="muted">(${role.id})</span>${pencil}`;
  }

  /** Celda «Rama» de una fila del editor: badge en solo-lectura; si no, un select
   *  (con «➕ Nueva rama…») y el input inline de creación cuando toca. Extraído para
   *  no anidar el ternario del draft dentro del ternario ro?:  (S3358). */
  _renderRoleBranchCell(role) {
    if (this.readOnly) {
      return html`<span class="badge" style="background:var(--rm-accent,#3b82f6)">${this._branchLabel(role.branch)}</span>`;
    }
    const draft = this._branchDraft?.for === role.id ? this._renderBranchDraft() : null;
    return html`<select data-branch-for=${role.id} @change=${(e) => this._setRoleBranch(role.id, e.target.value)}>
        ${this._orgBranches.map((b) => html`<option value=${b.id}>${b.label}</option>`)}
        <option value="__new__">➕ Nueva rama…</option>
      </select>${draft}`;
  }

  /** Input inline para crear una rama nueva desde el select de un rol / del form. */
  _renderBranchDraft() {
    return html`<span class="branch-draft">
      <input placeholder="Nombre de la rama (p.ej. Directiva)" .value=${this._branchDraft.label}
        @input=${(e) => { this._branchDraft = { ...this._branchDraft, label: e.target.value }; }}
        @keydown=${(e) => { if (e.key === 'Enter') this._createBranchInline(); else if (e.key === 'Escape') { this._branchDraft = null; } }}>
      <button type="button" class="primary" @click=${() => this._createBranchInline()}>Crear rama</button>
      <button type="button" @click=${() => { this._branchDraft = null; }}>Cancelar</button>
    </span>`;
  }

  /** Vista de organigrama en pirámide invertida: LA MISMA vista que /organigrama
   *  (<org-chart>, RMR-BUG-0092). Antes el panel tenía una copia propia dibujada
   *  por profundidad de cadena: ignoraba las capas canónicas y no se actualizaba
   *  en vivo — dos dibujos distintos de los mismos datos. Un solo componente,
   *  una sola fuente (onSnapshot de /orgRoles y /orgBranches). */
  _renderOrgPyramid() {
    return html`<org-chart></org-chart>`;
  }

  /** Editor de RAMAS: REFLEJO de las ramas que existen (catálogo ∪ las presentes en
   *  algún rol, aunque falten en el catálogo — p.ej. creadas desde Roles). Aquí se
   *  renombran y borran; crear se puede aquí o desde los selects de Roles. */
  _renderOrgBranches() {
    const ro = this.readOnly;
    const catalogIds = new Set(this._orgBranches.map((b) => b.id));
    const orphanIds = [...new Set(this._orgRoles.map((r) => r.branch))].filter((id) => id && !catalogIds.has(id));
    const rows = [...this._orgBranches, ...orphanIds.map((id) => ({ id, label: id }))];
    return html`
      <div>
        <h2>Ramas de la organización</h2>
        <p class="ro-note">Reflejo de las ramas en uso: las del catálogo y cualquier otra presente en algún rol (aunque se creara desde la pestaña Roles). Puedes <strong>renombrarlas</strong> sin romper los roles (p.ej. «People» → «People & Operaciones») y <strong>borrar</strong> las que ningún rol use.</p>
        ${this._branchError ? html`<p class="error">${this._branchError}</p>` : null}
        ${rows.length === 0
          ? html`<p class="empty">Aún no hay ramas. Créalas abajo o ejecuta el seed.</p>`
          : html`<div class="table-wrap"><table>
              <thead><tr><th>Rama</th><th>Id</th><th>Roles</th>${ro ? '' : html`<th></th>`}</tr></thead>
              <tbody>
                ${rows.map((b) => {
                  const count = this._orgRoles.filter((r) => r.branch === b.id).length;
                  return html`<tr>
                    <td>${this._editBranchId === b.id
                      ? html`<input .value=${this._editBranchLabel} @input=${(e) => { this._editBranchLabel = e.target.value; }}
                          @keydown=${(e) => { if (e.key === 'Enter') this._renameBranch(b.id); }} />`
                      : html`<span class="pyr-dot" style="display:inline-block;background:${branchColor(b.id)}"></span> ${b.label}`}</td>
                    <td class="muted">${b.id}</td>
                    <td class="muted">${count}</td>
                    ${ro ? '' : html`<td>${this._editBranchId === b.id
                      ? html`<button class="ord-btn" @click=${() => this._renameBranch(b.id)}>Guardar</button> <button class="ord-btn" @click=${() => { this._editBranchId = null; }}>✕</button>`
                      : html`<button class="ord-btn" @click=${() => { this._editBranchId = b.id; this._editBranchLabel = b.label; }}>Renombrar</button> <button class="del-btn" @click=${() => this._removeBranch(b.id)}>Borrar</button>`}</td>`}
                  </tr>`;
                })}
              </tbody>
            </table></div>`}
        ${ro ? null : html`
          <h3 class="sub">Nueva rama</h3>
          <div class="toolbar">
            <input placeholder="Nombre (p.ej. Operaciones)" .value=${this._newBranchLabel}
              @input=${(e) => { this._newBranchLabel = e.target.value; }}
              @keydown=${(e) => { if (e.key === 'Enter') this._createBranch(); }} />
            <button class="primary" @click=${() => this._createBranch()}>Crear rama</button>
          </div>`}
      </div>`;
  }

  // ── Herramientas: permisos de acceso/gestión (RMR-PCS-0027 · F3) ───────────

  async _loadToolPolicies() {
    try {
      const loaded = await listToolPolicies();
      // Si aún no se han sembrado, muestra el catálogo por defecto (solo lectura
      // hasta que se guarde algo, que ya persiste).
      this._toolPolicies = loaded.length ? loaded : TOOLS.map((t) => ({ ...t }));
    } catch (err) {
      this._toolError = err instanceof Error ? err.message : 'No se pudieron cargar las herramientas.';
    }
  }

  /** Aplica un cambio a un grant (audience|managedBy) de una herramienta y persiste. */
  async _updateToolGrant(toolId, kind, mutate) {
    this._toolError = '';
    this._toolNotice = '';
    const policy = this._toolPolicies.find((p) => p.toolId === toolId);
    if (!policy) return;
    const prevGrant = policy[kind] ?? {};
    const nextGrant = mutate({ ...prevGrant });
    const nextPolicy = { ...policy, [kind]: nextGrant };
    // Optimista, pero el rollback es QUIRÚRGICO: si la escritura falla, solo
    // revierte ESTE grant y solo si nadie lo cambió después (comparando la
    // referencia del objeto), para no pisar un cambio posterior que sí guardó.
    this._toolPolicies = this._toolPolicies.map((p) => (p.toolId === toolId ? nextPolicy : p));
    try {
      await saveToolPolicy(toolId, { label: policy.label, [kind]: nextGrant });
      this._toolNotice = 'Guardado.';
    } catch (err) {
      this._toolPolicies = this._toolPolicies.map((p) => {
        if (p.toolId !== toolId || p[kind] !== nextGrant) return p;
        return { ...p, [kind]: prevGrant };
      });
      this._toolError = err instanceof Error ? err.message : 'No se pudo guardar. Cambio revertido.';
    }
  }

  /** Añade o quita un valor de un array de un grant (branches / roleIds). */
  _toggleGrantList(grant, key, value) {
    const list = grant[key] ?? [];
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    return { ...grant, [key]: next };
  }

  /** Editor de un grant (audience o managedBy): everyone + ramas + roles. */
  _renderGrantEditor(toolId, kind, grant, allowEveryone) {
    const ro = this.readOnly;
    // Ramas del CATÁLOGO real (/orgBranches) — incluye las creadas por el
    // superadmin (RMR-BUG-0077: antes referenciaba una constante inexistente y
    // el ReferenceError abortaba el render de toda la lista de herramientas).
    const branches = this._orgBranches;
    const roles = this._orgRoles;
    const everyone = Boolean(grant.everyone);
    return html`
      <div class="grant">
        ${allowEveryone ? html`<label class="chk"><input type="checkbox" .checked=${everyone} ?disabled=${ro}
          @change=${(e) => this._updateToolGrant(toolId, kind, (g) => ({ ...g, everyone: e.target.checked }))}>
          <strong>Todos los empleados</strong></label>` : null}
        <div class="grant-cols ${everyone ? 'dim' : ''}">
          <div>
            <span class="grant-h">Ramas</span>
            ${branches.length === 0 ? html`<span class="muted">— sin ramas —</span>` : branches.map((b) => html`<label class="chk"><input type="checkbox" ?disabled=${ro}
              .checked=${(grant.branches ?? []).includes(b.id)}
              @change=${() => this._updateToolGrant(toolId, kind, (g) => this._toggleGrantList(g, 'branches', b.id))}>${b.label}</label>`)}
          </div>
          <div>
            <span class="grant-h">Roles</span>
            ${roles.length === 0 ? html`<span class="muted">— sin roles —</span>` : roles.map((r) => html`<label class="chk"><input type="checkbox" ?disabled=${ro}
              .checked=${(grant.roleIds ?? []).includes(r.id)}
              @change=${() => this._updateToolGrant(toolId, kind, (g) => this._toggleGrantList(g, 'roleIds', r.id))}>${r.label}</label>`)}
          </div>
        </div>
      </div>`;
  }

  // ── Permisos por persona (RMR-TSK-0461) ────────────────────────────────────

  /**
   * Aquí se elige a quién, y la matriz la pinta <person-permissions> — el mismo
   * componente que sale en la ficha de la persona. Dos puertas al mismo sitio:
   * quien administra busca «Permisos», y quien está viendo a alguien los quiere
   * ahí mismo (RMR-TSK-0460).
   */
  /**
   * Permisos, con los dos ámbitos por los que se puede llegar: la política de
   * una herramienta (por rol y rama) y la excepción de una persona. Antes eran
   * dos pestañas lejanas —«Herramientas» y «Permisos»— y había que saberse cuál
   * era cuál; quien busca permisos entra por «Permisos» y elige el ámbito.
   */
  _renderPermisos() {
    const sub = this._permSub === 'persona' ? 'persona' : 'rol';
    const subs = [['rol', 'Por rol y rama'], ['persona', 'Por persona']];
    return html`
      <div class="csubtabs" role="tablist" aria-label="Ámbito de los permisos">
        ${subs.map(([id, label]) => html`<button
          role="tab"
          aria-selected=${sub === id}
          class="csubtab ${sub === id ? 'on' : ''}"
          @click=${() => { this._permSub = id; }}
        >${label}</button>`)}
      </div>
      <div role="tabpanel">
        ${sub === 'persona' ? this._renderPermisosPersona() : this._renderToolPolicies()}
      </div>`;
  }

  _renderPermisosPersona() {
    const persona = this._peopleList.find((p) => p.id === this._permPersonId) ?? null;
    const activas = this._peopleList.filter((p) => p.active !== false);
    return html`
      <section>
        <h2>Permisos por persona</h2>
        <div class="toolbar">
          <label>Persona
            <select @change=${(e) => { this._permPersonId = e.target.value; }}>
              <option value="">— elige a quién —</option>
              ${activas.map((p) => html`<option value=${p.id} ?selected=${p.id === this._permPersonId}>${p.name}</option>`)}
            </select>
          </label>
        </div>
        <person-permissions
          .person=${persona}
          .policies=${this._toolPolicies}
          ?read-only=${this.readOnly}
          .save=${(personId, toolOverrides) => this._savePersonPerms(personId, toolOverrides)}
        ></person-permissions>
      </section>`;
  }

  /** Persiste las excepciones y deja al día la lista que ya tiene el panel. */
  async _savePersonPerms(personId, toolOverrides) {
    await this.persistence.people.update(personId, { toolOverrides });
    this._peopleList = this._peopleList.map((p) => (p.id === personId ? { ...p, toolOverrides } : p));
  }

  _renderToolPolicies() {
    const ro = this.readOnly;
    return html`
      <section>
        <h2>Herramientas — quién las ve y quién las gestiona</h2>
        <p class="ro-note">El superadmin ve y gestiona TODAS las herramientas siempre. Aquí defines quién más: «Ve/usa» (audiencia) y «Gestiona» (delegación). Las reglas se suman: si cualquiera aplica, hay acceso.</p>
        ${this._toolError ? html`<p class="error">${this._toolError}</p>` : null}
        ${this._toolNotice ? html`<p class="notice">${this._toolNotice}</p>` : null}
        ${ro ? html`<p class="ro-note">Solo lectura.</p>` : null}
        ${this._toolPolicies.map((p) => html`
          <details class="tool">
            <summary><strong>${p.label ?? p.toolId}</strong> <span class="muted">(${p.toolId})</span></summary>
            <div class="tool-body">
              <div class="tool-grant">
                <span class="grant-title">Ve / usa</span>
                ${this._renderGrantEditor(p.toolId, 'audience', p.audience ?? {}, true)}
              </div>
              <div class="tool-grant">
                <span class="grant-title">Gestiona <span class="muted">(además del superadmin)</span></span>
                ${this._renderGrantEditor(p.toolId, 'managedBy', p.managedBy ?? {}, false)}
              </div>
            </div>
          </details>`)}
      </section>`;
  }


  _renderUsers() {
    // Defensa en profundidad: un viewer nunca gestiona usuarios.
    if (this.readOnly) return null;
    // UNA sola gestión de personas (RMR-PCS-0027 · F8e): aquí creas, editas rol,
    // superior y acceso, y das de baja — sin duplicar con «Managers» ni con una
    // pestaña de «cuentas» separada.
    return html`
      <section>
        <h2>Personas (${this._peopleList.length})</h2>
        <p class="ro-note">
          Todas las personas de la organización, <strong>tengan cuenta o no</strong>. Aquí las creas, les cambias el <strong>rol</strong>, el <strong>superior</strong> y el <strong>acceso</strong> (superadmin / viewer / People), y las das de baja. Los permisos de herramientas y el detalle se editan en su ficha (herramienta de Equipo). El email es el de su cuenta vinculada o el de la invitación.
        </p>
        <div class="toolbar">
          <input type="text" placeholder="Nombre" .value=${this._newPersonName} @input=${(e) => { this._newPersonName = e.target.value; }} />
          <input type="email" placeholder="email (opcional, para invitar)" .value=${this._newPersonEmail} @input=${(e) => { this._newPersonEmail = e.target.value; }} />
          <select @change=${(e) => { this._newPersonRole = e.target.value; }}>
            ${this._orgRoles.map((r) => html`<option value=${r.id} ?selected=${this._newPersonRole === r.id}>${r.label}</option>`)}
          </select>
          <button class="primary" ?disabled=${!this._newPersonName.trim()} @click=${() => this._addPersonPanel()}>Añadir persona</button>
        </div>
        ${this._renderUsersPeople()}
      </section>
      ${this._renderAssignModal()}
    `;
  }

  /**
   * Select de superior filtrado por el ORGANIGRAMA DE ROLES (RMR-TSK-0361):
   * candidatos = personas cuyo rol es el rol superior del de esta persona
   * (manager→heads, engineer→managers…). El superior ACTUAL siempre se pinta
   * aunque ya no case con el filtro (no se oculta un dato guardado); rol cima →
   * solo «no reporta a nadie»; rol superior sin personas → aviso honesto.
   * @param {{ id: string, orgRole?: string|null, reportsToPersonId?: string|null }} p
   * @param {(id: string|null|undefined) => string} nameOf
   */
  _renderSuperiorSelect(p, nameOf) {
    const { candidates, superiorRole } = superiorCandidatesFor(p, this._peopleList, this._orgRoles);
    const current = p.reportsToPersonId ?? null;
    const options = current && !candidates.some((c) => c.id === current)
      ? [...candidates, ...this._peopleList.filter((o) => o.id === current && o.id !== p.id)]
      : candidates;
    return html`
      <select aria-label="Superior de ${p.name ?? 'la persona'}"
        @change=${(e) => this._setPersonSuperior(p.id, e.target.value)} title=${nameOf(current)}>
        <option value="" ?selected=${!current}>— no reporta a nadie —</option>
        ${superiorRole && candidates.length === 0
          ? html`<option value="" disabled>(aún no hay nadie con rol ${superiorRole.label})</option>`
          : null}
        ${options.map((o) => html`<option value=${o.id} ?selected=${current === o.id}>${o.name}</option>`)}
      </select>
    `;
  }

  /** Tabla de personas: rol, superior, acceso (si tiene cuenta) y baja. */
  _renderUsersPeople() {
    const nameOf = (id) => this._peopleList.find((x) => x.id === id)?.name ?? '—';
    // Si la lista está vacía POR UN ERROR, el aviso de arriba ya lo cuenta: no se
    // repite con el «aún no hay personas». Sale a una constante para no colgar
    // un segundo ternario de la rama «?» (RMR-TSK-0450).
    const sinPersonas = this._peopleError
      ? null
      : html`<p class="empty">Aún no hay personas dadas de alta.</p>`;
    return html`
      ${this._peopleError ? html`<p class="error">${this._peopleError}</p>` : null}
      ${this._peopleNotice ? html`<p class="notice">${this._peopleNotice}</p>` : null}
      ${this._peopleList.length === 0
        ? sinPersonas
        : html`<div class="table-wrap"><table class="people">
            <thead><tr><th>Nombre</th><th>Email y cuenta</th><th>Rol y rama</th><th>Reporta a</th><th>Acceso</th></tr></thead>
            <tbody>
              ${this._peopleList.map((p) => {
                let account;
                if (p.uid) account = html`<span class="acct" style="color:var(--rm-accent,#2a9d8f)">✓ Cuenta vinculada</span>`;
                else if (p.pendingEmail) account = html`<span class="acct muted">Invitación pendiente</span>`;
                else account = html`<span class="acct muted">Sin cuenta</span>`;
                return html`<tr>
                  <td class="wrap">${this._renderPersonNameCell(p)}</td>
                  <td class="wrap">${this._renderPersonEmailCell(p)}${account}</td>
                  <td class="stack">
                    <select aria-label="Rol de ${p.name ?? 'la persona'}" @change=${(e) => this._setPersonRole(p.id, e.target.value)}>
                      <option value="" disabled ?selected=${!this._orgRoles.some((r) => r.id === p.orgRole)}>— sin rol —</option>
                      ${this._orgRoles.map((r) => html`<option value=${r.id} ?selected=${p.orgRole === r.id}>${r.label}</option>`)}
                    </select>
                    <select aria-label="Rama de ${p.name ?? 'la persona'}" @change=${(e) => this._setPersonBranch(p.id, e.target.value)}>
                      <option value="" ?selected=${!this._orgBranches.some((b) => b.id === p.orgBranch)}>— sin rama —</option>
                      ${this._orgBranches.map((b) => html`<option value=${b.id} ?selected=${p.orgBranch === b.id}>${b.label}</option>`)}
                    </select>
                  </td>
                  <td>${this._renderSuperiorSelect(p, nameOf)}</td>
                  <td class="stack">
                    ${this._renderPersonAccess(p)}
                    ${this._confirmDeletePerson === p.id
                      ? html`<span class="confirm">¿Dar de baja? <button class="yes" @click=${() => this._removePerson(p.id)}>Sí</button> <button @click=${() => { this._confirmDeletePerson = null; }}>No</button></span>`
                      : html`<button class="del-btn" @click=${() => { this._confirmDeletePerson = p.id; }}>Baja</button>`}
                  </td>
                </tr>`;
              })}
              ${this._orphanAccounts().map((u) => this._renderOrphanRow(u))}
            </tbody>
          </table></div>`}
    `;
  }










  _renderAssignModal() {
    const user = this._assignFor;
    const who = user ? (user.displayName ?? user.email ?? user.uid) : '';
    const heading = user ? `Asignar a equipo · ${who}` : 'Asignar a equipo';
    return html`
      <app-modal .open=${!!user} heading=${heading} @close=${() => this._closeAssign()}>
        ${user
          ? html`
              <div class="assign-body">
                <p class="ro-note">
                  Se creará una persona vinculada a esta cuenta en el equipo del manager elegido. La
                  cuenta podrá ver su propia ficha en solo lectura.
                </p>
                <label class="assign-field">Manager
                  <select .value=${this._assignLeader} @change=${(e) => { this._assignLeader = e.target.value; }}>
                    <option value="">— Elige un manager —</option>
                    ${this.leaders.map((l) => html`<option value=${l.uid}>${l.displayName ?? l.email ?? l.uid}</option>`)}
                  </select>
                </label>
                ${this._usersError ? html`<p class="error">${this._usersError}</p>` : null}
                <div class="assign-actions">
                  <button type="button" @click=${() => this._closeAssign()}>Cancelar</button>
                  <button class="primary" type="button" ?disabled=${!this._assignLeader} @click=${() => this._assign()}>Asignar</button>
                </div>
              </div>
            `
          : null}
      </app-modal>
    `;
  }
}

if (!customElements.get('superadmin-panel')) {
  customElements.define('superadmin-panel', SuperadminPanel);
}
