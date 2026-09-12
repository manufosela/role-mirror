/**
 * Glue de la home (modelo multi-leader): con sesión y acceso (superadmin o manager)
 * muestra las tarjetas de herramientas; sin acceso, la landing pública de
 * presentación. Por defecto el HTML muestra la landing y oculta las tools.
 */
import { onUserChanged } from '../lib/auth.js';
import { resolveAccess } from '../lib/access.js';
import { canGovern, hubAsView, leadsTeam } from '../lib/accessRoles.js';
import { isSurveyAdmin } from '../lib/survey.js';
import { getMyPerson, ensureEmployeePerson } from '../lib/engineer.js';
import { listToolPolicies } from '../lib/toolPolicies.js';
import { canUseTool } from '../tools/team/domain/toolAccess.js';
import { buildPersonRef } from '../lib/toolGate.js';
import { getEmployeeDomain } from '../lib/orgConfig.js';
import { layerTabs, activeTab } from '../lib/hubLayers.js';
import { isEmployeeOf, hubDestination, needsEmployeePerson } from './hubBoot.js';

const VIEW_FLAG = 'grebla-view';
/** Pestaña que se estaba mirando, mientras dure la sesión. */
const TAB_FLAG = 'grebla-hub-tab';
/** ¿Se está previsualizando el hub como otro rol? */
const esSimulada = () => ['leader', 'engineer', 'empleado'].includes(sessionStorage.getItem(VIEW_FLAG));
const landing = document.getElementById('platform-landing');
const hubLoading = document.getElementById('hub-loading');
// Cortafuegos (RMR-BUG-0090): si el arranque no resuelve en 10 s (auth colgada,
// red rota), cae a la landing en vez de dejar el spinner eterno. Cualquier
// showLanding/showTools posterior sigue mandando.
setTimeout(() => {
  if (hubLoading && !hubLoading.hidden) showLanding();
}, 10_000);
const tools = document.getElementById('tenant-tools');
const layersBar = document.getElementById('hub-layers');
const tabsBox = layersBar?.querySelector('.layer-tabs') ?? null;
const adminLink = document.getElementById('admin-link');
// La administración se abre en VENTANA APARTE, así que la vista de esta ventana
// NO se toca: no has cambiado de vista, has abierto otra cosa. Antes era una
// tarjeta que navegaba aquí mismo y había que anotar la vista «admin» para que
// al volver el conmutador no marcara «Manager» (RMR-BUG-0104); con `noopener` la
// ventana nueva arranca sin flag, y sin flag el hub se pinta con tu rol real.

onUserChanged(async (user) => {
  if (!user) return showLanding();
  try {
    // Las cinco lecturas, en paralelo (RMR-BUG-0112). Antes eran cuatro esperas encadenadas
    // y ninguna dependía de la anterior: se encadenaban solo porque cada
    // decisión se tomaba con el dato recién llegado. Con allSettled, un fallo
    // transitorio de una lectura no tumba a quien YA está autorizado: el hub se
    // pinta sin filtrar —como antes de las políticas— y cada herramienta sigue
    // aplicando su propio control.
    const [accessRes, domainRes, surveyRes, personRes, policiesRes] = await Promise.allSettled([
      resolveAccess(user),
      getEmployeeDomain(),
      isSurveyAdmin(user.uid),
      getMyPerson(user.uid),
      listToolPolicies(),
    ]);
    if (accessRes.status !== 'fulfilled') return showLanding();
    const access = accessRes.value;

    const employeeDomain = domainRes.status === 'fulfilled' ? domainRes.value : '';
    const isEmployee = isEmployeeOf(user.email ?? '', user.emailVerified, employeeDomain);
    // Quien gestiona encuestas (People) llega al hub aunque no tenga otro rol.
    const canManageSurveys = canGovern(access) || (surveyRes.status === 'fulfilled' && surveyRes.value === true);

    const destino = hubDestination({ access, isEmployee, canManageSurveys });
    if (destino === 'landing') return showLanding();
    if (destino === 'admin') { location.replace('/admin'); return; }

    let person = personRes.status === 'fulfilled' ? personRes.value : null;
    const filterFailed = personRes.status !== 'fulfilled' || policiesRes.status !== 'fulfilled';
    const policies = policiesRes.status === 'fulfilled' ? policiesRes.value : [];

    // La Cloud Function que crea la ficha del empleado solo se llama si de
    // verdad falta. Antes se esperaba en cada entrada, aunque la ficha llevara
    // meses creada, y con la función fría son segundos de pantalla en blanco.
    if (needsEmployeePerson({ isEmployee, person })) {
      try {
        await ensureEmployeePerson();
        person = await getMyPerson(user.uid);
      } catch {
        // Que no se pueda sellar la ficha no deja a nadie fuera: entra como
        // genérico y el superadmin lo verá en las cuentas sin ficha.
      }
    }

    // Vista elegida en el conmutador: cambia QUÉ se ve, nunca a dónde se va ni
    // qué se puede. Los permisos reales no se tocan y cada herramienta valida.
    const vista = hubAsView(sessionStorage.getItem(VIEW_FLAG), {
      isSuperadmin: canGovern(access),
      isLeaderish: canGovern(access) || leadsTeam(access),
    });
    showTools({
      personRef: vista.generic ? buildPersonRef(null) : buildPersonRef(person),
      policies,
      isSuperadmin: vista.isSuperadmin,
      isLeaderish: vista.isLeaderish,
      filterFailed,
    });
  } catch {
    showLanding();
  }
});

