/**
 * Una sola puerta de entrada (RMR-TSK-0459).
 *
 * Antes un ingeniero era desviado a `/mi-espacio`, una pantalla con su propia
 * cabecera y sus propias pestañas, mientras el resto entraba al hub de cards.
 * Parecían dos aplicaciones. Ahora todos entran al hub y lo personal es una
 * card más.
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { test, expect, signInAs } from './fixtures.js';

function db() {
  if (getApps().length === 0) initializeApp({ projectId: 'demo-grebla' });
  return getFirestore();
}

test('un ingeniero se queda en el hub, no se le desvía', async ({ page }) => {
  await signInAs(page, 'engineer');
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Mi espacio' })).toBeVisible();
});

test('la card «Mi espacio» se ve aunque las políticas no den ninguna herramienta', async ({ page }) => {
  // Es lo suyo: la política gobierna la herramienta de equipo, no el derecho a
  // mirar sus propios datos. Sin esto, alguien de una rama sin permisos entraría
  // a un hub vacío.
  const restringida = { label: 'DORA', audience: { branches: ['no-existe'] }, managedBy: {} };
  await db().doc('toolPolicies/dora').set(restringida);
  await signInAs(page, 'engineer');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Mi espacio' })).toBeVisible();
  await expect(page.locator('[data-tool-id="dora"]')).toBeHidden();
  await db().doc('toolPolicies/dora').delete();
});

test('Mi espacio tiene su «Volver» al hub, como cualquier herramienta', async ({ page }) => {
  await signInAs(page, 'engineer');
  await page.goto('/mi-espacio');
  await expect(page.getByRole('link', { name: '← Volver' })).toBeVisible();
});

test('en Mi espacio solo está lo personal, sin duplicar las cards del hub', async ({ page }) => {
  await signInAs(page, 'engineer');
  await page.goto('/mi-espacio');
  await expect(page.getByRole('tab', { name: 'Mi ficha' })).toBeVisible();
  for (const duplicada of ['Marea', 'Retros', 'Kudos', 'Motivadores']) {
    await expect(page.getByRole('tab', { name: duplicada })).toHaveCount(0);
  }
});

test('la administración es un enlace junto a las pestañas, y abre aparte', async ({ page }) => {
  // Ya no es una tarjeta del hub (ADR «Tres capas en el hub»): es gobierno, no
  // uso diario, y su página tiene ocho pestañas propias dentro.
  await signInAs(page, 'superadmin');
  await page.goto('/');
  const admin = page.locator('#admin-link');
  await expect(admin).toBeVisible();
  await expect(admin).toContainText('Administración');
  await expect(admin).toHaveAttribute('target', '_blank');
  // Y no queda ninguna tarjeta de gobierno suelta en la rejilla.
  await expect(page.locator('#tenant-tools [data-admin-only]')).toHaveCount(0);
});

test('un ingeniero no ve la administración por ninguna parte', async ({ page }) => {
  await signInAs(page, 'engineer');
  await page.goto('/');
  await expect(page.locator('#admin-link')).toBeHidden();
});

test('el panel tiene su «Volver» al hub', async ({ page }) => {
  await signInAs(page, 'superadmin');
  await page.goto('/admin');
  await expect(page.getByRole('link', { name: '← Volver' })).toBeVisible();
});

test('los permisos por persona se gestionan desde su propia sección del panel', async ({ page }) => {
  await db().doc('toolPolicies/dora').set({ label: 'DORA', audience: { branches: ['engineering'] }, managedBy: {} });
  // Si el test muere a medias, esta política se queda puesta y desordena el hub
  // de los demás specs: por eso se retira pase lo que pase.
  try {
  await signInAs(page, 'superadmin');
  await page.goto('/admin');

  await page.getByRole('button', { name: 'Permisos' }).click();
  await page.getByRole('tab', { name: 'Por persona' }).click();
  await expect(page.getByRole('heading', { name: 'Permisos por persona' })).toBeVisible();

  // Se elige a alguien y se ve qué le toca por su rol antes de decidir.
  await page.getByLabel('Persona').selectOption({ label: 'Persona del manager' });
  const fila = page.locator('person-permissions tr', { hasText: 'DORA' });
  const ve = fila.getByLabel('Ve o usa');
  // La etiqueta de «heredar» dice qué pasa si no tocas nada.
  await expect(ve).toContainText('Heredar (no)');
  // Y la misma matriz que la ficha: también se decide quién la GESTIONA.
  await expect(fila.getByLabel('Gestiona')).toBeVisible();

  // Dársela sin tocar su rol: queda como excepción en su ficha.
  await ve.selectOption('yes');
  await expect.poll(async () => {
    const snap = await db().collection('people').where('name', '==', 'Persona del manager').get();
    return snap.docs[0]?.data()?.toolOverrides?.dora?.use ?? null;
  }, { timeout: 15_000 }).toBe(true);

  // Y «heredar» la retira, en vez de dejar un «no» escrito que nadie entiende.
  await ve.selectOption('inherit');
  await expect.poll(async () => {
    const snap = await db().collection('people').where('name', '==', 'Persona del manager').get();
    return snap.docs[0]?.data()?.toolOverrides?.dora ?? null;
  }, { timeout: 15_000 }).toBeNull();

  } finally {
    await db().doc('toolPolicies/dora').delete();
  }
});

/** La política de Encuestas, con audiencia igual a quien la gestiona. */
async function conPoliticaDeEncuestas(fn) {
  await db().doc('toolPolicies/surveys').set({
    label: 'Encuestas de clima',
    audience: { branches: ['people'] },
    managedBy: { branches: ['people'] },
  });
  try { await fn(); } finally { await db().doc('toolPolicies/surveys').delete(); }
}

test('Encuestas se rige por su política, sin marcador propio', async ({ page }) => {
  // Antes llevaba `data-survey-tool` y se filtraba aparte, herencia de cuando
  // People era un rol suelto (RMR-TSK-0477). Ahora es una card como las demás.
  await conPoliticaDeEncuestas(async () => {
    await signInAs(page, 'superadmin');
    await page.goto('/');
    await expect(page.locator('[data-tool-id="surveys"]:not([hidden])')).toBeVisible();
    await expect(page.locator('[data-survey-tool]')).toHaveCount(0);
  });
});

test('quien no está en la audiencia de Encuestas no ve su card', async ({ page }) => {
  await conPoliticaDeEncuestas(async () => {
    await signInAs(page, 'engineer');
    await page.goto('/');
    // El hub ha cargado (se ve alguna card), pero la de encuestas no está.
    await expect(page.locator('[data-personal]')).toBeVisible();
    await expect(page.locator('[data-tool-id="surveys"]:not([hidden])')).toHaveCount(0);
  });
});

test('al simular otra vista, Encuestas sigue la política y no el gobierno', async ({ page }) => {
  // La card dejó de tener filtro propio, así que aquí manda la política con la
  // ficha de quien mira: un superadmin cuya persona no está en la audiencia deja
  // de verla en cuanto simula, porque simular apaga el gobierno (RMR-TSK-0477).
  await conPoliticaDeEncuestas(async () => {
    await signInAs(page, 'superadmin');
    await page.goto('/');
    await expect(page.locator('[data-tool-id="surveys"]:not([hidden])')).toBeVisible();

    await page.getByRole('group', { name: 'Cambiar de vista' }).getByRole('button', { name: 'Empleado' }).click();
    await expect(page.locator('[data-tool-id="surveys"]:not([hidden])')).toHaveCount(0);
  });
});
