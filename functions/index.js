/**
 * Cloud Functions de GREBLA.
 *
 * grantAdmin: callable que permite a un admin existente conceder el rol admin a
 * otra persona por email. Establece el custom claim { admin: true } y crea el
 * documento /admins/{uid}. El primer admin se crea con el bootstrap de la UI
 * (/login) o con el script de seed.
 */
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { defineSecret } from 'firebase-functions/params';
import { randomBytes } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import * as coins from './coins.js';
import { JD_POLISH_MODEL, JD_POLISH_TOOL, buildPolishPrompt, sanitizePolishedItems } from './jdPolish.js';
import { sign, coinsKmsKeyName } from './signer.js';
import { computePulseAggregate, departmentOf } from './pulseAggregate.js';
import {
  MOTIVATOR_DECK_IDS, MOTIVATOR_DECK_SIZE, MOT_MIN_RESPONDENTS, motComputeAggregates,
} from './motivatorsAggregate.js';
import { validateResponses, sanitizeResponses, bucketMetadata, answerId, emailTemplateErrors, renderEmailBody, sanitizeParticipantMeta } from './survey.js';
import { sendResend } from './resend.js';
import { getPortalDb, portalConfigured, publishSquadMetrics } from './portal.js';

initializeApp();

/** @param {string} uid */
async function isAdmin(uid) {
  const snap = await getFirestore().doc(`admins/${uid}`).get();
  return snap.exists;
}

/** Gestor de encuestas (People): gestiona /surveys sin ser superadmin. @param {string} uid */
async function isSurveyAdmin(uid) {
  const snap = await getFirestore().doc(`surveyAdmins/${uid}`).get();
  return snap.exists;
}

export const grantAdmin = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) {
    throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
  }
  const callerIsAdmin = caller.token.admin === true || (await isAdmin(caller.uid));
  if (!callerIsAdmin) {
    throw new HttpsError('permission-denied', 'Solo un administrador puede conceder acceso admin.');
  }

  const email = typeof request.data?.email === 'string' ? request.data.email.trim() : '';
  if (!email) {
    throw new HttpsError('invalid-argument', 'Falta el email del nuevo administrador.');
  }

  let user;
  try {
    user = await getAuth().getUserByEmail(email);
  } catch (err) {
    // Alta sin login previo (RMR-TSK-0230, mismo patrón que manageAccess): se
    // provisiona la cuenta con el Admin SDK; Firebase vincula sola el primer
    // login real con Google a este email (misma política "una cuenta por email").
    if (err?.code !== 'auth/user-not-found') {
      throw new HttpsError('not-found', `No existe ningún usuario con el email ${email}. Debe iniciar sesión al menos una vez.`);
    }
    try {
      user = await getAuth().createUser({ email });
    } catch {
      throw new HttpsError('invalid-argument', `No se pudo crear la cuenta para ${email}. Comprueba que el email es correcto.`);
    }
  }

  await getAuth().setCustomUserClaims(user.uid, { admin: true });
  await getFirestore().doc(`admins/${user.uid}`).set(
    {
      email: user.email ?? email,
      displayName: user.displayName ?? user.email ?? email,
      grantedBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { ok: true, uid: user.uid };
});

// ── Accesos (líderes y viewers) ──────────────────────────────────────────────
const ACCESS_COLLECTION = { leader: 'leaders', viewer: 'viewers', surveyAdmin: 'surveyAdmins' };

/**
 * Gestiona los accesos de la instancia: líderes (gestionan sus personas) y
 * viewers (solo lectura, tipo C-level). Solo un superadmin. Resuelve el email
 * a uid (el usuario debe haber iniciado sesión al menos una vez) y crea o
 * borra /leaders/{uid} o /viewers/{uid} según `role`.
 * action: 'add' (por defecto) | 'remove'. role: 'leader' (por defecto) | 'viewer'.
 */
export const manageAccess = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
  if (!(await isAdmin(caller.uid))) {
    throw new HttpsError('permission-denied', 'Solo un superadmin puede gestionar accesos.');
  }
  const action = request.data?.action === 'remove' ? 'remove' : 'add';
  const role = ['viewer', 'surveyAdmin'].includes(request.data?.role) ? request.data.role : 'leader';
  const collectionName = ACCESS_COLLECTION[role];
  const email = typeof request.data?.email === 'string' ? request.data.email.trim() : '';
  if (!email) throw new HttpsError('invalid-argument', 'Falta el email.');

  let user;
  try {
    user = await getAuth().getUserByEmail(email);
  } catch (err) {
    // Alta (RMR-TSK-0228): el superadmin puede añadir un líder/viewer aunque
    // nunca haya iniciado sesión — se PROVISIONA la cuenta con el Admin SDK.
    // Firebase Auth vincula solo (misma cuenta, mismo uid) el primer login real
    // con Google a este email, por la política por defecto «una cuenta por
    // email»: no hace falta un patrón de invitación/sellado aparte. Al borrar
    // acceso no se provisiona nada (no tendría sentido crear una cuenta para
    // quitarle el rol).
    if (action !== 'add' || err?.code !== 'auth/user-not-found') {
      throw new HttpsError('not-found', `No existe ningún usuario con el email ${email}. Debe iniciar sesión al menos una vez.`);
    }
    try {
      user = await getAuth().createUser({ email });
    } catch {
      throw new HttpsError('invalid-argument', `No se pudo crear la cuenta para ${email}. Comprueba que el email es correcto.`);
    }
  }

  const ref = getFirestore().doc(`${collectionName}/${user.uid}`);
  if (action === 'remove') {
    await ref.delete();
    return { ok: true, action, role, uid: user.uid };
  }
  await ref.set(
    {
      email: user.email ?? email,
      displayName: user.displayName ?? user.email ?? email,
      addedBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { ok: true, action, role, uid: user.uid };
});

/**
 * Sella la invitación de una persona pre-invitada por email (RMR-TSK-0167). El
 * propio usuario, ya logado, la llama: busca una persona con
 * `pendingEmail == su-email` y `uid == null`, le escribe su uid y borra
 * pendingEmail — así hereda el plan/equipo preparados por adelantado. Admin SDK
 * (las reglas no dejan al cliente escribirse su propio uid). Idempotente: sin
 * invitación pendiente devuelve { sealed: false } sin tocar nada; solo sella la
 * PRIMERA coincidencia (una colisión de emails no reparte accesos a ciegas).
 */
export const sealInvite = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
  const email = typeof caller.token?.email === 'string' ? caller.token.email.trim().toLowerCase() : '';
  if (!email) return { sealed: false, reason: 'no-email' };

  const snap = await getFirestore().collection('people').where('pendingEmail', '==', email).get();
  // Filtra en código las ya vinculadas (evita un índice compuesto por dos
  // campos): solo sella una persona que siga SIN uid.
  const pending = snap.docs.find((d) => !d.data().uid);
  if (!pending) return { sealed: false };

  await pending.ref.set({ uid: caller.uid, pendingEmail: FieldValue.delete() }, { merge: true });
  return { sealed: true, personId: pending.id };
});

/**
 * Entrar en una retro por su enlace (RMR-TSK-0454, ADR «Retros por membresía»).
 *
 * Se hace con Admin SDK y no con reglas por un círculo: para comprobar el token
 * habría que leer el documento de la retro, y quien todavía no es miembro no
 * puede leerlo. La función rompe ese círculo sin abrir la lectura a nadie.
 *
 * Idempotente: abrir el enlace dos veces no duplica ni reordena nada. Y sigue
 * funcionando con la retro cerrada, porque el mismo enlace tiene que servir para
 * consultar después el resumen y las acciones.
 */
export const joinRetro = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión para entrar en una retro.');
  const retroId = typeof request.data?.retroId === 'string' ? request.data.retroId.trim() : '';
  const token = typeof request.data?.token === 'string' ? request.data.token.trim() : '';
  if (!retroId || !token) throw new HttpsError('invalid-argument', 'El enlace de la retro no está completo.');

  const ref = getFirestore().collection('retros').doc(retroId);
  const snap = await ref.get();
  // Mismo mensaje para «no existe» y «token que no vale»: si fueran distintos,
  // se podría averiguar qué retros existen probando ids.
  const noVale = () => new HttpsError('permission-denied', 'Este enlace no da acceso a la retro.');
  if (!snap.exists) throw noVale();
  const retro = snap.data() ?? {};
  const esperado = typeof retro.joinToken === 'string' ? retro.joinToken : '';
  if (esperado === '' || token !== esperado) throw noVale();

  const dentro = Array.isArray(retro.memberUids) ? retro.memberUids : [];
  if (dentro.includes(caller.uid)) return { joined: true, already: true };
  await ref.update({ memberUids: FieldValue.arrayUnion(caller.uid) });
  return { joined: true, already: false };
});

/**
 * Corroboración de empleado (RMR-PCS-0027 · F7): al loguearse alguien del dominio
 * de la instancia (/config/org.employeeDomain), garantiza que existe su ficha
 * /people. Idempotente y tolerante:
 *  - si ya tiene ficha vinculada por uid, no hace nada;
 *  - si hay una ficha con su email SIN uid, se la vincula (corroboración);
 *  - si no hay ninguna, le crea una ficha 'generico' (miembro de la organización
 *    sin equipo, con acceso base a las herramientas everyone).
 * Admin SDK porque las reglas no dejan al cliente crearse la ficha ni escribirse el
 * uid. El login NO crea jerarquía: la ficha nace 'generico' y el superadmin le
 * asigna rol/equipo cuando toque.
 */
export const ensureEmployeePerson = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
  const token = caller.token ?? {};
  const email = typeof token.email === 'string' ? token.email.trim().toLowerCase() : '';
  // Solo empleados con email VERIFICADO del dominio configurado.
  if (!email || token.email_verified !== true) return { created: false, reason: 'unverified' };

  const db = getFirestore();
  const orgSnap = await db.doc('config/org').get();
  const domain = (orgSnap.exists ? (orgSnap.data().employeeDomain ?? '') : '')
    .toString().trim().toLowerCase().replace(/^@/, '');
  if (!domain || !email.endsWith('@' + domain)) return { created: false, reason: 'not-employee' };

  // ¿Ya tiene ficha vinculada por uid? Nada que hacer (cubre las fichas migradas).
  const byUid = await db.collection('people').where('uid', '==', caller.uid).limit(1).get();
  if (!byUid.empty) return { created: false, personId: byUid.docs[0].id, reason: 'exists' };

  // ¿Ficha con su email SIN uid? Corroborar vinculando (solo la primera).
  const byEmail = await db.collection('people').where('email', '==', email).get();
  const unlinked = byEmail.docs.find((d) => !d.data().uid);
  if (unlinked) {
    await unlinked.ref.set({ uid: caller.uid }, { merge: true });
    return { created: false, personId: unlinked.id, reason: 'linked' };
  }

  // Crear ficha 'generico' de forma ATÓMICA: un índice determinista por uid
  // (peopleByUid/{uid}, solo Admin SDK) garantiza una sola ficha aunque el primer
  // login llegue por dos pestañas a la vez. El personId sigue siendo autogenerado.
  const indexRef = db.collection('peopleByUid').doc(caller.uid);
  const outcome = await db.runTransaction(async (tx) => {
    const idx = await tx.get(indexRef);
    if (idx.exists) return { created: false, personId: idx.data().personId, reason: 'exists' };
    const personRef = db.collection('people').doc();
    tx.set(personRef, {
      name: typeof token.name === 'string' && token.name ? token.name : email,
      email,
      uid: caller.uid,
      orgRole: 'generico',
      orgBranch: 'generico',
      active: true,
      startDate: new Date().toISOString().slice(0, 10),
      guilds: [],
      disciplines: [],
      labels: [],
    });
    tx.set(indexRef, { personId: personRef.id, createdAt: FieldValue.serverTimestamp() });
    return { created: true, personId: personRef.id };
  });
  return outcome;
});

/**
 * Colección de acceso que corresponde a un orgRole según el organigrama: rol con
 * hijos-hoja (ICs) → 'leaders'; con hijos que a su vez mandan → 'supermanagers';
 * sin hijos (o desconocido) → null (no es mando).
 * @param {Array<{id:string,reportsToRoleId:string|null}>} roles
 * @param {string|null} orgRole
 * @returns {'leaders'|'supermanagers'|null}
 */
function mirrorCollectionFor(roles, orgRole) {
  if (!orgRole) return null;
  const children = roles.filter((r) => r.reportsToRoleId === orgRole);
  if (children.length === 0) return null;
  const gestionaMandos = children.some((c) => roles.some((r) => r.reportsToRoleId === c.id));
  return gestionaMandos ? 'supermanagers' : 'leaders';
}

/**
 * Espejo de ACCESO derivado del rol (RMR-PCS-0027 · F8d): cuando una persona con
 * cuenta vinculada tiene un orgRole de MANDO, refleja su permiso en /leaders
 * (gestiona ICs) o /supermanagers (gestiona managers), para que las reglas O(1) y
 * el resto del código sigan resolviendo el acceso por uid.
 *
 * DECISIÓN DE NEGOCIO EXPLÍCITA (aprobada por el usuario): el espejo **nunca
 * RETIRA acceso automáticamente** — una degradación de rol, un cambio de tipo o
 * un borrado no deben dejar a nadie sin acceso por sorpresa; el retiro es manual.
 * PERO para que eso NO sea retención silenciosa de privilegios, cuando el rol
 * actual ya no justifica un acceso reflejado, se MARCA ese doc con
 * `staleAccess:true` (+ motivo y fecha) para que el superadmin lo revise y retire
 * cuando quiera. Al recuperar el rol, la marca se limpia. NUNCA toca /admins.
 */
