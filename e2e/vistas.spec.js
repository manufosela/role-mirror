/**
 * E2E del CONMUTADOR DE VISTAS (RMR-BUG-0104). Desde RMR-TSK-0459 todos los
 * roles comparten el mismo hub de cards: lo personal y la administración son
 * cards, no páginas propias. El conmutador cambia CÓMO SE VE el hub, así que
 * las cuatro vistas aterrizan en el hub — y «Volver» siempre lleva ahí.
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { test, expect, signInAs } from './fixtures.js';

function db() {
  if (getApps().length === 0) initializeApp({ projectId: 'demo-grebla' });
  return getFirestore();
}

const vista = (page, nombre) => page.getByRole('group', { name: 'Cambiar de vista' }).getByRole('button', { name: nombre });

/** El superadmin de las fixtures no tiene ficha; para mirar «como ingeniero» hace falta. */
async function conFicha(fn) {
  await db().doc('people/e2e-person-super').set({
    name: 'Superadmin E2E', uid: 'e2e-superadmin', ownerLeaderUid: 'e2e-superadmin', active: true,
  });
  try { await fn(); } finally { await db().doc('people/e2e-person-super').delete(); }
}

test('la vista de ingeniero enseña el hub, no desvía a Mi espacio', async ({ page }) => {
  await conFicha(async () => {
    await signInAs(page, 'superadmin');
    await page.goto('/');
    await vista(page, 'Ingeniero').click();

    await expect(page).toHaveURL(/\/$/);
    // Lo personal sigue estando: como card del hub, igual que para todos.
    await expect(page.locator('[data-personal]')).toBeVisible();
    // La administración no, porque un ingeniero no la ve.
    await expect(page.locator('#admin-link:not([hidden])')).toHaveCount(0);
  });
});

test('«Volver» desde Mi espacio devuelve al hub, no a Mi espacio', async ({ page }) => {
  await conFicha(async () => {
    await signInAs(page, 'superadmin');
    await page.goto('/');
    await vista(page, 'Ingeniero').click();
    await page.locator('[data-personal]').click();
    await expect(page).toHaveURL(/\/mi-espacio/);

    await page.getByRole('link', { name: '← Volver' }).click();

    // El bug: la home redirigía a /mi-espacio mientras el flag estuviera puesto,
    // así que «Volver» no llevaba a ninguna parte.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-personal]')).toBeVisible();
  });
});

test('abrir Administración no cambia la vista de la ventana en la que estabas', async ({ page }) => {
  // La administración abre en ventana aparte: no has cambiado de vista, has
  // abierto otra cosa. Antes era una tarjeta que navegaba aquí mismo y había
  // que anotar la vista para que al volver no marcara «Manager» (RMR-BUG-0104).
  await signInAs(page, 'superadmin');
  await page.goto('/');
  await vista(page, 'Manager').click();

  await expect(page.locator('#admin-link')).toBeHidden();
  await vista(page, 'Admin (superadmin)').click();
  const enlace = page.locator('#admin-link');
  await expect(enlace).toBeVisible();
  await expect(enlace).toHaveAttribute('target', '_blank');

  await enlace.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(vista(page, 'Admin (superadmin)')).toHaveAttribute('aria-pressed', 'true');
});

test('la vista de admin también se queda en el hub, con su enlace', async ({ page }) => {
  await signInAs(page, 'superadmin');
  await page.goto('/');
  await vista(page, 'Manager').click();
  await expect(page.locator('#admin-link:not([hidden])')).toHaveCount(0);

  await vista(page, 'Admin (superadmin)').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#admin-link')).toBeVisible();
});
