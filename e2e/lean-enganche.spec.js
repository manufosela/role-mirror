/**
 * E2E del enganche de las unidades LEAN al catálogo de dominios
 * (ADR «De squads a dominios y subdominios», F2).
 *
 * Lo que se defiende aquí es que el equipo diga a qué subdominio mide, y que
 * cuando no lo dice se vea: hasta ahora `leanTeams` y el catálogo eran dos
 * listas paralelas, y lo que faltaba en una no se echaba de menos hasta que
 * alguien iba a leer unas métricas que no existían.
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { test, expect, signInAs } from './fixtures.js';

function db() {
  if (getApps().length === 0) initializeApp({ projectId: 'demo-grebla' });
  return getFirestore();
}

const SUPERADMIN_UID = 'e2e-superadmin';
const CLAVES = { domains: ['e2e-tribbu'], subdomains: ['e2e-caes', 'e2e-tribbu-core'] };

/**
 * Siembra un catálogo mínimo y dos equipos: uno enganchado y otro suelto.
 * Limpia EXACTAMENTE lo suyo, por clave y por id, para no llevarse por delante
 * las semillas de otro spec.
 */
async function conUnidades(fn) {
  await db().doc('domains/e2e-lean-dom').set({ key: 'e2e-tribbu', name: 'E2E TRIBBU' });
  await db().doc('subdomains/e2e-lean-sub').set({ key: 'e2e-caes', name: 'E2E CAES', domainKey: 'e2e-tribbu' });
  await db().doc('subdomains/e2e-lean-core').set({ key: 'e2e-tribbu-core', name: 'Core', domainKey: 'e2e-tribbu' });
  await db().doc('leanTeams/e2e-unit-caes').set({
    linearLabel: 'E2E CAEs', name: 'E2E CAEs', kind: 'squad',
    subdomainKey: 'e2e-caes', ownerLeaderUid: SUPERADMIN_UID, createdAt: new Date().toISOString(),
  });
  // Una unidad que mide un EQUIPO de Linear: es el caso de Matcher y Plataforma,
  // cuyas issues no llevan label de «Squad».
  await db().doc('leanTeams/e2e-unit-team').set({
    linearTeamKey: 'E2EMAT', name: 'E2E Matcher', kind: 'squad',
    subdomainKey: 'e2e-tribbu-core', ownerLeaderUid: SUPERADMIN_UID, createdAt: new Date().toISOString(),
  });
  await db().doc('leanTeams/e2e-unit-suelta').set({
    linearLabel: 'E2E Mario Netas', name: 'E2E Mario Netas', kind: 'squad',
    ownerLeaderUid: SUPERADMIN_UID, createdAt: new Date().toISOString(),
  });
  // Una unidad sin `kind`, como la que quedó viva en producción: ni equipo ni
  // gremio, con el id por nombre.
  await db().doc('leanTeams/e2e-unit-huerfana').set({
    name: 'e2e-unit-huerfana', ownerLeaderUid: SUPERADMIN_UID, createdAt: new Date().toISOString(),
  });
  try { await fn(); } finally {
    for (const id of ['e2e-unit-caes', 'e2e-unit-suelta', 'e2e-unit-huerfana', 'e2e-unit-team']) {
      await db().doc(`leanTeams/${id}`).delete();
    }
    for (const [coleccion, claves] of Object.entries(CLAVES)) {
      const snap = await db().collection(coleccion).where('key', 'in', claves).get();
      for (const d of snap.docs) await d.ref.delete();
    }
  }
}

const unidades = (page) => page.locator('lean-app').locator('lean-teams');

async function abrirUnidades(page) {
  await signInAs(page, 'superadmin');
  await page.goto('/tools/lean');
  await page.locator('lean-app').getByRole('button', { name: /Unidades|Equipos/i }).first().click();
}

test('cada equipo enseña a qué subdominio mide, con su dominio delante', async ({ page }) => {
  await conUnidades(async () => {
    await abrirUnidades(page);
    const select = unidades(page).getByLabel('Subdominio de E2E CAEs');
    // El rótulo lleva el dominio delante: habrá un «Core» por dominio y sin él
    // el desplegable tendría opciones idénticas.
    await expect(select).toHaveValue('e2e-caes');
    await expect(select.locator('option', { hasText: 'E2E TRIBBU › Core' })).toHaveCount(1);
  });
});

test('un equipo sin enganchar avisa de que sus métricas no se publican', async ({ page }) => {
  await conUnidades(async () => {
    await abrirUnidades(page);
    await expect(unidades(page).locator('.warn.unlinked')).toContainText('no se publican');
    await expect(unidades(page).getByLabel('Subdominio de E2E Mario Netas')).toHaveValue('');
  });
});

test('enganchar guarda la CLAVE del subdominio, no su nombre', async ({ page }) => {
  await conUnidades(async () => {
    await abrirUnidades(page);
    await unidades(page).getByLabel('Subdominio de E2E Mario Netas').selectOption('e2e-tribbu-core');

    await expect.poll(async () => {
      const unit = (await db().doc('leanTeams/e2e-unit-suelta').get()).data();
      return { key: unit?.subdomainKey, name: unit?.name };
    }, { timeout: 15_000 }).toEqual({ key: 'e2e-tribbu-core', name: 'E2E Mario Netas' });

    // Y el aviso desaparece en cuanto no queda ningún equipo suelto.
    await expect(unidades(page).locator('.warn.unlinked')).toHaveCount(0);
  });
});

test('una unidad sin clasificar se ve, y se arregla desde la propia tabla', async ({ page }) => {
  await conUnidades(async () => {
    await abrirUnidades(page);
    // Aparece en su bloque, en vez de desaparecer del listado por no tener tipo.
    await expect(unidades(page).getByRole('heading', { name: /Sin clasificar/ })).toBeVisible();

    await unidades(page).getByLabel('Tipo de e2e-unit-huerfana').selectOption('chapter');

    await expect.poll(async () => {
      const unit = (await db().doc('leanTeams/e2e-unit-huerfana').get()).data();
      return unit?.kind;
    }, { timeout: 15_000 }).toBe('chapter');

    // Y deja de estar suelta: ya es un gremio como los demás.
    await expect(unidades(page).getByRole('heading', { name: /Sin clasificar/ })).toHaveCount(0);
  });
});

test('la tabla dice qué mide cada unidad en Linear: label o equipo', async ({ page }) => {
  await conUnidades(async () => {
    await abrirUnidades(page);
    // La primera columna dice de dónde salen las issues. Sin esto, una unidad
    // que mide un equipo aparecía con la celda vacía y parecía no medir nada.
    const fuentes = await unidades(page).locator('td.label-cell').allTextContents();
    expect(fuentes).toContain('Equipo E2EMAT');
    expect(fuentes).toContain('Label «E2E CAEs»');
  });
});