export const mirrorAccessOnPersonWrite = onDocumentWritten(
  { document: 'people/{personId}', region: 'europe-west1' },
  async (event) => {
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const afterUid = typeof after?.uid === 'string' && after.uid ? after.uid : null;
    const afterRole = typeof after?.orgRole === 'string' && after.orgRole ? after.orgRole : null;
    const beforeUid = typeof before?.uid === 'string' && before.uid ? before.uid : null;
    const beforeRole = typeof before?.orgRole === 'string' && before.orgRole ? before.orgRole : null;
    // Nada relevante cambió: ni el vínculo ni el rol. Evita writes redundantes.
    if (afterUid === beforeUid && afterRole === beforeRole) return;

    const db = getFirestore();
    const rolesSnap = await db.collection('orgRoles').get();
    const roles = rolesSnap.docs.map((d) => ({ id: d.id, reportsToRoleId: d.data().reportsToRoleId ?? null }));

    const afterCol = afterUid ? mirrorCollectionFor(roles, afterRole) : null;
    const beforeCol = beforeUid ? mirrorCollectionFor(roles, beforeRole) : null;

    // 1) Concede/actualiza el acceso vigente (solo añade) y limpia una marca previa.
    if (afterCol) {
      await db.doc(`${afterCol}/${afterUid}`).set(
        {
          displayName: after.name ?? null,
          email: after.email ?? null,
          mirroredFrom: event.params.personId,
          mirroredRole: afterRole,
          staleAccess: FieldValue.delete(),
          staleReason: FieldValue.delete(),
          staleSince: FieldValue.delete(),
          addedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      logger.info(`[mirror] ${afterCol}/${afterUid} vigente (persona ${event.params.personId}, rol ${afterRole})`);
    }

    // 2) Un acceso reflejado que ya NO corresponde (degradación, cambio de tipo/uid
    //    o borrado): NO se borra (decisión de negocio) — se MARCA como obsoleto para
    //    revisión manual. Solo si el doc existe y no es el mismo que acaba de renovarse.
    if (beforeCol && !(afterCol === beforeCol && afterUid === beforeUid)) {
      const staleRef = db.doc(`${beforeCol}/${beforeUid}`);
      if ((await staleRef.get()).exists) {
        await staleRef.set(
          {
            staleAccess: true,
            staleReason: 'El rol actual de la persona ya no justifica este acceso; revísalo y retíralo si procede.',
            staleSince: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        logger.warn(`[mirror] ${beforeCol}/${beforeUid} marcado STALE (persona ${event.params.personId})`);
      }
    }
  },
);

// ── Espejo /toolManagers (RMR-TSK-0389, ADR «managesToolByPolicy») ────────────
// El grant managedBy de /toolPolicies se materializa en /toolManagers con doc id
// {toolId}--{uid}, para que las reglas lo consulten con un exists() barato
// (generaliza el precedente /surveyAdmins). DUPLICACIÓN CONTROLADA del dominio
// src/tools/team/domain/toolAccess.js (las functions no empaquetan src/): si se
// cambia el matcher allí, cambiarlo también aquí.

/** ¿La persona encaja en un grant? Unión de reglas everyone/branches/roleIds/personIds. */
function matchesToolGrant(grant, person) {
  if (!grant) return false;
  if (grant.everyone) return true;
  if (person.branch && (grant.branches ?? []).includes(person.branch)) return true;
  if (person.roleId && (grant.roleIds ?? []).includes(person.roleId)) return true;
  if (person.personId && (grant.personIds ?? []).includes(person.personId)) return true;
  return false;
}

/** ¿Gestiona la herramienta? Override individual manda; si no, el grant managedBy. */
function personManagesTool(person, policy) {
  const ov = person.toolOverrides?.[policy.toolId]?.manage;
  if (ov === true || ov === false) return ov;
  return matchesToolGrant(policy.managedBy, person);
}

/**
 * Recalcula el espejo COMPLETO (idempotente): docs deseados = personas activas
 * CON uid cuyo manage efectivo es true, por herramienta. Añade los que faltan y
 * borra los sobrantes. A esta escala (~11 tools × ~30 personas) el recomputo
 * completo por trigger es más simple y seguro que el diff incremental.
 */
async function recomputeToolManagers(reason) {
  const db = getFirestore();
  const [policiesSnap, peopleSnap, existingSnap] = await Promise.all([
    db.collection('toolPolicies').get(),
    db.collection('people').get(),
    db.collection('toolManagers').get(),
  ]);
  const people = peopleSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => typeof p.uid === 'string' && p.uid && p.active !== false)
    .map((p) => ({
      personId: p.id,
      uid: p.uid,
      branch: p.orgBranch ?? 'generico',
      roleId: p.orgRole ?? null,
      toolOverrides: p.toolOverrides ?? {},
    }));
  const desired = new Set();
  for (const doc of policiesSnap.docs) {
    const policy = { toolId: doc.id, ...doc.data() };
    for (const person of people) {
      if (personManagesTool(person, policy)) desired.add(`${policy.toolId}--${person.uid}`);
    }
  }
  const existing = new Set(existingSnap.docs.map((d) => d.id));
  const toAdd = [...desired].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !desired.has(id));
  await Promise.all([
    ...toAdd.map((id) => db.doc(`toolManagers/${id}`).set({ grantedAt: FieldValue.serverTimestamp(), source: 'policy' })),
    ...toRemove.map((id) => db.doc(`toolManagers/${id}`).delete()),
  ]);
  if (toAdd.length || toRemove.length) {
    logger.info(`[toolManagers] ${reason}: +${toAdd.length} −${toRemove.length} (total ${desired.size})`);
  }
}

/** Cambió una política → resincroniza el espejo. */
export const syncToolManagersOnPolicyWrite = onDocumentWritten(
  { document: 'toolPolicies/{toolId}', region: 'europe-west1' },
  () => recomputeToolManagers('policy'),
);

/** Cambió una persona en algo relevante (uid/rol/rama/overrides/active — cubre
 *  también el sellado de sealInvite) → resincroniza. El resto de ediciones de la
 *  ficha (nombre, gremios, notas…) no disparan el recomputo. */
export const syncToolManagersOnPersonWrite = onDocumentWritten(
  { document: 'people/{personId}', region: 'europe-west1' },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const relevant = (p) => JSON.stringify([
      p?.uid ?? null, p?.orgRole ?? null, p?.orgBranch ?? null, p?.toolOverrides ?? null, p?.active ?? true,
    ]);
    if (before && after && relevant(before) === relevant(after)) return;
    await recomputeToolManagers(`person ${event.params.personId}`);
  },
);

/**
 * Borra DEFINITIVAMENTE a una persona con su subárbol completo (plan de carrera,
 * valoraciones, lecturas, conversaciones, notas, sesiones de Role Mirror…) con
 * `recursiveDelete` del Admin SDK — el cliente Web no puede borrar subcolecciones
 * en cascada. Distinto de la baja (active:false, que CONSERVA los datos y solo la
 * saca de las estadísticas activas): esto la elimina por completo, para gente
 * creada por error. Solo el dueño (ownerLeaderUid) o un superadmin, y SOLO si la
 * persona ya está dada de baja (precondición de seguridad).
 */
export const deletePerson = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
  const personId = typeof request.data?.personId === 'string' ? request.data.personId.trim() : '';
  if (!personId) throw new HttpsError('invalid-argument', 'Falta el personId a borrar.');

  const db = getFirestore();
  const ref = db.doc(`people/${personId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', `Persona ${personId} no encontrada.`);

  const person = snap.data();
  const canDelete = person.ownerLeaderUid === caller.uid || (await isAdmin(caller.uid));
  if (!canDelete) {
    throw new HttpsError('permission-denied', 'Solo el dueño o un superadmin pueden borrar una persona.');
  }
  if (person.active !== false) {
    throw new HttpsError('failed-precondition', 'Da de baja a la persona antes de borrarla definitivamente.');
  }

  await db.recursiveDelete(ref); // borra el doc y TODAS sus subcolecciones
  return { ok: true, deletedPersonId: personId };
});

/**
 * Borra una encuesta COMPLETA (doc + subcolecciones `tokens` y `answers`) con
 * `recursiveDelete` del Admin SDK — el cliente Web no puede borrar subcolecciones
 * ni el propio doc (reglas: `delete` a false). Solo un superadmin.
 */
export const deleteSurvey = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
  if (!(await isAdmin(caller.uid))) {
    throw new HttpsError('permission-denied', 'Solo un superadmin puede borrar encuestas.');
  }
  const surveyId = typeof request.data?.surveyId === 'string' ? request.data.surveyId.trim() : '';
  if (!surveyId) throw new HttpsError('invalid-argument', 'Falta el surveyId a borrar.');

  const db = getFirestore();
  const ref = db.doc(`surveys/${surveyId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', `Encuesta ${surveyId} no encontrada.`);

  // No se borra una encuesta CON respuestas: primero se reinicia (evita tirar datos
  // por error). La UI también deshabilita el botón, pero se valida aquí (server-side).
  const anAnswer = await ref.collection('answers').limit(1).get();
  if (!anAnswer.empty) {
    throw new HttpsError('failed-precondition', 'La encuesta tiene respuestas. Reiníciala antes de borrarla.');
  }

  await db.recursiveDelete(ref); // borra el doc y sus subcolecciones (tokens, answers)
  return { ok: true, deletedSurveyId: surveyId };
});

/**
 * getMyO2O: proyección COMPARTIDA de los O2O de la persona vinculada al llamante.
 * Deriva el personId de su uid (no lo acepta como input, para que solo obtenga lo
 * suyo), busca las sesiones en los líderes que le corresponden (dueño + líderes
 * con los que está compartida) y devuelve SOLO {date, sharedSummary} de las que el
 * líder marcó como compartidas — nunca transcripción, notas ni el resumen privado.
 * Añade sus acciones (que ya puede leer por reglas) para resolverlo en un viaje.
 */
export const getMyO2O = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');

  const db = getFirestore();
  const personSnap = await db.collection('people').where('uid', '==', caller.uid).limit(1).get();
  const personDoc = personSnap.docs.at(0);
  if (!personDoc) throw new HttpsError('not-found', 'No hay ninguna persona vinculada a tu cuenta.');
  const personId = personDoc.id;
  const person = personDoc.data();

  const leaderUids = [...new Set([person.ownerLeaderUid, ...(person.sharedWithUids ?? [])].filter(Boolean))];
  const perLeader = await Promise.all(
    leaderUids.map((luid) =>
      db.collection('leaders').doc(luid).collection('o2o').where('personId', '==', personId).get(),
    ),
  );
  const sessions = perLeader
    .flatMap((snap) => snap.docs)
    .map((d) => d.data())
    .filter((s) => s.sharedWithPerson && s.sharedSummary)
    .map((s) => ({ date: s.date, sharedSummary: s.sharedSummary }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const actionsSnap = await db.collection('people').doc(personId).collection('o2oActions').get();
  const actions = actionsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  return { sessions, actions };
});

// ── Encuestas anónimas: respuesta por token SIN login (RMR-PCS-0026) ─────────
// La página de respuesta es PÚBLICA (sin auth): el token largo aleatorio del link
// es la única credencial. TODA la escritura vive aquí (Admin SDK); las reglas
// deniegan que el cliente escriba respuestas/tokens. El SALT (Secret Manager) hace
// answerId = HMAC(salt, token), así se edita la MISMA respuesta sin guardar el
// mapeo token→respuesta (un admin con la BBDD no puede reidentificar por ahí).
const SURVEY_SALT = defineSecret('SURVEY_SALT');
// API key de Resend (https://resend.com) para el envío de correos de encuestas.
// Debe definirse ANTES de las Cloud Functions que la usan (evita TDZ al cargar).
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
// Clave (JSON) de la service account del portal de management (tribbu-dev-portal),
// para el push periódico de métricas DORA/LEAN. Solo configurada en la instancia
// que alimenta al portal; en otras (demo) es un placeholder y el push se omite.
const PORTAL_SA_KEY = defineSecret('PORTAL_SA_KEY');
const MAIL_FROM = 'Encuestas TRIBBU <encuestas@send.tribbu.io>';

/** Carga la encuesta abierta de un token y las respuestas previas (para editar). */
export const getSurveyForToken = onCall(
  { region: 'europe-west1', secrets: [SURVEY_SALT] },
  async (request) => {
    const { surveyId, token } = request.data ?? {};
    if (!surveyId || !token) throw new HttpsError('invalid-argument', 'Faltan surveyId o token.');
    const db = getFirestore();
    const surveySnap = await db.doc(`surveys/${surveyId}`).get();
    if (!surveySnap.exists) throw new HttpsError('not-found', 'Encuesta no encontrada.');
    const survey = surveySnap.data();
    const tokenSnap = await db.doc(`surveys/${surveyId}/tokens/${token}`).get();
    if (!tokenSnap.exists) throw new HttpsError('permission-denied', 'Enlace no válido.');
    // El token de PRUEBA puede responder también en borrador (RMR-TSK-0425):
    // su respuesta va marcada test y NUNCA cuenta en los agregados.
    const isTest = tokenSnap.data().test === true;
    if (survey.status !== 'open' && !isTest) {
      throw new HttpsError('failed-precondition', 'La encuesta no está abierta.');
    }
    const ansSnap = await db.doc(`surveys/${surveyId}/answers/${answerId(token, SURVEY_SALT.value())}`).get();
    return {
      survey: { title: survey.title ?? '', questions: survey.questions ?? [], thanksMessage: survey.thanksMessage ?? '' },
      responses: ansSnap.exists ? (ansSnap.data().answers ?? null) : null,
      isTest,
    };
  },
);

/** Guarda/sobrescribe la respuesta ANÓNIMA y marca el token usado. Editable hasta el cierre. */
export const submitSurveyResponse = onCall(
  { region: 'europe-west1', secrets: [SURVEY_SALT] },
  async (request) => {
    const { surveyId, token, responses } = request.data ?? {};
    if (!surveyId || !token) throw new HttpsError('invalid-argument', 'Faltan surveyId o token.');
    const db = getFirestore();
    const surveySnap = await db.doc(`surveys/${surveyId}`).get();
    if (!surveySnap.exists) throw new HttpsError('not-found', 'Encuesta no encontrada.');
    const survey = surveySnap.data();
    const tokenRef = db.doc(`surveys/${surveyId}/tokens/${token}`);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) throw new HttpsError('permission-denied', 'Enlace no válido.');
    // Token de PRUEBA: puede responder en borrador (respuesta marcada test,
    // excluida siempre de los agregados). El resto exige encuesta abierta.
    if (survey.status !== 'open' && tokenSnap.data().test !== true) {
      throw new HttpsError('failed-precondition', 'La encuesta no está abierta.');
    }
    // Solo se guardan respuestas a preguntas de la encuesta: un token válido no
    // debe poder inyectar campos extra en el documento.
    const clean = sanitizeResponses(survey.questions ?? [], responses ?? {});
    const { valid, errors } = validateResponses(survey.questions ?? [], clean);
    if (!valid) throw new HttpsError('invalid-argument', 'Respuestas no válidas.', { errors });

    const nowIso = new Date().toISOString();
    const answerRef = db.doc(`surveys/${surveyId}/answers/${answerId(token, SURVEY_SALT.value())}`);
    const prev = await answerRef.get();
    // Respuesta ANÓNIMA: sin token ni email; metadatos en tramos. Reenviar
    // sobrescribe la misma (editable) preservando la fecha de la primera vez.
    await answerRef.set({
      answers: clean,
      metadata: bucketMetadata(tokenSnap.data().metadata ?? {}, nowIso, await declaredAxisIds(db)),
      test: tokenSnap.data().test === true, // respuesta de PRUEBA: se excluye de los agregados
      createdAt: prev.exists ? (prev.data().createdAt ?? nowIso) : nowIso,
      updatedAt: nowIso,
    });
    // Participación (para el % por departamento), sin ligar el token a la respuesta.
    await tokenRef.set({ used: true, respondedAt: nowIso }, { merge: true });
    return { ok: true };
  },
);

/**
 * Genera un token único por participante de una encuesta (padrón). Solo
 * superadmin (People). Reutiliza el token existente por email para no duplicar al
 * re-ejecutar. Escribe /surveys/{id}/tokens/{token} = { email, metadata, used }.
 * Devuelve [{ email, token }]; el cliente compone el enlace con su origin.
 */
export const createSurveyTokens = onCall({ region: 'europe-west1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
  if (!(await isAdmin(uid)) && !(await isSurveyAdmin(uid))) {
    throw new HttpsError('permission-denied', 'Solo un superadmin o gestor de encuestas puede generar enlaces.');
  }
  const { surveyId, participants } = request.data ?? {};
  if (!surveyId || !Array.isArray(participants)) throw new HttpsError('invalid-argument', 'Faltan surveyId o participants.');

  const db = getFirestore();
  const surveyRef = db.doc(`surveys/${surveyId}`);
  if (!(await surveyRef.get()).exists) throw new HttpsError('not-found', 'Encuesta no encontrada.');

  try {
    // Tokens ya emitidos, indexados por email, para no duplicar.
    const existing = await surveyRef.collection('tokens').get();
    const tokenByEmail = new Map();
    existing.docs.forEach((d) => {
      const email = d.data().email;
      if (email) tokenByEmail.set(String(email).toLowerCase(), d.id);
    });

    const results = [];
    let batch = db.batch();
    let pending = 0;
    // Lista blanca server-side (RMR-TSK-0355): fijos + ejes declarados; el
    // cliente no puede colar campos arbitrarios en los tokens.
    const axisIds = await declaredAxisIds(db);
    for (const p of participants) {
      const email = String(p?.email ?? '').trim();
      if (!email || !email.includes('@')) continue;
      const key = email.toLowerCase();
      const cleanMeta = sanitizeParticipantMeta(p?.metadata ?? {}, axisIds);
      let token = tokenByEmail.get(key);
      if (!token) {
        token = randomBytes(18).toString('hex');
        tokenByEmail.set(key, token);
        batch.set(surveyRef.collection('tokens').doc(token), { email, metadata: cleanMeta, used: false });
        pending += 1;
        if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
      } else if (Object.keys(cleanMeta).length > 0) {
        // El enlace ya existe: re-subir el padrón ACTUALIZA sus campos de segmentación
        // (merge, sin duplicar el token). No borra los que no vengan en esta subida.
        batch.set(surveyRef.collection('tokens').doc(token), { metadata: cleanMeta }, { merge: true });
        pending += 1;
        if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
      }
      results.push({ email, token });
    }
    if (pending > 0) await batch.commit();
    return { tokens: results };
  } catch (err) {
    // Diagnóstico: el detalle SOLO al log del servidor (no al cliente, para no
    // filtrar internos); el cliente recibe un mensaje genérico.
    logger.error('createSurveyTokens failed', { message: err?.message, stack: err?.stack, count: Array.isArray(participants) ? participants.length : 0 });
    throw new HttpsError('internal', 'No se pudieron generar los enlaces. Inténtalo de nuevo; si persiste, avisa.');
  }
});

/**
 * Ejes de segmentación a medida DECLARADOS (RMR-TSK-0355): ids del doc
 * /padron/_axes. Es la LISTA BLANCA server-side de campos custom que pueden
 * viajar en tokens y respuestas — lo no declarado nunca sale del padrón.
 * Best-effort: sin doc (o ilegible) no hay ejes custom, nunca revienta.
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<string[]>}
 */