function showLanding() {
  hubLoading?.setAttribute('hidden', '');
  tools?.setAttribute('hidden', '');
  layersBar?.setAttribute('hidden', '');
  landing?.removeAttribute('hidden');
}

/**
 * Pinta las pestañas a partir de las tarjetas que HAN QUEDADO visibles, nunca
 * calculándolas aparte desde el rol: dos fuentes de verdad acabarían enseñando
 * una pestaña vacía, o una que aparece al simular un rol que no la tiene.
 */
function showLayers({ canAdmin }) {
  if (!tabsBox || !layersBar) return;
  const conTarjetas = [...(tools?.querySelectorAll('[data-layer]:not([hidden])') ?? [])]
    .map((card) => card.dataset.layer);
  const { visible, tabs } = layerTabs({ layersWithCards: conTarjetas });
  const activa = activeTab({ layersWithCards: conTarjetas, remembered: sessionStorage.getItem(TAB_FLAG) });
  const conPestana = new Set(tabs.map((t) => t.id));

  for (const boton of tabsBox.querySelectorAll('button')) {
    boton.toggleAttribute('hidden', !visible || !conPestana.has(boton.dataset.layer));
    boton.setAttribute('aria-selected', String(boton.dataset.layer === activa));
  }
  adminLink?.toggleAttribute('hidden', !canAdmin);
  // La barra entera se oculta si no hay ni pestañas ni enlace: una franja vacía
  // solo añade ruido y un borde que no separa nada.
  layersBar.toggleAttribute('hidden', !visible && !canAdmin);
  aplicarCapa(activa, visible);
}

// Los listeners se registran UNA vez, no en cada repintado: engancharlos al
// pintar los duplicaría cada vez que se cambia de vista.
for (const boton of tabsBox?.querySelectorAll('button') ?? []) {
  boton.addEventListener('click', () => {
    const capa = boton.dataset.layer;
    sessionStorage.setItem(TAB_FLAG, capa);
    for (const otro of tabsBox?.querySelectorAll('button') ?? []) {
      otro.setAttribute('aria-selected', String(otro.dataset.layer === capa));
    }
    aplicarCapa(capa, true);
  });
}

/**
 * Enseña las tarjetas de una capa. Con las pestañas ocultas —una sola capa— no
 * se filtra nada: si no hay dónde elegir, esconder sería esconder por esconder.
 */
function aplicarCapa(capa, conPestanas) {
  for (const card of tools?.querySelectorAll('[data-layer]') ?? []) {
    card.toggleAttribute('data-off-layer', conPestanas && card.dataset.layer !== capa);
  }
}

function showTools({ personRef, policies = [], isSuperadmin = false, isLeaderish = false, filterFailed = false }) {
  hubLoading?.setAttribute('hidden', '');
  landing?.setAttribute('hidden', '');
  tools?.removeAttribute('hidden');
  const policyById = new Map(policies.map((p) => [p.toolId, p]));
  // Lo personal (RMR-TSK-0459): se ve siempre que haya ficha, sin pasar por la
  // política de audiencia. La política gobierna la herramienta de equipo —llevar
  // los O2O de tu gente—, no el derecho a mirar tus propios datos. Sin ficha no
  // hay nada que enseñar, así que se oculta.
  for (const card of tools?.querySelectorAll('[data-personal]') ?? []) {
    card.toggleAttribute('hidden', !personRef?.personId);
  }
  // Resto de herramientas: visibles según la política de acceso de cada una
  // (RMR-PCS-0027 · F6). «team» es gestión (no tiene política): la ve quien lidera
  // o gobierna. Las demás, por canUseTool; el superadmin siempre las ve.
  for (const card of tools?.querySelectorAll('[data-tool-id]:not([data-personal])') ?? []) {
    const id = card.dataset.toolId;
    // Fallback de disponibilidad: si no se pudieron cargar persona/políticas, no
    // se filtra (se muestran, como antes de F6); cada herramienta valida su acceso.
    if (filterFailed) { card.toggleAttribute('hidden', false); continue; }
    let visible;
    if (id === 'team') visible = isSuperadmin || isLeaderish;
    else {
      const policy = policyById.get(id);
      visible = isSuperadmin || (policy != null && canUseTool(personRef, policy));
    }
    card.toggleAttribute('hidden', !visible);
  }
  // Las capas van DESPUÉS del filtrado: se derivan de lo que ha quedado visible.
  showLayers({ canAdmin: isSuperadmin });
}
