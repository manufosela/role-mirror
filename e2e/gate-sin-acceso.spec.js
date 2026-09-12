/**
 * E2E del GATE de página: qué pasa cuando entras donde no te toca
 * (RMR-TSK-0491, épica RMR-PCS-0027 · F3).
 *
 * Faltaba fijarlo, y es lo único que importa de verdad: ocultar una tarjeta o
 * una pestaña organiza, no protege. Cualquiera puede escribir la URL a mano —o
 * desocultar el botón desde la consola— así que la puerta tiene que estar
 * cerrada donde se decide el acceso, no donde se pinta.
 *
 * OJO al escribirlos: el gate NO redirige. Sustituye el contenido de la página
 * por la pantalla de «sin acceso» y deja la URL intacta. Dar por hecho que
 * redirige ya hizo fallar un test antes, y el fallo parecía un agujero cuando
 * era una suposición equivocada.
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { test, expect, signInAs } from './fixtures.js';

function db() {
  if (getApps().length === 0) initializeApp({ projectId: 'demo-grebla' });
  return getFirestore();
}

/** La política de una herramienta, puesta a lo que haga falta y retirada al salir. */
async function conPolitica(toolId, audience, fn) {
  const previa = (await db().doc(`toolPolicies/${toolId}`).get()).data() ?? null;
  await db().doc(`toolPolicies/${toolId}`).set({ label: 'Marea', audience, managedBy: {} });
  try { await fn(); } finally {
    if (previa) await db().doc(`toolPolicies/${toolId}`).set(previa);
    else await db().doc(`toolPolicies/${toolId}`).delete();
  }
}

const sinAcceso = (page) => page.getByRole('heading', { name: 'No tienes acceso a esta herramienta' });

test('quien no está en la audiencia ve la pantalla de «sin acceso»', async ({ page }) => {
  // Audiencia acotada a una rama que no existe: nadie la cumple.
  await conPolitica('marea', { branches: ['no-existe'] }, async () => {
    await signInAs(page, 'engineer');
    await page.goto('/marea');

    await expect(sinAcceso(page)).toBeVisible();
    // Y la herramienta NO se monta: no es que se pinte y luego se tape.
    await expect(page.locator('marea-app')).toHaveCount(0);
  });
});

test('la pantalla de «sin acceso» ofrece la salida, no deja encerrado', async ({ page }) => {
  await conPolitica('marea', { branches: ['no-existe'] }, async () => {
    await signInAs(page, 'engineer');
    await page.goto('/marea');

    await page.getByRole('link', { name: '← Volver al inicio' }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test('con la política abierta, la misma herramienta se monta', async ({ page }) => {
  // El contraste importa: sin él, un test verde solo diría que la página está
  // rota para todo el mundo.
  await conPolitica('marea', { everyone: true }, async () => {
    await signInAs(page, 'engineer');
    await page.goto('/marea');

    await expect(sinAcceso(page)).toHaveCount(0);
    await expect(page.locator('marea-app')).toBeVisible();
  });
});