async function declaredAxisIds(db) {
  try {
    const snap = await db.doc('padron/_axes').get();
    const axes = snap.exists ? snap.data().axes : null;
    return Array.isArray(axes) ? axes.map((a) => String(a?.id ?? '')).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Actualiza los campos de segmentación (metadata) de UN participante ya creado,
 * localizado por su token, sin regenerar el enlace. Solo superadmin/People. La
 * metadata se sanea a las claves conocidas + los ejes declarados (nada de
 * campos arbitrarios).
 */
export const updateSurveyParticipant = onCall(
  { region: 'europe-west1', secrets: [SURVEY_SALT] },
  async (request) => {
    await assertSurveyManager(request.auth?.uid);
    const surveyId = typeof request.data?.surveyId === 'string' ? request.data.surveyId.trim() : '';
    const token = typeof request.data?.token === 'string' ? request.data.token.trim() : '';
    if (!surveyId || !token) throw new HttpsError('invalid-argument', 'Faltan surveyId o token.');

    const db = getFirestore();
    const surveyRef = db.doc(`surveys/${surveyId}`);
    const tokenRef = surveyRef.collection('tokens').doc(token);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) throw new HttpsError('not-found', 'Participante no encontrado.');

    const axisIds = await declaredAxisIds(db);
    const cleanMeta = sanitizeParticipantMeta(request.data?.metadata ?? {}, axisIds);
    await tokenRef.set({ metadata: cleanMeta }, { merge: true });

    // Si ya respondió, re-bucketizar su respuesta anónima para que los resultados
    // segmentados usen los nuevos campos y no queden buckets obsoletos.
    if (tokenSnap.data().used === true) {
      // Los tramos (edad/antigüedad) se recalculan respecto a la fecha ORIGINAL de
      // la respuesta, no a la de esta edición, para no alterar el histórico.
      const refIso = tokenSnap.data().respondedAt || new Date().toISOString();
      const answerRef = surveyRef.collection('answers').doc(answerId(token, SURVEY_SALT.value()));
      if ((await answerRef.get()).exists) {
        await answerRef.set({ metadata: bucketMetadata(cleanMeta, refIso, axisIds) }, { merge: true });
      }
    }
    return { ok: true };
  },
);

/**
 * Borra UN participante (su token) y su respuesta anónima si la hubiera. El
 * answerId es HMAC del token con el SALT (secreto), así que se recalcula aquí.
 * Solo superadmin/People.
 */
export const deleteSurveyParticipant = onCall(
  { region: 'europe-west1', secrets: [SURVEY_SALT] },
  async (request) => {
    await assertSurveyManager(request.auth?.uid);
    const surveyId = typeof request.data?.surveyId === 'string' ? request.data.surveyId.trim() : '';
    const token = typeof request.data?.token === 'string' ? request.data.token.trim() : '';
    if (!surveyId || !token) throw new HttpsError('invalid-argument', 'Faltan surveyId o token.');

    const db = getFirestore();
    const surveyRef = db.doc(`surveys/${surveyId}`);
    // Token y respuesta son documentos hoja (sin subcolecciones): delete directo.
    await surveyRef.collection('answers').doc(answerId(token, SURVEY_SALT.value())).delete();
    await surveyRef.collection('tokens').doc(token).delete();
    return { ok: true };
  },
);

/**
 * Reinicia las respuestas de una encuesta para volver a lanzarla tras un cambio:
 * borra las respuestas y marca los tokens como NO usados, MANTENIENDO los mismos
 * enlaces (la misma gente vuelve a poder contestar desde cero). Con `onlyTest`,
 * solo afecta a los tokens de prueba (deja intactas las respuestas reales).
 * Solo superadmin o People (assertSurveyManager). El cliente no puede tocar las
 * subcolecciones (reglas), así que esto va por Admin SDK.
 */
export const resetSurveyResponses = onCall(
  { region: 'europe-west1', secrets: [SURVEY_SALT] },
  async (request) => {
    await assertSurveyManager(request.auth?.uid);
    const surveyId = typeof request.data?.surveyId === 'string' ? request.data.surveyId.trim() : '';
    if (!surveyId) throw new HttpsError('invalid-argument', 'Falta el surveyId.');
    const onlyTest = request.data?.onlyTest === true;

    const db = getFirestore();
    const surveyRef = db.doc(`surveys/${surveyId}`);
    if (!(await surveyRef.get()).exists) throw new HttpsError('not-found', `Encuesta ${surveyId} no encontrada.`);

    const salt = SURVEY_SALT.value();
    const tokensSnap = await surveyRef.collection('tokens').get();
    const targetTokens = onlyTest ? tokensSnap.docs.filter((d) => d.data().test === true) : tokensSnap.docs;

    // Respuestas a borrar: con onlyTest, solo las de los tokens de prueba ya usados
    // (su answerId es HMAC del token); sin onlyTest, TODAS las respuestas.
    const answerRefs = onlyTest
      ? targetTokens.filter((d) => d.data().used === true).map((d) => surveyRef.collection('answers').doc(answerId(d.id, salt)))
      : (await surveyRef.collection('answers').get()).docs.map((d) => d.ref);

    // Ops: borrar respuestas + resetear tokens. Se commitea en lotes de 400
    // (el batch de Firestore admite hasta 500 operaciones).
    const ops = [
      ...answerRefs.map((ref) => ({ kind: 'del', ref })),
      ...targetTokens.map((d) => ({ kind: 'reset', ref: d.ref })),
    ];
    for (let i = 0; i < ops.length; i += 400) {
      const batch = db.batch();
      for (const op of ops.slice(i, i + 400)) {
        if (op.kind === 'del') batch.delete(op.ref);
        else batch.update(op.ref, { used: false, respondedAt: FieldValue.delete() });
      }
      await batch.commit();
    }
    return { ok: true, cleared: answerRefs.length, tokensReset: targetTokens.length, onlyTest };
  },
);

/** Verifica que el llamante es superadmin o gestor de encuestas; si no, lanza. */
async function assertSurveyManager(uid) {
  if (!uid) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
  if (!(await isAdmin(uid)) && !(await isSurveyAdmin(uid))) {
    throw new HttpsError('permission-denied', 'Solo un superadmin o gestor de encuestas puede enviar correos.');
  }
}

/**
 * Base pública de la instancia, derivada del proyecto EN EL SERVIDOR. Nunca se usa
 * un `origin` del cliente para componer los enlaces (evita convertir el envío en
 * un vector de phishing hacia un dominio arbitrario).
 */
function appBaseUrl() {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
  return `https://${projectId}.web.app`;
}

/**
 * Lee la encuesta, valida que esté ABIERTA (para que el enlace se pueda responder)
 * y que su plantilla de correo esté completa; devuelve sus datos.
 */
async function loadSurveyForEmail(db, surveyId, { requireOpen = true } = {}) {
  const ref = db.doc(`surveys/${surveyId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Encuesta no encontrada.');
  const survey = snap.data();
  // El envío MASIVO exige encuesta abierta; la PRUEBA no (RMR-TSK-0424): sirve
  // para verificar entrega y aspecto antes de abrir. La plantilla se valida
  // siempre.
  if (requireOpen && survey.status !== 'open') {
    throw new HttpsError('failed-precondition', 'Abre la encuesta antes de enviar los correos.');
  }
  const errors = emailTemplateErrors(survey.email ?? {});
  if (errors.length) throw new HttpsError('failed-precondition', errors[0]);
  return { ref, survey };
}

/**
 * Envía un correo de PRUEBA a un destinatario con un enlace de prueba (token
 * `test`): se puede rellenar, pero su respuesta NO cuenta en los agregados. Solo
 * superadmin/People. La encuesta debe estar abierta para poder responderlo.
 */
export const sendSurveyTestEmail = onCall(
  { region: 'europe-west1', secrets: [RESEND_API_KEY] },
  async (request) => {
    await assertSurveyManager(request.auth?.uid);
    const { surveyId, to } = request.data ?? {};
    if (!surveyId || !to) throw new HttpsError('invalid-argument', 'Faltan surveyId o to.');
    if (!String(to).includes('@')) throw new HttpsError('invalid-argument', 'El email de prueba no es válido.');
    const db = getFirestore();
    const { ref, survey } = await loadSurveyForEmail(db, surveyId, { requireOpen: false });
    const token = randomBytes(18).toString('hex');
    await ref.collection('tokens').doc(token).set({ email: to, metadata: {}, used: false, test: true });
    const link = `${appBaseUrl()}/encuesta?s=${surveyId}&t=${token}`;
    await sendResend({
      apiKey: RESEND_API_KEY.value(), from: MAIL_FROM,
      to, subject: survey.email.subject, text: renderEmailBody(survey.email.body, link),
    });
    return { ok: true, surveyOpen: survey.status === 'open' };
  },
);

/**
 * Envío MASIVO: manda a cada participante (token no de prueba) su enlace personal.
 * Secuencial y tolerante a fallos (cuenta enviados/fallidos). Solo superadmin/People.
 */
export const sendSurveyBulkEmails = onCall(
  { region: 'europe-west1', secrets: [RESEND_API_KEY], timeoutSeconds: 540 },
  async (request) => {
    await assertSurveyManager(request.auth?.uid);
    const { surveyId } = request.data ?? {};
    if (!surveyId) throw new HttpsError('invalid-argument', 'Falta surveyId.');
    const db = getFirestore();
    const { ref, survey } = await loadSurveyForEmail(db, surveyId);
    const tokens = await ref.collection('tokens').get();
    let sent = 0;
    let failed = 0;
    for (const doc of tokens.docs) {
      const data = doc.data();
      if (data.test === true || !data.email) continue; // los de prueba no se reenvían
      const link = `${appBaseUrl()}/encuesta?s=${surveyId}&t=${doc.id}`;
      try {
        await sendResend({
          apiKey: RESEND_API_KEY.value(), from: MAIL_FROM,
          to: data.email, subject: survey.email.subject, text: renderEmailBody(survey.email.body, link),
        });
        sent += 1;
      } catch {
        failed += 1;
      }
    }
    return { sent, failed };
  },
);

/**
 * Propuesta de preguntas para un periodo de O2O con IA. El cliente manda las
 * preguntas de periodos anteriores (guía o formulario) y Claude devuelve una
 * batería nueva. Usa tool-use para forzar JSON; el cliente la sanea antes de
 * volcarla al editor. Acceso: superadmin o líder (como refreshDora). El secreto
 * ANTHROPIC_API_KEY es de la instancia (`firebase functions:secrets:set`).
 */
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const O2O_AI_MODEL = 'claude-sonnet-4-6';
const O2O_GROUPS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Título del bloque temático.' },
      questions: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'questions'],
  },
};
const O2O_PREP_TOOL = {
  name: 'emit_o2o_prep',
  description: 'Devuelve la preparación completa del O2O: guía (durante) y formulario previo (antes), a la vez.',
  input_schema: {
    type: 'object',
    properties: {
      guide: {
        type: 'object',
        description: 'Guía de temas y preguntas para el líder DURANTE el O2O.',
        properties: { groups: O2O_GROUPS_SCHEMA },
        required: ['groups'],
      },
      form: {
        type: 'object',
        description: 'Formulario previo para que la persona reflexione ANTES del O2O.',
        properties: {
          intro: { type: 'string', description: 'Cabecera del formulario (lo que ve la persona).' },
          groups: O2O_GROUPS_SCHEMA,
        },
        required: ['groups'],
      },
    },
    required: ['guide', 'form'],
  },
};

/** Renderiza los grupos de una batería (guía o formulario) como markdown para el prompt. */
function renderO2OGroups(groups) {
  return (Array.isArray(groups) ? groups : [])
    .filter((g) => Array.isArray(g?.questions) && g.questions.length)
    .map((g) => `## ${g.title}\n${g.questions.map((q) => `- ${q}`).join('\n')}`)
    .join('\n');
}

/** Construye el prompt unificado (guía + formulario) con el histórico de O2O anteriores. */
function buildO2OPrompt(focus, previousPeriods) {
  const prev = (previousPeriods ?? [])
    .filter((p) => (Array.isArray(p?.guide) && p.guide.length) || (Array.isArray(p?.form) && p.form.length))
    .map((p) => {
      const guide = renderO2OGroups(p.guide);
      const form = renderO2OGroups(p.form);
      const parts = [];
      if (guide) parts.push(`### Guía (durante)\n${guide}`);
      if (form) parts.push(`### Formulario previo (antes)\n${form}`);
      return `# ${p.name || 'Periodo anterior'}\n${parts.join('\n\n')}`;
    })
    .join('\n\n');
  const context = prev
    ? `Histórico de O2O anteriores (guías y formularios ya usados):\n\n${prev}`
    : 'No hay O2O anteriores; propón una preparación inicial sólida.';
  const theFocus = focus?.trim()
    ? focus.trim()
    : 'un O2O centrado en la persona: cómo va su trabajo ahora, crecimiento y carrera, bienestar y carga, feedback mutuo, y obstáculos y apoyo que necesita';
  return `Eres experto en gestión de equipos de ingeniería y diseñas one-to-ones (O2O). Tu tarea: preparar el PRÓXIMO O2O generando DOS baterías coherentes entre sí:
1) el FORMULARIO PREVIO: temas para que la persona reflexione ANTES (con una breve cabecera motivadora), y
2) la GUÍA: temas y preguntas para que el líder conduzca la conversación DURANTE el O2O.
La guía debe recoger y profundizar lo que el formulario previo pide reflexionar; no deben ir por separado.

ENFOQUE del O2O: ${theFocus}.

${context}

HILO CONDUCTOR: este O2O CONTINÚA a los anteriores, no empieza de cero. Retoma los temas que quedaron abiertos y haz evolucionar la conversación. NO repitas las preguntas ya usadas en O2O anteriores —salvo que quieras medir la evolución de algo concreto; en ese caso, reformúlala dejando claro que se compara con la vez anterior—.

Criterios: preguntas abiertas y concretas, en español, agrupadas en 3-6 bloques temáticos por batería (2-5 preguntas por bloque), cubriendo los ejes del enfoque sin forzarlos todos si no aplican. Llama a la herramienta emit_o2o_prep con el resultado.`;
}

export const o2oProposeQuestions = onCall(
  { region: 'europe-west1', secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');

    const focus = typeof request.data?.focus === 'string' ? request.data.focus : '';
    const previousPeriods = Array.isArray(request.data?.previousPeriods) ? request.data.previousPeriods : [];

    const db = getFirestore();
    const [adminSnap, leaderSnap] = await Promise.all([
      db.doc(`admins/${uid}`).get(),
      db.doc(`leaders/${uid}`).get(),
    ]);
    if (!adminSnap.exists && !leaderSnap.exists) {
      throw new HttpsError('permission-denied', 'Solo un líder o superadmin puede generar preguntas.');
    }

    const apiKey = ANTHROPIC_API_KEY.value();
    if (!apiKey) throw new HttpsError('failed-precondition', 'La IA no está configurada en esta instancia.');

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: O2O_AI_MODEL,
          max_tokens: 3000,
          tools: [O2O_PREP_TOOL],
          tool_choice: { type: 'tool', name: 'emit_o2o_prep' },
          messages: [{ role: 'user', content: buildO2OPrompt(focus, previousPeriods) }],
        }),
      });
    } catch {
      throw new HttpsError('unavailable', 'No se pudo contactar con la IA. Inténtalo de nuevo.');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`Anthropic error ${res.status}: ${detail}`);
      throw new HttpsError('internal', 'La IA no pudo generar la preparación.');
    }
    const payload = await res.json();
    const block = (payload.content ?? []).find((c) => c.type === 'tool_use');
    if (!block) throw new HttpsError('internal', 'La IA no devolvió una propuesta válida.');
    return { proposal: block.input };
  },
);

// ── DORA ───────────────────────────────────────────────────────────────────
const MS_HOUR = 3_600_000;
const toMs = (d) => new Date(d).getTime();
const round1 = (n) => Math.round(n * 10) / 10;

/** Métricas DORA de un repo a partir de sus PRs mergeados (espejo de src/tools/dora/domain/metrics.js). */
function computeRepoMetrics(mergedPrs, from, to) {
  const fromMs = toMs(from);
  const toMs2 = toMs(to);
  const lead = mergedPrs
    .map((p) => (toMs(p.mergedAt) - toMs(p.createdAt)) / MS_HOUR)
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const deployments = mergedPrs.length;
  const weeks = Math.max(1, (toMs2 - fromMs) / (7 * 24 * MS_HOUR));
  const contributorLogins = [...new Set(mergedPrs.map((p) => (p.author ?? '').trim()).filter(Boolean))].sort();
  return {
    deployments,
    deployFrequencyPerWeek: round1(deployments / weeks),
    leadTimeHoursAvg: lead.length ? round1(lead.reduce((s, h) => s + h, 0) / lead.length) : null,
    leadTimeHoursMedian: lead.length ? round1(lead[Math.floor((lead.length - 1) / 2)]) : null,
    contributors: contributorLogins.length,
    contributorLogins,
  };
}

/**
 * Token de GitHub (secreto de la instancia). GREBLA es 1 instancia por
 * organización (multi-leader), así que este secreto es de la org y NO acopla el
 * código a ninguna en concreto: cada instancia configura su valor con
 * `firebase functions:secrets:set DORA_GITHUB_TOKEN`. Con token, la API sube de
 * 60/h públicos a 5000/h y accede a repos PRIVADOS; sin él, se cae a la pública.
 */
const DORA_GITHUB_TOKEN = defineSecret('DORA_GITHUB_TOKEN');

/** Cabeceras de GitHub; añade `Authorization: Bearer` si hay token (repos privados). */
function ghHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'grebla-dora' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Mensaje legible según el código de estado de GitHub. */
function githubError(status, fullName, hasToken) {
  if (status === 404) {
    return new Error(hasToken
      ? `Repo no encontrado o el token no tiene acceso: ${fullName}.`
      : `Repo no encontrado o privado: ${fullName} (los privados necesitan token).`);
  }
  if (status === 401) return new Error('Token de GitHub inválido o caducado (DORA_GITHUB_TOKEN).');
  if (status === 403) {
    return new Error(hasToken
      ? `Sin permiso o límite de la API de GitHub para ${fullName} (revisa el scope del token).`
      : 'Límite de la API pública de GitHub (60/h sin token). Configura DORA_GITHUB_TOKEN.');
  }
  return new Error(`GitHub respondió ${status} para ${fullName}.`);
}

/** Fecha de creación del repo (para medir "desde el principio" cuando no hay fecha). */
async function fetchRepoCreatedAt(fullName, headers) {
  const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers });
  if (!res.ok) throw githubError(res.status, fullName, Boolean(headers.Authorization));
  const data = await res.json();
  return data.created_at || '2008-01-01T00:00:00Z';
}

/** PRs mergeados a `baseBranch` de un repo desde `sinceMs`. Con token lee privados. */
async function fetchMergedPrs(fullName, sinceMs, baseBranch, headers) {
  const base = encodeURIComponent(baseBranch || 'main');
  const url = `https://api.github.com/repos/${fullName}/pulls?state=closed&base=${base}&per_page=100&sort=updated&direction=desc`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw githubError(res.status, fullName, Boolean(headers.Authorization));
  const arr = await res.json();
  return (Array.isArray(arr) ? arr : [])
    .filter((p) => p.merged_at && toMs(p.merged_at) >= sinceMs)
    // `number` se conserva para poder pedir después el primer commit del PR (lead time real).
    .map((p) => ({ number: p.number, createdAt: p.created_at, mergedAt: p.merged_at, author: p.user?.login || '' }));
}

/**
 * Fecha del PRIMER commit de un PR (el más antiguo). La API pública devuelve los
 * commits en orden ascendente, así que el primero del listado es el más antiguo.
 * Pedimos solo 1 (`per_page=1`) para gastar la mínima cuota. Prioriza la fecha
 * del committer y cae a la del author si falta. 1 llamada por PR.
 * @param {string} fullName  owner/repo
 * @param {number} prNumber
 * @returns {Promise<string>}  fecha ISO del primer commit ('' si no se obtiene)
 */
async function fetchFirstCommitDate(fullName, prNumber, headers) {
  const res = await fetch(
    `https://api.github.com/repos/${fullName}/pulls/${prNumber}/commits?per_page=1`,
    { headers },
  );
  if (!res.ok) throw githubError(res.status, fullName, Boolean(headers.Authorization));
  const arr = await res.json();
  const commit = (Array.isArray(arr) ? arr[0] : null)?.commit;
  return commit?.committer?.date ?? commit?.author?.date ?? '';
}

/**
 * Lead time DORA REAL (primer commit → despliegue en producción). Duplica la
 * lógica pura de src/tools/dora/domain/leadTime.js (functions/ no importa de
 * src/, igual que computeRepoMetrics es espejo de metrics.js). Casa cada cambio
 * con el PRIMER despliegue 'success' cuyo `at >= mergedAt`; sin despliegue
 * posterior el cambio queda PENDIENTE. Descarta lead times negativos/no finitos.
 * @param {{ firstCommitAt: string, mergedAt: string }[]} changes
 * @param {{ at: string, status: string }[]} deployments
 * @returns {{ leadTimeHoursAvg: number|null, leadTimeHoursMedian: number|null, deployedCount: number, pendingCount: number }}
 */
function computeLeadTimeCommitDeploy(changes, deployments) {
  const successAtMs = (Array.isArray(deployments) ? deployments : [])
    .filter((d) => d?.status === 'success')
    .map((d) => toMs(d.at))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const leadHours = [];
  let pendingCount = 0;
  for (const change of Array.isArray(changes) ? changes : []) {
    const mergedMs = toMs(change?.mergedAt);
    const firstCommitMs = toMs(change?.firstCommitAt);
    if (!Number.isFinite(mergedMs) || !Number.isFinite(firstCommitMs)) {
      pendingCount += 1;
      continue;
    }
    const deployAtMs = successAtMs.find((t) => t >= mergedMs);
    if (deployAtMs === undefined) {
      pendingCount += 1;
      continue;
    }
    const hours = (deployAtMs - firstCommitMs) / MS_HOUR;
    if (Number.isFinite(hours) && hours >= 0) leadHours.push(hours);
  }

  leadHours.sort((a, b) => a - b);
  const deployedCount = leadHours.length;
  return {
    leadTimeHoursAvg: deployedCount ? round1(leadHours.reduce((s, h) => s + h, 0) / deployedCount) : null,
    leadTimeHoursMedian: deployedCount ? round1(leadHours[Math.floor((deployedCount - 1) / 2)]) : null,
    deployedCount,
    pendingCount,
  };
}

/**
 * Change Failure Rate DORA D3 (espejo de src/tools/dora/domain/changeFailureRate.js;
 * functions/ no importa de src/). Sobre los eventos de despliegue cuyo `at` cae
 * en [from, to] (inclusivo): CFR = fallidos / total × 100. Todos son de
 * 'production'. Sin despliegues en la ventana → cfrPct null (no medible; nunca 0).
 * @param {{ at: string, status: string }[]} deployments
 * @param {string} from  inicio del periodo (ISO)
 * @param {string} to    fin del periodo (ISO)
 * @returns {{ cfrPct: number|null, failed: number, total: number }}
 */
function computeChangeFailureRate(deployments, from, to) {
  const fromMs = toMs(from);
  const toMs2 = toMs(to);
  const inWindow = (Array.isArray(deployments) ? deployments : []).filter((e) => {
    const atMs = toMs(e?.at);
    return Number.isFinite(atMs) && atMs >= fromMs && atMs <= toMs2;
  });
  const total = inWindow.length;
  const failed = inWindow.filter((e) => e?.status === 'failed').length;
  return { cfrPct: total > 0 ? round1((failed / total) * 100) : null, failed, total };
}

/**
 * Mean Time to Recovery DORA D4 (espejo de src/tools/dora/domain/mttr.js;
 * functions/ no importa de src/). MTTR = downtime total ÷ nº de incidentes
 * resueltos. Un incidente RESUELTO tiene `restoredAt` no nulo; solo cuentan los
 * resueltos cuyo `restoredAt` cae en [from, to] (inclusivo). Downtime de cada uno
 * = (restoredAt − startedAt)/hora, descartando negativos/no finitos. Los abiertos
 * (`restoredAt` null) se reportan aparte. Sin resueltos → mttrHoursAvg null.
 * @param {{ startedAt: string, restoredAt: string|null }[]} incidents
 * @param {string} from  inicio del periodo (ISO)
 * @param {string} to    fin del periodo (ISO)
 * @returns {{ mttrHoursAvg: number|null, downtimeHoursTotal: number, incidentsResolved: number, incidentsOpen: number }}
 */
function computeMeanTimeToRecovery(incidents, from, to) {
  const fromMs = toMs(from);
  const toMs2 = toMs(to);
  let downtimeHoursTotal = 0;
  let incidentsResolved = 0;
  let incidentsOpen = 0;
  for (const inc of Array.isArray(incidents) ? incidents : []) {
    if (inc?.restoredAt == null) {
      incidentsOpen += 1;
      continue;
    }
    const restoredMs = toMs(inc.restoredAt);
    if (!Number.isFinite(restoredMs) || restoredMs < fromMs || restoredMs > toMs2) continue;
    const startedMs = toMs(inc?.startedAt);
    const hours = (restoredMs - startedMs) / MS_HOUR;
    if (!Number.isFinite(hours) || hours < 0) continue;
    downtimeHoursTotal += hours;
    incidentsResolved += 1;
  }
  return {
    mttrHoursAvg: incidentsResolved > 0 ? round1(downtimeHoursTotal / incidentsResolved) : null,
    downtimeHoursTotal: round1(downtimeHoursTotal),
    incidentsResolved,
    incidentsOpen,
  };
}

/**
 * Tope de PRs por repo a los que pedimos el primer commit (lead time exacto).
 * Sin token se queda bajo para no agotar la cuota pública (60/h); CON token el
 * llamante sube el tope (5000/h), ver `maxLookups` en refreshDora. Por encima
 * del tope, el lead time de esa PR se aproxima.
 */
const MAX_COMMIT_LOOKUPS = 50;

/**
 * Despliegues observados como runs de un workflow de GitHub Actions
 * (deploySignal='workflow'): el job nocturno de Fastlane, un push→Cloud Run, etc.
 * SOLO LECTURA (GET). Devuelve runs completados en la ventana, separando
 * exitosos de fallidos para poder derivar el Change Failure Rate.
 * @returns {Promise<{ success: number, failed: number }>}
 */
async function fetchWorkflowRunCounts(fullName, workflowFile, sinceMs, toMs2, headers) {
  const file = String(workflowFile ?? '').trim();
  if (!file) return { success: 0, failed: 0 };
  const created = `>=${new Date(sinceMs).toISOString().slice(0, 10)}`;
  const url = `https://api.github.com/repos/${fullName}/actions/workflows/${encodeURIComponent(file)}`
    + `/runs?per_page=100&status=completed&created=${encodeURIComponent(created)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw githubError(res.status, fullName, Boolean(headers.Authorization));
  const body = await res.json();
  let success = 0;
  let failed = 0;
  for (const run of body.workflow_runs ?? []) {
    const at = Date.parse(run.updated_at ?? run.created_at ?? '');
    if (!Number.isFinite(at) || at < sinceMs || at > toMs2) continue;
    if (run.conclusion === 'success') success += 1;
    else if (run.conclusion === 'failure') failed += 1;
  }
  return { success, failed };
}

/** Nº de releases publicados de un repo en [sinceMs, toMs2] (despliegue real). */
async function fetchReleaseCount(fullName, sinceMs, toMs2, headers) {
  const res = await fetch(`https://api.github.com/repos/${fullName}/releases?per_page=100`, { headers });
  if (!res.ok) throw githubError(res.status, fullName, Boolean(headers.Authorization));
  const arr = await res.json();
  return (Array.isArray(arr) ? arr : []).filter((r) => {
    if (!r.published_at) return false;
    const t = toMs(r.published_at);
    return t >= sinceMs && t <= toMs2;
  }).length;
}

/** Señal de deploy normalizada (espejo de normalizeDeploySignal de usecases.js). */
function normalizeSignal(v) {
  return ['release', 'tag', 'workflow', 'manual'].includes(v) ? v : 'branch';
}

/** Tope de tags a los que resolvemos la fecha del commit (mitiga el rate-limit). */
const MAX_TAG_LOOKUPS = 100;

/**
 * Nº de tags que casan `pattern` cuyo commit cae en [sinceMs, toMs2] (despliegue
 * real por tag: hoop-api `YYYY.MM.DD.N`, tribbu-infra `prod-*`). Los tags de
 * GitHub NO llevan fecha, así que se resuelve la del commit apuntado (1 llamada
 * por tag, hasta el tope). Sin patrón → 0 (no se cuentan tags indiscriminados).
 * Solo la primera página de 100 tags: en repos con muchísimos tags los más
 * antiguos pueden quedar fuera (aproximación documentada, como leadTimeApproxCount).
 */
async function fetchTagCount(fullName, sinceMs, toMs2, pattern, headers) {
  if (!pattern) return 0;
  let re;
  try {
    re = new RegExp(pattern);
  } catch {
    return 0;
  }
  const res = await fetch(`https://api.github.com/repos/${fullName}/tags?per_page=100`, { headers });
  if (!res.ok) throw githubError(res.status, fullName, Boolean(headers.Authorization));
  const arr = await res.json();
  const matching = (Array.isArray(arr) ? arr : []).filter((t) => re.test(t.name)).slice(0, MAX_TAG_LOOKUPS);
  let count = 0;
  for (const tag of matching) {
    const sha = tag.commit?.sha;
    if (!sha) continue;
    try {
      const cRes = await fetch(`https://api.github.com/repos/${fullName}/commits/${sha}`, { headers });
      if (!cRes.ok) continue;
      const commit = (await cRes.json()).commit;
      const at = toMs(commit?.committer?.date ?? commit?.author?.date);
      if (Number.isFinite(at) && at >= sinceMs && at <= toMs2) count += 1;
    } catch {
      // tag no resoluble (borrado, rate-limit puntual…): se omite del recuento
    }
  }
  return count;
}

/**
 * Calcula y guarda las métricas DORA de los repos de la instancia (modelo
 * multi-leader). Acceso: superadmin o líder. Usa el token DORA_GITHUB_TOKEN si
 * está configurado (repos privados, 5000/h); si no, la API pública (60/h, solo
 * públicos).
 */
export const refreshDora = onCall(
  { region: 'europe-west1', secrets: [DORA_GITHUB_TOKEN], timeoutSeconds: 300 },
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');

  // Token de la org (opcional): con él se leen privados y sube el rate-limit.
  const token = DORA_GITHUB_TOKEN.value() || '';
  const headers = ghHeaders(token);
  // Con token (5000/h) podemos pedir el primer commit de muchos más PRs.
  const maxLookups = token ? 200 : MAX_COMMIT_LOOKUPS;

  const db = getFirestore();
  // Acceso: superadmin o líder de la instancia.
  const [adminSnap, leaderSnap] = await Promise.all([
    db.doc(`admins/${uid}`).get(),
    db.doc(`leaders/${uid}`).get(),
  ]);
  if (!adminSnap.exists && !leaderSnap.exists) {
    throw new HttpsError('permission-denied', 'No tienes acceso a esta organización.');
  }

  const reposSnap = await db.collection('dora').get();
  const now = new Date().toISOString();
  const results = [];

  for (const docSnap of reposSnap.docs) {
    const repo = docSnap.data();
    try {
      // Sin fecha → desde la creación del repo en GitHub.
      const from = repo.startDate || (await fetchRepoCreatedAt(repo.fullName, headers));
      // Lead time y personas siempre desde los PR mergeados a la rama base.
      const prs = await fetchMergedPrs(repo.fullName, toMs(from), repo.baseBranch || 'main', headers);
      const metrics = computeRepoMetrics(prs, from, now);

      // Eventos de despliegue reales del repo (Admin SDK). Fuente para la señal
      // 'manual' y para lead time real, CFR y MTTR (se reutiliza más abajo).
      const deploySnap = await docSnap.ref.collection('deployments').get();
      const deployEvents = deploySnap.docs.map((d) => d.data());

      // Frecuencia de despliegue según la señal REAL del repo (no ramas de entorno):
      //  branch  → merges a la rama base (lo que ya calcula computeRepoMetrics)
      //  release → GitHub Releases · tag → tags que casan tagPattern
      //  manual  → deploy fuera de GitHub: solo eventos 'success' registrados
      const signal = normalizeSignal(repo.deploySignal);
      const weeks = Math.max(1, (toMs(now) - toMs(from)) / (7 * 24 * MS_HOUR));
      if (signal === 'release') {
        const releases = await fetchReleaseCount(repo.fullName, toMs(from), toMs(now), headers);
        metrics.deployments = releases;
        metrics.deployFrequencyPerWeek = round1(releases / weeks);
      } else if (signal === 'tag') {
        const tags = await fetchTagCount(repo.fullName, toMs(from), toMs(now), repo.tagPattern || '', headers);
        metrics.deployments = tags;
        metrics.deployFrequencyPerWeek = round1(tags / weeks);
      } else if (signal === 'workflow') {
        // El despliegue es un JOB de Actions (nocturno de Fastlane, push→Cloud
        // Run…): cada run exitoso es un despliegue y los fallidos dan el CFR sin
        // registrar nada a mano.
        const runs = await fetchWorkflowRunCounts(
          repo.fullName, repo.workflowFile, toMs(from), toMs(now), headers,
        );
        metrics.deployments = runs.success;
        metrics.deployFrequencyPerWeek = round1(runs.success / weeks);
        metrics.workflowRunsFailed = runs.failed;
      } else if (signal === 'manual') {
        const successInWindow = deployEvents.filter((e) => {
          const at = toMs(e?.at);
          return e?.status === 'success' && Number.isFinite(at) && at >= toMs(from) && at <= toMs(now);
        }).length;
        metrics.deployments = successInWindow;
        metrics.deployFrequencyPerWeek = round1(successInWindow / weeks);
      }
      metrics.deploySignal = signal;

      // ── Lead time REAL (primer commit → despliegue en producción, DORA D2) ──
      // El "inicio" es el primer commit de cada PR; el "fin" es el despliegue real
      // registrado (D1). Se conserva el proxy PR→merge (leadTimeHoursAvg) intacto.
      //
      // Rate-limit (CRÍTICO): la API pública permite 60 req/h por IP sin token y
      // cada PR consume 1 llamada. Por eso: (1) solo pedimos el primer commit de
      // los MAX_COMMIT_LOOKUPS PRs más recientes (prs viene ordenado por
      // updated desc); el resto aproxima con `createdAt`. (2) Cada llamada va en
      // try/catch: si falla (403/límite u otro), se aproxima con `createdAt`.
      // `leadTimeApproxCount` cuenta cuántos primeros commits son aproximados.
      //
      // OPTIMIZACIÓN: el lead time real solo se puede calcular si hay despliegues
      // 'success' registrados con los que casar los cambios; sin ellos TODO queda
      // pendiente. Por eso, si el repo no tiene despliegues registrados, NO pedimos
      // el primer commit de cada PR (serían decenas de llamadas por repo, tiradas):
      // evita agotar el rate-limit y el timeout de la function.
      const hasSuccessEvents = deployEvents.some((e) => e?.status === 'success');
      let leadTimeApproxCount = 0;
      const changes = [];
      if (hasSuccessEvents) {
        for (const [i, pr] of prs.entries()) {
          let firstCommitAt = pr.createdAt; // aproximación por defecto
          if (i < maxLookups) {
            try {
              const commitDate = await fetchFirstCommitDate(repo.fullName, pr.number, headers);
              if (commitDate) firstCommitAt = commitDate;
              else leadTimeApproxCount += 1; // respuesta sin fecha → aproximado
            } catch {
              leadTimeApproxCount += 1; // rate-limit u otro error → aproximado
            }
          } else {
            leadTimeApproxCount += 1; // por encima del tope → aproximado
          }
          changes.push({ firstCommitAt, mergedAt: pr.mergedAt });
        }
      } else {
        // Sin despliegues registrados: no hay lead time real (todo pendiente). Se
        // aproxima el inicio con createdAt sin gastar llamadas.
        for (const pr of prs) changes.push({ firstCommitAt: pr.createdAt, mergedAt: pr.mergedAt });
        leadTimeApproxCount = prs.length;
      }

      // Lead time real usa los eventos ya cargados arriba (deployEvents).
      const realLead = computeLeadTimeCommitDeploy(changes, deployEvents);
      metrics.leadTimeCommitDeployHoursAvg = realLead.leadTimeHoursAvg;
      metrics.leadTimeCommitDeployHoursMedian = realLead.leadTimeHoursMedian;
      metrics.changesDeployed = realLead.deployedCount;
      metrics.changesPending = realLead.pendingCount;

      // ── Change Failure Rate (DORA D3) ──────────────────────────────────────
      // % de despliegues a producción que fallan (requieren remediación).
      // Reutiliza `deployEvents` YA cargado (no se relee la subcolección). Si no
      // hay despliegues registrados, cfrPct = null y los contadores quedan en 0.
      const cfr = computeChangeFailureRate(deployEvents, from, now);
      metrics.changeFailureRatePct = cfr.cfrPct;
      metrics.deploymentsFailed = cfr.failed;
      metrics.deploymentsTotal = cfr.total;
      // Con señal 'workflow' el CFR sale de los propios runs (fallidos/total) si
      // no se han registrado despliegues a mano: es observable, no hay que
      // teclear nada. Los eventos manuales, si los hay, mandan sobre esto.
      if (signal === 'workflow' && cfr.total === 0) {
        const failed = metrics.workflowRunsFailed ?? 0;
        const total = (metrics.deployments ?? 0) + failed;
        if (total > 0) {
          metrics.deploymentsFailed = failed;
          metrics.deploymentsTotal = total;
          metrics.changeFailureRatePct = round1((failed / total) * 100);
        }
      }
      metrics.leadTimeApproxCount = leadTimeApproxCount;

      // ── Mean Time to Recovery (DORA D4) ─────────────────────────────────────
      // Tiempo medio de recuperación tras un incidente en producción, sobre los
      // incidentes registrados manualmente (subcolección /incidents del repo,
      // espejo de /deployments). Admin SDK: omite reglas.
      const incidentsSnap = await docSnap.ref.collection('incidents').get();
      const incidents = incidentsSnap.docs.map((d) => d.data());
      const mttr = computeMeanTimeToRecovery(incidents, from, now);
      metrics.mttrHoursAvg = mttr.mttrHoursAvg;
      metrics.downtimeHoursTotal = mttr.downtimeHoursTotal;
      metrics.incidentsResolved = mttr.incidentsResolved;
      metrics.incidentsOpen = mttr.incidentsOpen;

      await docSnap.ref.set({ metrics: { ...metrics, periodFrom: from, periodTo: now, computedAt: now } }, { merge: true });
      results.push({ repo: repo.fullName, ok: true, ...metrics });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await docSnap.ref.set({ metrics: { error: message, computedAt: now } }, { merge: true });
      results.push({ repo: repo.fullName, ok: false, error: message });
    }
  }

  return { computedAt: now, results };
});

// ── LEAN / Flujo (métricas de flujo del equipo desde Linear) ─────────────────
const LINEAR_API_KEY = defineSecret('LINEAR_API_KEY');
const FLOW_HOUR = 3_600_000;
const FLOW_DAY = 24 * FLOW_HOUR;
const flowRound1 = (n) => Math.round(n * 10) / 10;

/** Percentil por interpolación lineal (espejo de src/tools/lean/domain/metrics.js). */
function flowPercentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/** Métricas de flujo de un equipo (espejo de src/tools/lean/domain/metrics.js). */
function computeFlowMetricsFn(issues, period) {
  const list = Array.isArray(issues) ? issues : [];
  const fromMs = new Date(period.from).getTime();
  const toMs = new Date(period.to).getTime();
  const nowMs = period.now != null ? new Date(period.now).getTime() : toMs;
  const t = (d) => new Date(d).getTime();
  const completed = list.filter(
    (i) => i.stateType === 'completed' && i.completedAt && t(i.completedAt) >= fromMs && t(i.completedAt) <= toMs,
  );
  const weeks = Math.max(1, (toMs - fromMs) / (7 * FLOW_DAY));
  const cycle = completed
    .map((i) => (i.startedAt && i.completedAt ? (t(i.completedAt) - t(i.startedAt)) / FLOW_HOUR : NaN))
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const wipIssues = list.filter((i) => i.stateType === 'started');
  const agingDays = wipIssues
    .map((i) => (i.startedAt ? (nowMs - t(i.startedAt)) / FLOW_DAY : NaN))
    .filter((d) => Number.isFinite(d) && d >= 0);
  // Top-3 issues en curso más antiguas (con enlace a Linear); espejo del dominio.
  const oldestWip = wipIssues
    .filter((i) => i.startedAt)
    .map((i) => ({ issue: i, days: (nowMs - t(i.startedAt)) / FLOW_DAY }))
    .filter((x) => Number.isFinite(x.days) && x.days >= 0)
    .sort((a, b) => b.days - a.days)
    .slice(0, 3)
    .map((x) => ({
      identifier: x.issue.identifier ?? x.issue.id,
      url: x.issue.url ?? null,
      title: x.issue.title ?? '',
      agingDays: flowRound1(x.days),
      // Columna de Linear: sin ella un atasco de 10 d en «In Review» se lee
      // igual que en «In Progress», y no es lo mismo (RMR-TSK-0271).
      stateName: x.issue.stateName ?? null,
    }));
  const p50 = flowPercentile(cycle, 0.5);
  const p85 = flowPercentile(cycle, 0.85);
  return {
    completed: completed.length,
    throughputPerWeek: flowRound1(completed.length / weeks),
    cycleTimeP50Hours: p50 == null ? null : flowRound1(p50),
    cycleTimeP85Hours: p85 == null ? null : flowRound1(p85),
    wip: wipIssues.length,
    agingDaysMax: agingDays.length ? flowRound1(Math.max(...agingDays)) : null,
    agingDaysAvg: agingDays.length ? flowRound1(agingDays.reduce((s, d) => s + d, 0) / agingDays.length) : 0,
    oldestWip,
    flowEfficiencyPct: flowEfficiencyFn(completed),
  };
}

const LINEAR_ISSUES_QUERY = `
  query Issues($filter: IssueFilter, $after: String) {
    issues(first: 100, after: $after, filter: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier url title createdAt startedAt completedAt canceledAt state { type name }
        history(first: 50) { nodes { toState { type name } createdAt } }
      }
    }
  }`;

// Nombres de estado `started` de Linear que cuentan como TRABAJO ACTIVO (touch time).
// Criterio estricto: review/QA/colas/bloqueos son espera. Espejo de ACTIVE_STATE_NAMES
// en src/tools/lean/domain/flowEfficiency.js.
const LEAN_ACTIVE_STATE_NAMES = new Set(['doing', 'in progress', 'breakdown parents']);
const leanIsActiveWork = (stateType, stateName) =>
  stateType === 'started' && LEAN_ACTIVE_STATE_NAMES.has(String(stateName ?? '').trim().toLowerCase());

/** Tiempo activo y total (started→completed) de una issue (espejo de flowEfficiency.js). */
function flowActiveAndTotalFn(issue) {
  const started = new Date(issue.startedAt).getTime();
  const completed = new Date(issue.completedAt).getTime();
  if (!(Number.isFinite(started) && Number.isFinite(completed) && completed > started)) {
    return { activeMs: 0, totalMs: 0 };
  }
  const trans = (issue.transitions ?? [])
    .map((t) => ({ active: leanIsActiveWork(t.stateType, t.stateName), at: new Date(t.at).getTime() }))
    .filter((t) => Number.isFinite(t.at))
    .sort((a, b) => a.at - b.at);
  let current = true;
  const before = trans.filter((t) => t.at <= started);
  if (before.length) current = before[before.length - 1].active;
  let active = 0;
  let cursor = started;
  for (const t of trans) {
    if (t.at <= started || t.at >= completed) continue;
    if (current) active += t.at - cursor;
    cursor = t.at;
    current = t.active;
  }
  if (current) active += completed - cursor;
  return { activeMs: active, totalMs: completed - started };
}

/** Flow efficiency agregada (% activo/total) de un conjunto de issues (espejo del dominio). */
function flowEfficiencyFn(issues) {
  let active = 0;
  let total = 0;
  for (const issue of issues ?? []) {
    const { activeMs, totalMs } = flowActiveAndTotalFn(issue);
    active += activeMs;
    total += totalMs;
  }
  return total > 0 ? Math.round((active / total) * 1000) / 10 : null;
}

/**
 * Qué mide una unidad de flujo (espejo de src/tools/lean/domain/source.js).
 * El EQUIPO manda sobre el label cuando están los dos: es el filtro más
 * específico, y mezclarlos contaría dos veces lo mismo.
 */
function unitSourceFn(unit) {
  const team = String(unit?.linearTeamKey ?? '').trim();
  if (team) return { kind: 'team', value: team };
  const label = String(unit?.linearLabel ?? '').trim();
  if (label) return { kind: 'label', value: label };
  return { kind: 'none', value: '' };
}

/**
 * Filtro de issues para Linear, o `null` si la unidad no tiene nada que medir.
 * Ese `null` importa: preguntar SIN filtro trae el workspace entero, y así fue
 * como una unidad sin label acabó con 243 completadas y 101 WIP que parecían
 * las de un equipo.
 */
function linearIssueFilterFn(unit, sinceIso) {
  const { kind, value } = unitSourceFn(unit);
  const updatedAt = { gte: sinceIso };
  if (kind === 'team') return { team: { key: { eq: value } }, updatedAt };
  if (kind === 'label') return { labels: { name: { eq: value } }, updatedAt };
  return null;
}

/** Cómo se nombra la fuente de una unidad en mensajes y logs. */
function sourceLabelFn(unit) {
  const { kind, value } = unitSourceFn(unit);
  if (kind === 'team') return `Equipo ${value}`;
  if (kind === 'label') return `Label «${value}»`;
  return 'Sin fuente';
}

/** Trae las issues que casan con un FILTRO de Linear (paginado, GraphQL). */
async function fetchLinearIssues(filter, apiKey) {
  const out = [];
  let after = null;
  for (let page = 0; page < 50; page += 1) { // tope de seguridad (~5000 issues)
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query: LINEAR_ISSUES_QUERY, variables: { filter, after } }),
    });
    if (!res.ok) throw new Error(`Linear respondió ${res.status}.`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0]?.message || 'Error de la API de Linear.');
    const conn = json.data?.issues;
    if (!conn) break;
    for (const n of conn.nodes) {
      out.push({
        id: n.id,
        identifier: n.identifier ?? n.id,
        url: n.url ?? null,
        title: n.title ?? '',
        stateType: n.state?.type ?? 'backlog',
        stateName: n.state?.name ?? null,
        createdAt: n.createdAt,
        startedAt: n.startedAt ?? null,
        completedAt: n.completedAt ?? null,
        canceledAt: n.canceledAt ?? null,
        transitions: (n.history?.nodes ?? [])
          .map((h) => ({ stateType: h.toState?.type ?? null, stateName: h.toState?.name ?? null, at: h.createdAt }))
          .filter((t) => t.stateType && t.at),
      });
    }
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

// ── Scrum Poker: backlog de un squad para refinar (RMR-TSK-0322) ─────────────
const LINEAR_BACKLOG_QUERY = `
  query Backlog($filter: IssueFilter, $after: String) {
    issues(first: 100, after: $after, filter: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes { id identifier url title sortOrder estimate state { type name } }
    }
  }`;

/** Backlog de un LABEL de Linear (triage/backlog/unstarted), ordenado por sortOrder (orden manual del backlog). */
async function fetchLinearBacklog(label, apiKey) {
  const filter = { labels: { name: { eq: label } }, state: { type: { in: ['triage', 'backlog', 'unstarted'] } } };
  const out = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query: LINEAR_BACKLOG_QUERY, variables: { filter, after } }),
    });
    if (!res.ok) throw new Error(`Linear respondió ${res.status}.`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0]?.message || 'Error de la API de Linear.');
    const conn = json.data?.issues;
    if (!conn) break;
    for (const n of conn.nodes) {
      out.push({
        id: n.id,
        identifier: n.identifier ?? n.id,
        url: n.url ?? null,
        title: n.title ?? '',
        estimate: n.estimate ?? null,
        stateType: n.state?.type ?? 'backlog',
        stateName: n.state?.name ?? null,
        sortOrder: typeof n.sortOrder === 'number' ? n.sortOrder : 0,
      });
    }
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Lista el backlog de un squad (label de Linear) para elegir qué refinar. Acceso: superadmin o líder. */
export const listSquadBacklog = onCall(
  { region: 'europe-west1', secrets: [LINEAR_API_KEY], timeoutSeconds: 120 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
    const db = getFirestore();
    const leaderSnap = await db.doc(`leaders/${uid}`).get();
    if (!(await isAdmin(uid)) && !leaderSnap.exists) {
      throw new HttpsError('permission-denied', 'Solo un manager o superadmin puede listar el backlog.');
    }
    const label = String(request.data?.linearLabel ?? '').trim();
    if (!label) throw new HttpsError('invalid-argument', 'Falta el squad (linearLabel).');
    const tasks = await fetchLinearBacklog(label, LINEAR_API_KEY.value());
    return { tasks };
  },
);

/**
 * Recalcula las métricas de flujo (LEAN) de todos los equipos de `/leanTeams` desde
 * Linear (ventana de 8 semanas). Acceso: superadmin o líder (como refreshDora). El
 * secreto LINEAR_API_KEY es de la instancia.
 */
export const refreshLean = onCall(
  { region: 'europe-west1', secrets: [LINEAR_API_KEY], timeoutSeconds: 300 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');

    const db = getFirestore();
    const [adminSnap, leaderSnap] = await Promise.all([
      db.doc(`admins/${uid}`).get(),
      db.doc(`leaders/${uid}`).get(),
    ]);
    if (!adminSnap.exists && !leaderSnap.exists) {
      throw new HttpsError('permission-denied', 'No tienes acceso a esta organización.');
    }

    const apiKey = LINEAR_API_KEY.value();
    if (!apiKey) throw new HttpsError('failed-precondition', 'Linear no está configurado en esta instancia.');

    const now = new Date();
    const to = now.toISOString();
    const from = new Date(now.getTime() - 8 * 7 * FLOW_DAY).toISOString(); // 8 semanas

    const unitsSnap = await db.collection('leanTeams').get();
    const results = [];
    for (const docSnap of unitsSnap.docs) {
      const unit = docSnap.data();
      const fuente = sourceLabelFn(unit);
      try {
        const filter = linearIssueFilterFn(unit, from);
        // Sin fuente NO se pregunta: un filtro vacío devuelve el workspace
        // entero y el número resultante pasa por una métrica de equipo.
        if (!filter) throw new Error('Esta unidad no mide nada: dale un label o un equipo de Linear.');
        const issues = await fetchLinearIssues(filter, apiKey);
        const metrics = computeFlowMetricsFn(issues, { from, to, now: to });
        await docSnap.ref.set({ metrics: { ...metrics, periodFrom: from, periodTo: to, computedAt: to } }, { merge: true });
        results.push({ id: docSnap.id, label: unit.linearLabel ?? null, source: fuente, ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error desconocido.';
        await docSnap.ref.set({ metrics: { error: msg, computedAt: to } }, { merge: true });
        results.push({ id: docSnap.id, label: unit.linearLabel ?? null, source: fuente, ok: false, error: msg });
      }
    }
    return { computedAt: to, results };
  },
);

/** Grupos de labels de Linear que GREBLA mapea a unidades de flujo. */
const LEAN_LABEL_GROUPS = [
  { group: 'Squad', kind: 'squad' },
  { group: 'Chapter', kind: 'chapter' },
];
const LINEAR_GROUP_LABELS_QUERY = `
  query GroupLabels($group: String!) {
    issueLabels(filter: { parent: { name: { eq: $group } } }) { nodes { name } }
  }`;

/** Nombres de los labels que cuelgan de un grupo de Linear (p. ej. «Squad»). */
async function fetchLinearGroupLabels(group, apiKey) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query: LINEAR_GROUP_LABELS_QUERY, variables: { group } }),
  });
  if (!res.ok) throw new Error(`Linear respondió ${res.status}.`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0]?.message || 'Error de la API de Linear.');
  return (json.data?.issueLabels?.nodes ?? []).map((n) => n.name).filter(Boolean);
}

/**
 * Auto-descubre las unidades de flujo desde los labels de Linear: los del grupo
 * «Squad» como equipos y los de «Chapter» como gremios. Crea en /leanTeams los que
 * falten (por dueño). Acceso: superadmin o líder.
 */
export const discoverLeanUnits = onCall(
  { region: 'europe-west1', secrets: [LINEAR_API_KEY], timeoutSeconds: 120 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');

    const db = getFirestore();
    const [adminSnap, leaderSnap] = await Promise.all([
      db.doc(`admins/${uid}`).get(),
      db.doc(`leaders/${uid}`).get(),
    ]);
    if (!adminSnap.exists && !leaderSnap.exists) {
      throw new HttpsError('permission-denied', 'No tienes acceso a esta organización.');
    }

    const apiKey = LINEAR_API_KEY.value();
    if (!apiKey) throw new HttpsError('failed-precondition', 'Linear no está configurado en esta instancia.');

    const existingSnap = await db.collection('leanTeams').where('ownerLeaderUid', '==', uid).get();
    const existing = new Set(existingSnap.docs.map((d) => `${d.data().kind}:${d.data().linearLabel}`));

    const now = new Date().toISOString();
    const created = [];
    for (const { group, kind } of LEAN_LABEL_GROUPS) {
      const labels = await fetchLinearGroupLabels(group, apiKey);
      for (const name of labels) {
        const key = `${kind}:${name}`;
        if (existing.has(key)) continue;
        await db.collection('leanTeams').add({ linearLabel: name, kind, name, ownerLeaderUid: uid, createdAt: now });
        existing.add(key);
        created.push({ kind, name });
      }
    }
    return { created };
  },
);

const LINEAR_TEAMS_QUERY = 'query { teams(first: 100) { nodes { key name } } }';

/**
 * Equipos de Linear, para poder elegirlos al dar de alta una unidad de flujo.
 * Solo LECTURA: GREBLA nunca escribe en Linear.
 *
 * Hace falta porque hay equipos cuyo trabajo no lleva label de «Squad» —Matcher
 * y Plataforma, con más de 200 issues vivas entre los dos— y sin esto no habría
 * forma de medirlos. Acceso: superadmin o líder, igual que el descubrimiento.
 */
export const listLinearTeams = onCall(
  { region: 'europe-west1', secrets: [LINEAR_API_KEY], timeoutSeconds: 60 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');

    const db = getFirestore();
    const [adminSnap, leaderSnap] = await Promise.all([
      db.doc(`admins/${uid}`).get(),
      db.doc(`leaders/${uid}`).get(),
    ]);
    if (!adminSnap.exists && !leaderSnap.exists) {
      throw new HttpsError('permission-denied', 'No tienes acceso a esta organización.');
    }

    const apiKey = LINEAR_API_KEY.value();
    if (!apiKey) throw new HttpsError('failed-precondition', 'Linear no está configurado en esta instancia.');

    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query: LINEAR_TEAMS_QUERY }),
    });
    if (!res.ok) throw new HttpsError('internal', `Linear respondió ${res.status}.`);
    const json = await res.json();
    if (json.errors?.length) throw new HttpsError('internal', json.errors[0]?.message || 'Error de la API de Linear.');
    const teams = (json.data?.teams?.nodes ?? [])
      .map((t) => ({ key: t.key, name: t.name }))
      .filter((t) => t.key);
    return { teams };
  },
);

// ── Interpretación de métricas con IA (LEAN / DORA) ──────────────────────────
const INTERPRET_TOOL = {
  name: 'emit_interpretation',
  description: 'Devuelve la interpretación de las métricas del equipo.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['bien', 'regular', 'mal'], description: 'Veredicto general.' },
      summary: { type: 'string', description: 'Resumen claro de 2-3 frases, en español.' },
      causes: { type: 'array', items: { type: 'string' }, description: 'Causas probables (correlacionando métricas).' },
      recommendations: { type: 'array', items: { type: 'string' }, description: 'Acciones recomendadas.' },
    },
    required: ['verdict', 'summary'],
  },
};

/** Prompt de interpretación según la herramienta (lean/dora). */
function buildInterpretPrompt(tool, summary) {
  const context = tool === 'dora'
    ? 'métricas DORA de ENTREGA (deploy frequency, lead time, change failure rate, MTTR)'
    : 'métricas LEAN de FLUJO (throughput/semana, cycle time p50/p85, WIP, aging en días, flow efficiency %)';
  const refs = tool === 'dora'
    ? 'Referencias DORA: elite = deploy diario y lead time < 1h; low = lead time > 1 semana.'
    : 'Referencias LEAN: flow efficiency típica 15-25% (>40% muy buena, <15% mala); un WIP con aging > 2 semanas es un atasco; throughput y WIP dependen del tamaño del equipo (no juzgar en absoluto).';
  return `Eres experto en rendimiento de equipos de ingeniería. Tienes las ${context} de uno o varios equipos/gremios (SIEMPRE a nivel de equipo/sistema, NUNCA de personas). Interprétalas EN CONJUNTO, correlacionando unas con otras.

Datos (JSON):
${JSON.stringify(summary)}

${refs}

Llama a emit_interpretation con: un veredicto (bien/regular/mal), un resumen de 2-3 frases, las causas PROBABLES de lo que ves y recomendaciones accionables. Todo en español. No menciones ni evalúes a personas concretas.`;
}

/**
 * Interpreta un conjunto de métricas (LEAN o DORA) con Claude: veredicto, resumen,
 * causas probables y recomendaciones. El cliente manda el resumen ya calculado.
 * Acceso: superadmin o líder.
 */
export const interpretMetrics = onCall(
  { region: 'europe-west1', secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');

    const tool = request.data?.tool === 'dora' ? 'dora' : 'lean';
    const summary = request.data?.summary ?? {};

    const db = getFirestore();
    // Solo el superadmin refresca la interpretación (el resto la ve guardada).
    const adminSnap = await db.doc(`admins/${uid}`).get();
    if (!adminSnap.exists) {
      throw new HttpsError('permission-denied', 'Solo un superadmin puede interpretar.');
    }

    const apiKey = ANTHROPIC_API_KEY.value();
    if (!apiKey) throw new HttpsError('failed-precondition', 'La IA no está configurada en esta instancia.');

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: O2O_AI_MODEL,
          max_tokens: 1500,
          tools: [INTERPRET_TOOL],
          tool_choice: { type: 'tool', name: 'emit_interpretation' },
          messages: [{ role: 'user', content: buildInterpretPrompt(tool, summary) }],
        }),
      });
    } catch {
      throw new HttpsError('unavailable', 'No se pudo contactar con la IA. Inténtalo de nuevo.');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`Anthropic error ${res.status}: ${detail}`);
      throw new HttpsError('internal', 'La IA no pudo interpretar las métricas.');
    }
    const payload = await res.json();
    const block = (payload.content ?? []).find((c) => c.type === 'tool_use');
    if (!block) throw new HttpsError('internal', 'La IA no devolvió una interpretación válida.');
    // Persistir la interpretación VIGENTE de la herramienta (sobrescribe), con la
    // fecha del server y el autor, para que quien abra LEAN/DORA la vea aunque no
    // la haya generado. Escribe la Function (Admin SDK); el cliente solo lee.
    const record = {
      ...block.input,
      at: new Date().toISOString(),
      by: { uid, name: request.auth?.token?.name ?? '' },
    };
    await db.doc(`interpretations/${tool}`).set(record);
    return { interpretation: record };
  },
);

// ── TRIBBU-COINS (CP-2): emisor único del ledger firmado ─────────────────────
//
// La emisión de tribbu-coins va SOLO por contratos (functions/coins.js, espejo
// del dominio del cliente) y la ejecuta ÚNICAMENTE esta Function: /coins es de
// solo lectura para clientes (firestore.rules) y el Admin SDK omite reglas.
// Cada apunte se encadena por hash y se firma con Cloud KMS (signer.js; sin
// COINS_KMS_KEY el apunte sale `unsigned: true` — degradación documentada).

/**
 * Añade UN apunte al ledger de forma atómica e idempotente. Transacción:
 * lee /coins/meta (seq + headHash) y el propio apunte; si el id determinista
 * ya existe NO se re-emite (idempotencia: re-visitar una ciudad retirada no
 * paga dos veces); si no, crea el apunte con seq+1 y prevHash=headHash,
 * actualiza meta y suma el delta al saldo materializado de la persona. La
 * firma KMS se pide DENTRO de la transacción (el hash depende de seq/prevHash
 * leídos); si Firestore reintenta, se re-firma el hash nuevo — coste asumido,
 * los reintentos son raros.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {{ id: string, personId: string, delta: number, reason: string,
 *   ruleId: string, refs: Record<string, unknown> }} draft
 * @returns {Promise<boolean>} true si se emitió, false si ya existía.
 */
async function appendCoinsEntry(db, draft) {
  const metaRef = db.doc('coins/meta');
  const entryRef = db.doc(`coins/ledger/entries/${draft.id}`);
  const balanceRef = db.doc(`coins/balances/people/${draft.personId}`);
  return db.runTransaction(async (tx) => {
    const [entrySnap, metaSnap] = await Promise.all([tx.get(entryRef), tx.get(metaRef)]);
    if (entrySnap.exists) return false; // ya emitido: idempotente
    const meta = metaSnap.exists ? metaSnap.data() : null;
    const seq = (Number.isInteger(meta?.seq) ? meta.seq : 0) + 1;
    const prevHash = typeof meta?.headHash === 'string' && meta.headHash !== '' ? meta.headHash : coins.GENESIS_HASH;
    const ts = new Date().toISOString();
    /** @type {Record<string, unknown>} */
    const entry = {
      id: draft.id,
      seq,
      personId: draft.personId,
      delta: draft.delta,
      reason: draft.reason,
      ruleId: draft.ruleId,
      ruleVersion: coins.RULE_VERSION,
      refs: draft.refs,
      ts,
      prevHash,
    };
    // El marcador de degradación entra en el HASH: nadie puede quitar la firma
    // de un apunte legítimo y marcarlo unsigned sin romper la cadena.
    const unsigned = coinsKmsKeyName() === null;
    if (unsigned) entry.unsigned = true;
    const hash = coins.sha256Hex(coins.canonicalEntry(entry));
    const signature = unsigned ? null : await sign(hash); // un fallo de KMS lanza: no se escribe nada
    tx.create(entryRef, signature ? { ...entry, hash, sig: signature.sig, kid: signature.kid } : { ...entry, hash });
    tx.set(metaRef, { seq, headHash: hash, updatedAt: ts }, { merge: true });
    tx.set(balanceRef, { balance: FieldValue.increment(draft.delta), updatedAt: ts }, { merge: true });
    return true;
  });
}

/**
 * Doc de una isla (/careerMap/{islandId}) cacheado por ejecución: varios
 * certificados de la misma isla en un mismo write no la releen.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {Map<string, Record<string, unknown>|null>} cache
 * @param {string} islandId
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function loadIslandDoc(db, cache, islandId) {
  if (!cache.has(islandId)) {
    const snap = await db.doc(`careerMap/${islandId}`).get();
    cache.set(islandId, snap.exists ? snap.data() : null);
  }
  return cache.get(islandId) ?? null;
}

/**
 * EMISOR de tribbu-coins: trigger sobre el journey de cada persona
 * (/people/{personId}/career/journey). En cada escritura:
 *  1. Diff de visitedCities (solo AÑADIDAS) → apuntes `cert:` con el peso de
 *     la ciudad leído del doc de su isla (disciplina = prefijo del cityId,
 *     resuelta contra el índice /careerMap/_archipelago; cacheado por
 *     ejecución).
 *  2. Recalcula ciudadanías y badges con la MISMA lógica que el cliente
 *     (aritmética entera de citizenship.js) → apuntes `citz:` y `badge:`.
 *  3. Carpools del personId (query memberIds array-contains) cuya ruta esté
 *     COMPLETA (ruta ⊆ visitadas) → apuntes `carpool:`.
 * Todos los apuntes tienen id determinista: los ya emitidos se saltan dentro
 * de la transacción (idempotencia), así que re-ejecutar el trigger nunca
 * duplica coins. Retirar ciudades no resta: el ledger es historia.
 */
export const emitCoinsOnJourneyWrite = onDocumentWritten(
  { document: 'people/{personId}/career/journey', region: 'europe-west1' },
  async (event) => {
    const personId = event.params.personId;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after) return; // journey borrado: el ledger es historia, no se emite ni se resta

    const db = getFirestore();
    // Índice del archipiélago: imprescindible para pesos (isla de cada ciudad)
    // y ciudadanías. Sin él no se puede emitir NADA con garantías: se avisa
    // alto y se sale (los apuntes pendientes saldrán en el próximo write, los
    // ids deterministas lo permiten). Nunca se emite con datos inventados.
    const archSnap = await db.doc('careerMap/_archipelago').get();
    if (!archSnap.exists) {
      console.error('[coins] Falta /careerMap/_archipelago: no se emiten tribbu-coins en este write.');
      return;
    }
    const islands = coins.normalizeIslands(archSnap.data().islands);
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const visited = [
      ...new Set(
        (Array.isArray(after.visitedCities) ? after.visitedCities : [])
          .filter((c) => typeof c === 'string' && c.trim() !== '')
          .map((c) => c.trim()),
      ),
    ];
    const added = coins.addedCities(before?.visitedCities, after.visitedCities);

    /** @type {{ id: string, personId: string, delta: number, reason: string, ruleId: string, refs: Record<string, unknown> }[]} */
    const drafts = [];

    // 1) Certificados: solo las ciudades AÑADIDAS en este write.
    const islandCache = new Map();
    for (const cityId of added) {
      const discipline = cityId.includes('/') ? cityId.slice(0, cityId.indexOf('/')) : '';
      const islandRef = islands.find((i) => i.discipline === discipline);
      if (!islandRef) {
        console.warn(`[coins] Ciudad «${cityId}» sin isla en el índice (disciplina «${discipline}»): sin apunte.`);
        continue;
      }
      const map = await loadIslandDoc(db, islandCache, islandRef.id);
      const city = (Array.isArray(map?.cities) ? map.cities : []).find((c) => c?.id === cityId);
      const weight = Number(city?.weight);
      if (!city || !Number.isInteger(weight) || weight < 1 || weight > 3) {
        console.warn(`[coins] Ciudad «${cityId}» sin peso 1-3 en /careerMap/${islandRef.id}: sin apunte.`);
        continue;
      }
      drafts.push({
        id: coins.certEntryId(personId, cityId),
        personId,
        delta: coins.CONTRACTS_V1.certificate(weight),
        reason: `Certificado de ${city.name ?? cityId}`,
        ruleId: 'certificate',
        refs: { cityId, cityName: String(city.name ?? cityId), islandId: islandRef.id, weight },
      });
    }

    // 2) Ciudadanías y badges: recomputo completo (espejo del cliente). Los
    // ids deterministas hacen que las ya emitidas se salten solas.
    const achieved = coins.achievedCitizenships(visited, islands);
    for (const isle of achieved) {
      drafts.push({
        id: coins.citizenshipEntryId(personId, isle.id),
        personId,
        delta: coins.CONTRACTS_V1.citizenship,
        reason: `Ciudadanía de ${isle.name}`,
        ruleId: 'citizenship',
        refs: { islandId: isle.id, islandName: isle.name },
      });
    }
    const badges = coins.earnedBadges(achieved);
    if (badges.superCitizen) {
      drafts.push({
        id: coins.badgeEntryId(personId, 'superCitizen'),
        personId,
        delta: coins.CONTRACTS_V1.superCitizen,
        reason: 'Badge ⭐ Super-ciudadano del archipiélago',
        ruleId: 'superCitizen',
        refs: { badge: 'superCitizen' },
      });
    }
    if (badges.legend) {
      drafts.push({
        id: coins.badgeEntryId(personId, 'legend'),
        personId,
        delta: coins.CONTRACTS_V1.legend,
        reason: 'Badge 👑 Leyenda del archipiélago',
        ruleId: 'legend',
        refs: { badge: 'legend' },
      });
    }

    // 3) Carpools con la ruta COMPLETA por esta persona (ruta ⊆ visitadas).
    // Cualquier estado del carpool vale: completar la ruta es el contrato (el
    // status 'closed' retira el grupo del tablón, no el mérito del viaje).
    const visitedSet = new Set(visited);
    const carpoolsSnap = await db.collection('carpools').where('memberIds', 'array-contains', personId).get();
    for (const docSnap of carpoolsSnap.docs) {
      const data = docSnap.data();
      const routeCityIds = (Array.isArray(data.route) ? data.route : [])
        .map((stop) => String(stop?.cityId ?? '').trim())
        .filter((cityId) => cityId !== '');
      if (routeCityIds.length === 0) continue; // sin ruta no hay contrato que cumplir
      if (!routeCityIds.every((cityId) => visitedSet.has(cityId))) continue;
      drafts.push({
        id: coins.carpoolEntryId(docSnap.id, personId),
        personId,
        delta: coins.CONTRACTS_V1.carpoolCompleted(routeCityIds.length),
        reason: `Carpool «${data.name ?? docSnap.id}» completado`,
        ruleId: 'carpoolCompleted',
        refs: { carpoolId: docSnap.id, carpoolName: String(data.name ?? docSnap.id), stops: routeCityIds.length },
      });
    }

    // Emisión SECUENCIAL (la cadena de hashes exige un orden): cada apunte en
    // su transacción; los ya existentes se saltan dentro de ella.
    let emitted = 0;
    for (const draft of drafts) {
      if (await appendCoinsEntry(db, draft)) emitted += 1;
    }
    if (emitted > 0) {
      console.log(`[coins] ${emitted} apunte(s) emitido(s) para ${personId} (${drafts.length} candidatos).`);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// MOTIVADORES — agregados públicos. El cálculo vive en ./motivatorsAggregate.js
// (espejo de src/tools/motivators/domain/aggregate.js, atado por un test de
// equivalencia). Aquí solo queda el trigger y su lectura de datos.
// ─────────────────────────────────────────────────────────────────────────────

const motToMs = (v) => {
  if (v == null) return 0;
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * Recalcula el documento público /motivatorAggregates/{game} cada vez que se
 * crea, edita o borra una sesión. Publica medias, medianas, top-3 y distribución
 * por motivador, y SOLO de los cortes que llegan al umbral de anonimato
 * (RMR-BUG-0051): con una o dos respuestas esos mismos números reconstruyen el
 * orden que eligió una persona concreta. Admin SDK (omite reglas).
 */
export const onMotivatorSessionWritten = onDocumentWritten(
  { region: 'europe-west1', document: 'motivatorSessions/{sessionId}' },
  async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;
    const game = after?.exists ? after.data()?.game : before?.data()?.game;
    if (!game || !MOTIVATOR_DECK_IDS[game]) {
      console.warn(`[motivators] sesión sin juego válido, se ignora: ${game}`);
      return;
    }
    const db = getFirestore();
    const [sessionsSnap, roundsSnap, leadersSnap, headsSnap] = await Promise.all([
      db.collection('motivatorSessions').where('game', '==', game).get(),
      db.collection('motivatorRounds').where('game', '==', game).get(),
      db.collection('leaders').get(),
      db.collection('supermanagers').get(),
    ]);
    // Jerarquía para el corte por departamento (RMR-TSK-0296): equipoId ya ES un
    // leaderUid, así que basta con saber de qué Head cuelga cada manager.
    const reportsToByUid = {};
    for (const d of leadersSnap.docs) reportsToByUid[d.id] = d.data().reportsTo ?? null;
    const headNames = new Map();
    for (const d of headsSnap.docs) headNames.set(d.id, d.data().displayName || d.data().email || d.id);
    const headUids = new Set(headNames.keys());
    // Se agrupa por UID del Head (clave estable): dos Heads pueden llamarse
    // igual, y fundir sus ramas mezclaría departamentos distintos.
    /** @type {Record<string, string>} leaderUid → uid del Head */
    const departmentByLeader = {};
    for (const leaderUid of Object.keys(reportsToByUid)) {
      const headUid = departmentOf(leaderUid, reportsToByUid, headUids);
      if (headUid) departmentByLeader[leaderUid] = headUid;
    }
    const sessions = sessionsSnap.docs.map((d) => d.data());
    const orderedRoundIds = roundsSnap.docs
      .map((d) => ({ id: d.id, startMs: motToMs(d.data().startAt) }))
      .sort((a, b) => a.startMs - b.startMs)
      .map((r) => r.id);

    const aggregates = motComputeAggregates(
      sessions, MOTIVATOR_DECK_IDS[game], game, orderedRoundIds, MOTIVATOR_DECK_SIZE,
      MOT_MIN_RESPONDENTS, departmentByLeader,
    );
    // Nombres aparte de la agrupación, solo para mostrarlos. updatedAt se estampa
    // aquí (serverTimestamp, como marea), no en el módulo puro — que así queda
    // comparable con el dominio en el test de equivalencia.
    await db.doc(`motivatorAggregates/${game}`).set({
      ...aggregates,
      departmentNames: Object.fromEntries(headNames),
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`[motivators] agregados de ${game} recalculados (${sessions.length} sesiones).`);
  },
);

/**
 * Marea (RMR-TSK-0236): recalcula /pulseAggregates/{weekIso} cada vez que alguien
 * registra o edita su marea. Solo expone AGREGADOS ANÓNIMOS (medias por dimensión,
 * general + por gremio + por label/squad + por departamento) y solo de grupos
 * con >=3 respuestas.
 * Los registros individuales (/pulse/{uid}/entries) NUNCA se exponen. Admin SDK.
 */
export const aggregatePulse = onDocumentWritten(
  { region: 'europe-west1', document: 'pulse/{uid}/entries/{day}' },
  async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;
    const weekIso = after?.exists ? after.data()?.weekIso : before?.data()?.weekIso;
    if (!weekIso) {
      console.warn('[marea] entrada sin weekIso, se ignora');
      return;
    }
    const db = getFirestore();
    // collectionGroup('entries') roza el ledger de coins, pero esas entradas no
    // tienen weekIso, así que el filtro las excluye (y el índice solo indexa las
    // que sí lo tienen). El mapa uid→persona da los gremios/labels (nombres).
    const [entriesSnap, peopleSnap, leadersSnap, headsSnap] = await Promise.all([
      db.collectionGroup('entries').where('weekIso', '==', weekIso).get(),
      db.collection('people').get(),
      db.collection('leaders').get(),
      db.collection('supermanagers').get(),
    ]);
    const entries = entriesSnap.docs.map((d) => d.data());
    // Jerarquía para el corte por departamento (RMR-TSK-0296): de cada manager,
    // a quién reporta; y qué uids son Head, con su nombre visible. El eje se
    // guarda por NOMBRE, igual que gremios y squads, para que la vista no tenga
    // que resolver uids.
    /** @type {Record<string, string|null>} */
    const reportsToByUid = {};
    for (const doc of leadersSnap.docs) reportsToByUid[doc.id] = doc.data().reportsTo ?? null;
    /** @type {Map<string, string>} */
    const headNames = new Map();
    for (const doc of headsSnap.docs) {
      const h = doc.data();
      headNames.set(doc.id, h.displayName || h.email || doc.id);
    }
    const headUids = new Set(headNames.keys());
    /** @type {Record<string, { guilds: string[], labels: string[], department: string|null }>} */
    const peopleByUid = {};
    let totalPeople = 0;
    for (const doc of peopleSnap.docs) {
      const p = doc.data();
      if (p.active !== false) totalPeople += 1;
      if (!p.uid) continue;
      // Se agrupa por UID del Head (clave estable), no por su nombre.
      peopleByUid[p.uid] = {
        guilds: p.guilds || [],
        labels: p.labels || [],
        department: departmentOf(p.ownerLeaderUid ?? null, reportsToByUid, headUids),
      };
    }
    const aggregate = computePulseAggregate(weekIso, entries, peopleByUid, {
      minCount: 3,
      totalPeople,
      departmentNames: Object.fromEntries(headNames),
    });
    await db.doc(`pulseAggregates/${weekIso}`).set({ ...aggregate, updatedAt: FieldValue.serverTimestamp() });
    console.log(`[marea] agregado ${weekIso} recalculado (${aggregate.respondents} personas).`);
  },
);

/**
 * Registro de MIEMBROS de la instancia por uid (RMR-TSK-0274).
 *
 * Las reglas de Firestore no pueden preguntar «¿este uid es una persona de la
 * instancia?»: las personas viven en /people con id propio y el `uid` es un
 * campo, no la clave (y un get() por documento no es viable dentro de una
 * query). Este trigger mantiene un espejo /members/{uid} — el mismo patrón que
 * ya usan /admins, /viewers y /leaders — para que las reglas puedan resolverlo
 * con un exists() barato.
 *
 * Se hace con un trigger, y no escribiendo desde el cliente, porque hay DOS vías
 * de vinculación (la Cloud Function `sealInvite` y `assignUserToLeader` desde el
 * panel) y porque dejar que el cliente escriba en /members permitiría a
 * cualquiera auto-registrarse como miembro.
 */
export const syncMemberRegistry = onDocumentWritten(
  { region: 'europe-west1', document: 'people/{personId}' },
  async (event) => {
    const before = event.data?.before;
    const after = event.data?.after;
    const beforeUid = before?.exists ? before.data()?.uid : null;
    const afterUid = after?.exists ? after.data()?.uid : null;
    if (beforeUid === afterUid) return; // el uid no cambió: nada que sincronizar
    const db = getFirestore();
    // Se desvinculó (o se borró la persona): fuera del registro.
    if (beforeUid && beforeUid !== afterUid) {
      await db.doc(`members/${beforeUid}`).delete().catch(() => {});
    }
    if (afterUid) {
      await db.doc(`members/${afterUid}`).set({
        personId: event.params.personId,
        ownerLeaderUid: after.data()?.ownerLeaderUid ?? null,
        linkedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  },
);

/**
 * Push periódico (semanal, GCP) de las métricas DORA/LEAN por squad al Firestore
 * del portal de management (proyecto `tribbu-dev-portal`, distinto del de GREBLA).
 * Usa una SEGUNDA app de Firebase Admin nombrada con la credencial del secret
 * `PORTAL_SA_KEY`; escribe solo `metrics_dora`/`metrics_lean`. En instancias sin
 * portal configurado (el placeholder no parsea a la SA del portal) se omite.
 */
export const pushMetricsToPortal = onSchedule(
  { schedule: 'every monday 06:00', timeZone: 'Europe/Madrid', region: 'europe-west1', secrets: [PORTAL_SA_KEY] },
  async () => {
    const saKeyJson = PORTAL_SA_KEY.value();
    if (!portalConfigured(saKeyJson)) {
      logger.info('Portal no configurado en esta instancia: se omite el push de métricas.');
      return;
    }
    const nowIso = new Date().toISOString();
    const results = await publishSquadMetrics({ greblaDb: getFirestore(), portalDb: getPortalDb(saKeyJson), nowIso });
    logger.info('Push de métricas al portal completado', results);
  },
);

/**
 * Invitar a una persona a un carpool (shippooling) por su EMAIL (RMR-PCS-0029 · F3).
 * Solo quien conduce invita. Resuelve email→persona con Admin SDK (el cliente NUNCA
 * ve el email de otros: solo recibe el nombre resuelto) y añade su personId a
 * `invitedPersonIds` si el grupo está abierto, hay plaza (contando invitaciones
 * pendientes) y no es ya miembro ni está ya invitada.
 */
export const inviteToCarpool = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Inicia sesión.');
  const carpoolId = String(request.data?.carpoolId ?? '').trim();
  const rawEmail = String(request.data?.email ?? '').trim();
  const lowerEmail = rawEmail.toLowerCase();
  if (!carpoolId || !lowerEmail) throw new HttpsError('invalid-argument', 'Falta el grupo o el email.');
  const db = getFirestore();

  const meSnap = await db.collection('people').where('uid', '==', caller.uid).limit(1).get();
  if (meSnap.empty) throw new HttpsError('failed-precondition', 'No tienes una ficha vinculada.');
  const myPersonId = meSnap.docs[0].id;

  // Se resuelve el email FUERA de la transacción (una query no puede ir dentro).
  // ANTI-ENUMERACIÓN (privacidad): la respuesta NUNCA revela si el email existe,
  // está inactivo o ya está en el grupo, ni devuelve su nombre. Cualquier email
  // no elegible sale con el MISMO `{ ok: true }` genérico. Solo se lanzan errores
  // a nivel de GRUPO (no eres el conductor, no está abierto, no quedan plazas),
  // que no dependen del email.
  // Emails: los flujos de auth los guardan en minúsculas, pero una ficha creada
  // a mano podría tener mayúsculas. Se prueba primero en minúsculas (la
  // convención) y, si no, tal cual se escribió.
  let inv = await db.collection('people').where('email', '==', lowerEmail).limit(1).get();
  if (inv.empty && rawEmail !== lowerEmail) {
    inv = await db.collection('people').where('email', '==', rawEmail).limit(1).get();
  }
  const invitedDoc = inv.empty ? null : inv.docs[0];
  const invitedPersonId = invitedDoc?.id ?? null;
  const eligible = Boolean(invitedDoc) && invitedDoc.data().active !== false && invitedPersonId !== myPersonId;

  const ref = db.doc(`carpools/${carpoolId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Ese grupo no existe.');
    const c = snap.data();
    if (c.conductor?.personId !== myPersonId) {
      throw new HttpsError('permission-denied', 'Solo quien conduce el grupo puede invitar.');
    }
    if (c.status !== 'open') throw new HttpsError('failed-precondition', 'El grupo no está abierto.');
    if (!eligible) return; // email no registrado/inactivo/tú mismo: respuesta genérica
    const members = Array.isArray(c.members) ? c.members : [];
    const invited = Array.isArray(c.invitedPersonIds) ? c.invitedPersonIds : [];
    if (members.some((m) => m.personId === invitedPersonId) || invited.includes(invitedPersonId)) return; // ya dentro/invitado: genérico
    if (members.length + invited.length >= (c.seats ?? 0)) {
      throw new HttpsError('failed-precondition', 'No quedan plazas (contando las invitaciones pendientes).');
    }
    tx.set(ref, { invitedPersonIds: [...invited, invitedPersonId] }, { merge: true });
  });
  return { ok: true };
});

/**
 * Responder a una invitación de carpool (RMR-PCS-0029 · F3): aceptar (pasar a
 * miembro si sigue habiendo plaza) o rechazar (quitarse de invitados). Admin SDK,
 * en transacción para no pasarse de aforo.
 */
export const respondCarpoolInvitation = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Inicia sesión.');
  const carpoolId = String(request.data?.carpoolId ?? '').trim();
  const accept = request.data?.accept;
  if (!carpoolId) throw new HttpsError('invalid-argument', 'Falta el grupo.');
  if (typeof accept !== 'boolean') throw new HttpsError('invalid-argument', 'Indica si aceptas (true) o rechazas (false).');
  const db = getFirestore();

  const meSnap = await db.collection('people').where('uid', '==', caller.uid).limit(1).get();
  if (meSnap.empty) throw new HttpsError('failed-precondition', 'No tienes una ficha vinculada.');
  const myPersonId = meSnap.docs[0].id;
  const myName = meSnap.docs[0].data().name ?? myPersonId;

  const ref = db.doc(`carpools/${carpoolId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Ese grupo ya no existe.');
    const c = snap.data();
    const invited = Array.isArray(c.invitedPersonIds) ? c.invitedPersonIds : [];
    if (!invited.includes(myPersonId)) throw new HttpsError('failed-precondition', 'No tienes una invitación a ese grupo.');
    const nextInvited = invited.filter((id) => id !== myPersonId);
    if (!accept) {
      tx.set(ref, { invitedPersonIds: nextInvited }, { merge: true });
      return { ok: true, joined: false };
    }
    if (c.status !== 'open') throw new HttpsError('failed-precondition', 'El grupo ya no está abierto.');
    const members = Array.isArray(c.members) ? c.members : [];
    if (members.some((m) => m.personId === myPersonId)) throw new HttpsError('already-exists', 'Ya estás en el grupo.');
    if (members.length >= (c.seats ?? 0)) throw new HttpsError('failed-precondition', 'El grupo se ha llenado.');
    const nextMembers = [...members, { personId: myPersonId, name: myName, joinedAt: new Date().toISOString() }];
    const status = (c.seats ?? 0) - nextMembers.length <= 0 ? 'full' : 'open';
    tx.set(ref, {
      members: nextMembers,
      memberIds: nextMembers.map((m) => m.personId),
      status,
      invitedPersonIds: nextInvited,
    }, { merge: true });
    return { ok: true, joined: true };
  });
});

// ── Huevos de pascua (RMR-PCS-0030 · F1) ──────────────────────────────────────

/**
 * Registra el HALLAZGO de un huevo de pascua (RMR-TSK-0391): quién y cuándo,
 * inviolable — timestamp de servidor, un doc por persona (idempotente) y solo
 * con el huevo ACTIVO. Con `secretWord` valida además la palabra clave del reto
 * (guardada en el subdoc private, ilegible para clientes) y marca el completado.
 * Devuelve el estado para que el cliente pinte premio/fecha sin inventar nada.
 */
export const registerEggFind = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
  const eggId = typeof request.data?.eggId === 'string' ? request.data.eggId.trim() : '';
  if (!eggId) throw new HttpsError('invalid-argument', 'Falta el huevo (eggId).');
  const rawWord = typeof request.data?.secretWord === 'string' ? request.data.secretWord.trim() : '';

  const db = getFirestore();
  const eggSnap = await db.doc(`easterEggs/${eggId}`).get();
  if (!eggSnap.exists || eggSnap.data().active !== true) {
    throw new HttpsError('failed-precondition', 'Ese huevo no existe o no está activo.');
  }

  // La persona del que llama (por uid): el hallazgo se registra por personId.
  const personSnap = await db.collection('people').where('uid', '==', caller.uid).limit(1).get();
  const personDoc = personSnap.docs.at(0);
  if (!personDoc) throw new HttpsError('failed-precondition', 'Tu cuenta no está vinculada a ninguna persona.');
  const personId = personDoc.id;
  const personName = personDoc.data().name ?? 'Sin nombre';

  const findRef = db.doc(`easterEggs/${eggId}/finds/${personId}`);
  const findSnap = await findRef.get();
  const already = findSnap.exists;
  if (!already) {
    await findRef.set({ personId, name: personName, uid: caller.uid, foundAt: FieldValue.serverTimestamp() });
  }

  // Palabra clave (opcional, tipo objeto-isla): compara sin mayúsculas/acentos.
  let solved = findSnap.data()?.solved === true;
  let wordError = false;
  if (rawWord && !solved) {
    const secretSnap = await db.doc(`easterEggs/${eggId}/private/secret`).get();
    const secret = String(secretSnap.data()?.word ?? '').trim();
    const norm = (s) => s.normalize('NFD').replaceAll(/\p{Diacritic}/gu, '').toLowerCase();
    if (secret && norm(rawWord) === norm(secret)) {
      await findRef.set({ solved: true, solvedAt: FieldValue.serverTimestamp() }, { merge: true });
      solved = true;
    } else {
      wordError = true;
    }
  }

  logger.info(`[eggs] ${eggId}: hallazgo de ${personName} (${personId})${solved ? ' RESUELTO' : ''}${already ? ' [repetido]' : ''}`);
  // Estado FINAL re-leído tras las escrituras: el primer hallazgo también
  // devuelve su foundAt real (timestamp de servidor ya resuelto).
  const finalSnap = await findRef.get();
  return {
    ok: true,
    already,
    solved,
    wordError,
    foundAt: finalSnap.data()?.foundAt?.toDate?.()?.toISOString() ?? null,
  };
});

// ── Job Descriptions públicas (RMR-PCS-0031 · F3, ADR CF+rewrite) ─────────────

/**
 * Sirve el JSON-LD de una Job Description PUBLICADA: GET /jd/{id} (URL bonita
 * vía rewrite de hosting). Solo expone docs con status «publicada» — nada más
 * del contenido de GREBLA. Cache corto para que despublicar surta efecto rápido.
 */
export const jd = onRequest({ region: 'europe-west1', cors: true }, async (req, res) => {
  const id = String(req.path ?? '').split('/').filter(Boolean).at(-1) ?? '';
  if (!id || id === 'jd') {
    res.status(404).json({ error: 'Falta el id de la Job Description (/jd/{id}).' });
    return;
  }
  const snap = await getFirestore().doc(`jobDescriptions/${id}`).get();
  const data = snap.exists ? snap.data() : null;
  if (!data || data.status !== 'publicada' || !data.payload) {
    res.status(404).json({ error: 'Job Description no publicada.' });
    return;
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.status(200).json(data.payload);
});

// ── Kudos (RMR-PCS-0032 · F1, ADR de anonimato) ──────────────────────────────

/** Longitud máxima de cada mensaje de kudo. ESPEJO de KUDO_MAX_LEN en
 * src/tools/kudos/domain/kudos.js (functions no importa de src): si cambia
 * allí, cambiar aquí. */
const KUDO_MAX_LEN = 280;

/** Normaliza un texto de kudo (trim, vacío→null, tope de longitud). Espejo de
 * normalizeText del dominio de src — mantener ambos alineados. */
const normalizeKudoText = (value, field) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', `El texto «${field}» debe ser una cadena.`);
  }
  const text = value.trim();
  if (!text) return null;
  if (text.length > KUDO_MAX_LEN) {
    throw new HttpsError(
      'invalid-argument',
      `El mensaje «${field}» supera los ${KUDO_MAX_LEN} caracteres: sé conciso, no es una carta.`,
    );
  }
  return text;
};

/** Clave de semana ISO-8601 (YYYY-Www) en UTC. Espejo de isoWeekKey del
 * dominio de src — mantener ambos alineados. */
const kudoWeekKey = (date) => {
  const thursday = new Date(date.getTime());
  thursday.setUTCHours(0, 0, 0, 0);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
};

/**
 * Alta de un kudo — ÚNICO camino de escritura (el cliente no puede escribir
 * /kudos: write:false en reglas). Garantiza el anonimato del ADR: el doc
 * público no lleva autor; el privado solo lo lee el destinatario; el remitente
 * queda en /kudosMeta SELLADO (ilegible por reglas, solo Admin SDK ante un
 * abuso denunciado). Valida concisión (≤280), al menos un mensaje, que el
 * destinatario existe y que nadie se agradece a sí mismo.
 */
export const submitKudo = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');

  const recipientPersonId =
    typeof request.data?.recipientPersonId === 'string' ? request.data.recipientPersonId.trim() : '';
  if (!recipientPersonId) throw new HttpsError('invalid-argument', 'El kudo necesita un destinatario.');
  const publicText = normalizeKudoText(request.data?.publicText, 'público');
  const privateText = normalizeKudoText(request.data?.privateText, 'privado');
  if (!publicText && !privateText) {
    throw new HttpsError('invalid-argument', 'Escribe al menos un mensaje (público o privado).');
  }

  const db = getFirestore();
  const personSnap = await db.doc(`people/${recipientPersonId}`).get();
  if (!personSnap.exists || personSnap.data().active === false) {
    throw new HttpsError('not-found', 'Esa persona no existe o ya no está activa.');
  }
  const person = personSnap.data();
  if (person.uid && person.uid === caller.uid) {
    throw new HttpsError('failed-precondition', 'No puedes darte las gracias a ti mismo.');
  }

  const kudoRef = db.collection('kudos').doc();
  const batch = db.batch();
  batch.set(kudoRef, {
    recipientPersonId,
    recipientName: person.name ?? 'Alguien del equipo',
    weekKey: kudoWeekKey(new Date()),
    publicText,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (privateText) {
    // recipientPersonId también aquí: la regla de lectura del privado resuelve
    // el titular con un único get(people/...) sin mirar el doc padre.
    batch.set(kudoRef.collection('private').doc('message'), { text: privateText, recipientPersonId });
  }
  // Traza anti-abuso SELLADA (ADR): ningún cliente puede leerla — el anonimato
  // lo garantizan las reglas; solo el Admin SDK ante una denuncia.
  batch.set(db.doc(`kudosMeta/${kudoRef.id}`), {
    senderUid: caller.uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  logger.info(`[kudos] nuevo kudo para ${recipientPersonId} (${publicText ? 'público' : ''}${publicText && privateText ? '+' : ''}${privateText ? 'privado' : ''})`);
  return { ok: true, kudoId: kudoRef.id };
});

/**
 * Directorio mínimo para el selector de Kudos: personas activas {personId,
 * name}. /people no es legible por cualquier logado (contiene datos de
 * carrera/equipo) y el kudo solo necesita a quién dar las gracias — esta CF
 * expone únicamente id+nombre a usuarios autenticados.
 */
export const listKudosRecipients = onCall({ region: 'europe-west1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
  const snap = await getFirestore().collection('people').get();
  const people = snap.docs
    .filter((d) => d.data().active !== false)
    .map((d) => ({ personId: d.id, name: d.data().name ?? 'Sin nombre' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return { people };
});

/**
 * Garantiza que existe una persona a la que dar las gracias, por su email
 * (RMR-TSK-0405): busca la ficha por email o pendingEmail y, si no existe,
 * crea una MÍNIMA 'generico' con pendingEmail — el primer login la sella
 * (sealInvite) y sus kudos privados le estarán esperando. Si la instancia
 * tiene dominio de empleados configurado, solo admite emails de ese dominio.
 */
export const ensureKudosRecipient = onCall({ region: 'europe-west1' }, async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
  const email = typeof request.data?.email === 'string' ? request.data.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Escribe un email válido.');
  }

  const db = getFirestore();
  const orgSnap = await db.doc('config/org').get();
  const domain = (orgSnap.exists ? (orgSnap.data().employeeDomain ?? '') : '')
    .toString().trim().toLowerCase().replace(/^@/, '');
  if (domain && !email.endsWith('@' + domain)) {
    throw new HttpsError('invalid-argument', `Solo emails de la organización (@${domain}).`);
  }

  // Alta IDEMPOTENTE y sin carreras: un índice determinista por email
  // (peopleByEmail/{email}, solo Admin SDK — mismo patrón que peopleByUid) y
  // las búsquedas dentro de la MISMA transacción que la creación.
  const rawName = typeof request.data?.name === 'string' ? request.data.name.trim() : '';
  const indexRef = db.collection('peopleByEmail').doc(email);
  const outcome = await db.runTransaction(async (tx) => {
    const idx = await tx.get(indexRef);
    if (idx.exists && idx.data().personId) {
      const person = await tx.get(db.doc(`people/${idx.data().personId}`));
      if (person.exists) {
        return { personId: person.id, name: person.data().name ?? email, created: false };
      }
      // Índice huérfano (la ficha ya no existe): sigue el flujo normal — el
      // tx.set del índice de abajo lo repara apuntando a la ficha nueva/hallada.
    }
    const [byEmail, byPending] = await Promise.all([
      tx.get(db.collection('people').where('email', '==', email).limit(1)),
      tx.get(db.collection('people').where('pendingEmail', '==', email).limit(1)),
    ]);
    const existing = byEmail.docs.at(0) ?? byPending.docs.at(0);
    if (existing) {
      tx.set(indexRef, { personId: existing.id, createdAt: FieldValue.serverTimestamp() });
      return { personId: existing.id, name: existing.data().name ?? email, created: false };
    }
    // Alta mínima 'generico' con pendingEmail (mismo perfil que
    // ensureEmployeePerson, pero sin uid: se sella en su primer login).
    const name = rawName || email.split('@')[0].replaceAll('.', ' ');
    const personRef = db.collection('people').doc();
    tx.set(personRef, {
      name,
      pendingEmail: email,
      orgRole: 'generico',
      orgBranch: 'generico',
      active: true,
      startDate: new Date().toISOString().slice(0, 10),
      guilds: [],
      disciplines: [],
      labels: [],
    });
    tx.set(indexRef, { personId: personRef.id, createdAt: FieldValue.serverTimestamp() });
    return { personId: personRef.id, name, created: true };
  });
  if (outcome.created) {
    logger.info(`[kudos] persona pre-invitada por kudo: ${outcome.name} <${email}> (${outcome.personId})`);
  }
  return outcome;
});

// ── JD: pulido de redacción con IA (RMR-TSK-0418) ────────────────────────────

/**
 * Corrige SOLO gramática/concordancia de los ítems deterministas de una JD
 * (Haiku, tool-use). Las barandillas de jdPolish.js garantizan que la IA no
 * inventa: mismo número de ítems, no vacíos, longitud acotada — lo que no
 * cumpla conserva su versión determinista. Solo superadmin (las JDs son
 * suyas). Sin API key configurada → failed-precondition (el panel lo avisa y
 * guarda la versión determinista).
 */
export const polishJdRequirements = onCall(
  { region: 'europe-west1', secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Necesitas iniciar sesión.');
    const adminSnap = await getFirestore().doc(`admins/${uid}`).get();
    if (!adminSnap.exists) throw new HttpsError('permission-denied', 'Solo un superadmin puede pulir JDs.');

    const responsibilities = Array.isArray(request.data?.responsibilities)
      ? request.data.responsibilities.filter((s) => typeof s === 'string' && s.trim())
      : [];
    const niceToHave = Array.isArray(request.data?.niceToHave)
      ? request.data.niceToHave.filter((s) => typeof s === 'string' && s.trim())
      : [];
    const month3 = typeof request.data?.month3 === 'string' ? request.data.month3 : '';
    if (responsibilities.length === 0) throw new HttpsError('invalid-argument', 'No hay ítems que pulir.');

    const apiKey = ANTHROPIC_API_KEY.value();
    if (!apiKey) throw new HttpsError('failed-precondition', 'La IA no está configurada en esta instancia.');

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: JD_POLISH_MODEL,
          max_tokens: 3000,
          tools: [JD_POLISH_TOOL],
          tool_choice: { type: 'tool', name: 'emit_polished_jd' },
          messages: [{ role: 'user', content: buildPolishPrompt({ responsibilities, niceToHave, month3 }) }],
        }),
      });
    } catch {
      throw new HttpsError('unavailable', 'No se pudo contactar con la IA.');
    }
    if (!res.ok) {
      console.error(`Anthropic error ${res.status}: ${await res.text().catch(() => '')}`);
      throw new HttpsError('internal', 'La IA no pudo pulir la redacción.');
    }
    const payload = await res.json();
    const block = (payload.content ?? []).find((c) => c.type === 'tool_use');
    if (!block) throw new HttpsError('internal', 'La IA no devolvió una corrección válida.');

    const resp = sanitizePolishedItems(responsibilities, block.input.responsibilities);
    const nice = sanitizePolishedItems(niceToHave, block.input.niceToHave);
    const m3 = sanitizePolishedItems([month3], [block.input.month3]);
    logger.info(`[jd] pulido IA: ${resp.changed + nice.changed + m3.changed} ítems corregidos`);
    return {
      responsibilities: resp.items,
      niceToHave: nice.items,
      month3: m3.items[0],
      changed: resp.changed + nice.changed + m3.changed,
    };
  },
);

// ── Propiedad derivada del organigrama (RMR-PCS-0035 · F2) ───────────────────

/** ESPEJO de ownerUidFor en src/tools/team/domain/orgOwnership.js (functions no
 * importa de src): si cambia allí, cambiar aquí. undefined = no tocar. */
function orgOwnerUidFor(person, peopleById) {
  if (person?.self === true) return { ownerUid: undefined, reason: 'self' };
  const bossId = person?.reportsToPersonId ?? null;
  if (!bossId) return { ownerUid: null, reason: 'sin-superior' };
  const boss = peopleById.get(bossId);
  if (!boss) return { ownerUid: undefined, reason: 'jefe-desconocido' };
  if (!boss.uid) return { ownerUid: undefined, reason: 'jefe-sin-cuenta' };
  return { ownerUid: boss.uid, reason: 'org' };
}

/** ESPEJO de leaderChainsFrom en src/lib/accessRoles.js (functions no importa
 * de src): cadena de ancestros de cada líder siguiendo reportsTo hacia arriba,
 * cercano primero, anti-ciclos. Si cambia allí, cambiar aquí. */
function leaderChainsMirror(leaders) {
  const reportsToOf = new Map(leaders.map((l) => [l.uid, l.reportsTo ?? null]));
  const chains = new Map();
  for (const uid of reportsToOf.keys()) {
    const chain = [];
    const seen = new Set([uid]);
    let current = reportsToOf.get(uid);
    while (current != null && !seen.has(current)) {
      chain.push(current);
      seen.add(current);
      current = reportsToOf.get(current) ?? null;
    }
    chains.set(uid, chain);
  }
  return chains;
}

/**
 * Espejo /leaders desde el organigrama (RMR-TSK-0421, cierra el F8d de
 * RMR-PCS-0027): deriva reportsTo de la ficha vinculada de cada líder
 * (reportsToPersonId → uid del jefe) y precomputa `chain` (ancestros) para que
 * las reglas autoricen el subárbol transitivo. Prudente con lo no derivable:
 * líder sin ficha vinculada o jefe sin cuenta → su reportsTo actual se respeta.
 * Devuelve el nº de docs escritos (solo los que difieren — idempotente).
 * @param {FirebaseFirestore.Firestore} db
 * @param {Map<string, any>} peopleById  fichas ya leídas por el caller
 */
async function syncLeadersMirror(db, peopleById) {
  const leadersSnap = await db.collection('leaders').get();
  const personByUid = new Map();
  for (const p of peopleById.values()) {
    if (p.uid) personByUid.set(p.uid, p);
  }
  const effective = leadersSnap.docs.map((d) => {
    const current = d.data().reportsTo ?? null;
    const persona = personByUid.get(d.id);
    if (!persona) return { uid: d.id, reportsTo: current, derived: false };
    const bossId = persona.reportsToPersonId ?? null;
    if (!bossId) return { uid: d.id, reportsTo: null, derived: true };
    const boss = peopleById.get(bossId);
    if (!boss?.uid) return { uid: d.id, reportsTo: current, derived: false };
    return { uid: d.id, reportsTo: boss.uid, derived: true };
  });
  const chains = leaderChainsMirror(effective);
  let written = 0;
  for (const doc of leadersSnap.docs) {
    const next = effective.find((l) => l.uid === doc.id);
    const chain = chains.get(doc.id) ?? [];
    const prevChain = Array.isArray(doc.data().chain) ? doc.data().chain : [];
    const sameChain = prevChain.length === chain.length && prevChain.every((v, i) => v === chain[i]);
    const sameReports = (doc.data().reportsTo ?? null) === next.reportsTo;
    if (sameChain && sameReports) continue;
    await doc.ref.set({ reportsTo: next.reportsTo, chain }, { merge: true });
    written += 1;
  }
  return written;
}

/**
 * EL ORGANIGRAMA MANDA: cuando cambia una persona, se recalcula la propiedad
 * derivada. Dos frentes:
 *  - si cambió SU reportsToPersonId → se recalcula su propio ownerLeaderUid;
 *  - si cambió SU uid (p. ej. sellado del primer login) → se recalcula el de
 *    quienes le reportan (ahora su jefe tiene cuenta).
 * Además mantiene el ESPEJO /leaders (reportsTo + chain, RMR-TSK-0421) con el
 * que las reglas autorizan la visibilidad transitiva del subárbol.
 * Idempotente: solo escribe cuando el valor difiere (sin bucles de trigger).
 */
export const syncOrgOwnership = onDocumentWritten('people/{personId}', async (event) => {
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  if (!after) return; // borrados: los huérfanos se ven en el backfill, no aquí
  const reportsChanged = (before?.reportsToPersonId ?? null) !== (after.reportsToPersonId ?? null);
  const uidChanged = (before?.uid ?? null) !== (after.uid ?? null);
  if (!reportsChanged && !uidChanged) return;

  const db = getFirestore();
  const snap = await db.collection('people').get();
  const peopleById = new Map(snap.docs.map((d) => [d.id, d.data()]));
  const writes = [];

  if (reportsChanged) {
    const { ownerUid } = orgOwnerUidFor(after, peopleById);
    if (ownerUid !== undefined && (after.ownerLeaderUid ?? null) !== ownerUid) {
      writes.push({ id: event.params.personId, ownerUid });
    }
  }
  if (uidChanged) {
    for (const d of snap.docs) {
      const p = d.data();
      if ((p.reportsToPersonId ?? null) !== event.params.personId) continue;
      const { ownerUid } = orgOwnerUidFor(p, peopleById);
      if (ownerUid !== undefined && (p.ownerLeaderUid ?? null) !== ownerUid) {
        writes.push({ id: d.id, ownerUid });
      }
    }
  }
  for (const w of writes) {
    await db.doc(`people/${w.id}`).set({ ownerLeaderUid: w.ownerUid }, { merge: true });
  }
  if (writes.length) {
    logger.info(`[org-owner] sincronizados ${writes.length} dueños desde el organigrama (${event.params.personId})`);
  }
  const mirrored = await syncLeadersMirror(db, peopleById);
  if (mirrored) {
    logger.info(`[org-owner] espejo /leaders actualizado: ${mirrored} líderes (reportsTo/chain)`);
  }
});
