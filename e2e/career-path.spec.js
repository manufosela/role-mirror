/**
 * E2E del CAREER PATH como herramienta propia (RMR-TSK-0488).
 *
 * Los niveles y lo que se espera de cada uno ya se podían consultar, pero
 * enterrados en «Mi espacio › Mi carrera › La escalera»: había que saber que
 * estaban ahí dentro. Ahora es una herramienta con su puerta y se ve entera al
 * entrar.
 *
 * Lo que más importa fijar: esto se AÑADE. Que la escalera sigue estando en
 * «Mi espacio» lo fija escalera.spec.js, que pasa sin haberlo tocado — y por eso
 * no se repite aquí con otra siembra distinta de la misma ficha.
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { test, expect, signInAs } from './fixtures.js';

function db() {
  if (getApps().length === 0) initializeApp({ projectId: 'demo-grebla' });
  return getFirestore();
}

const FRAMEWORK = {
  name: 'Engineering',
  tracks: [{ id: 'ic', name: 'Individual Contributor', order: 1 }],
  levels: [
    { id: 'l1', trackId: 'ic', code: 'L1', title: 'Engineer', order: 1, description: 'Entrega con ayuda.' },
    { id: 'l2', trackId: 'ic', code: 'L2', title: 'Engineer II', order: 2, description: 'Entrega sola.' },
  ],
  dimensions: [{ id: 'tech', name: 'Técnica', order: 1 }],
  expectations: [{ levelId: 'l1', dimensionId: 'tech', text: 'Escribe código que otros leen.' }],
  disciplines: [],
  addendums: [],
};

/**
 * Siembra política y framework, y DEVUELVE los dos como estaban. El framework es
 * estado compartido —otros specs lo usan—, así que dejarlo puesto haría que el
 * siguiente test midiera datos que no son suyos.
 */
async function conEscalera(fn) {
  const politicaPrevia = (await db().doc('toolPolicies/careerpath').get()).data() ?? null;
  const frameworkPrevio = (await db().doc('careerFramework/engineering').get()).data() ?? null;
  await db().doc('toolPolicies/careerpath').set({
    label: 'Career path', audience: { everyone: true }, managedBy: {},
  });
  await db().doc('careerFramework/engineering').set(FRAMEWORK);
  try { await fn(); } finally {
    if (politicaPrevia) await db().doc('toolPolicies/careerpath').set(politicaPrevia);
    else await db().doc('toolPolicies/careerpath').delete();
    if (frameworkPrevio) await db().doc('careerFramework/engineering').set(frameworkPrevio);
    else await db().doc('careerFramework/engineering').delete();
  }
}

test('el career path se ve entero al entrar, sin pasos intermedios', async ({ page }) => {
  await conEscalera(async () => {
    await signInAs(page, 'engineer');
    await page.goto('/tools/career-path');

    // Sin pestañas ni desplegables: los niveles están a la vista.
    await expect(page.locator('tool-nav')).toContainText('Career path');
    await expect(page.getByRole('heading', { name: 'Individual Contributor' })).toBeVisible();
    const codigos = await page.locator('career-ladder .rung .code').allInnerTexts();
    expect(codigos).toEqual(['L1', 'L2']);
    // Y lo que implica cada uno, DESPLEGADO: venir a consultar qué implica un
    // nivel y encontrarlo plegado es el mismo recoveco con otra forma.
    await expect(page.locator('career-ladder .rung').first()).toContainText('Técnica');
    await expect(page.locator('career-ladder details.fold').first()).toHaveAttribute('open', '');
    await expect(page.locator('career-ladder .fold-body').first())
      .toHaveText('Escribe código que otros leen.');
  });
});

test('es una herramienta del hub, en la pestaña de Ingeniería', async ({ page }) => {
  await conEscalera(async () => {
    await signInAs(page, 'superadmin');
    await page.goto('/');

    const tarjeta = page.locator('[data-tool-id="careerpath"]');
    await expect(tarjeta).toHaveAttribute('data-layer', 'ingenieria');
    await page.locator('#hub-layers .layer-tabs button:not([hidden])', { hasText: 'Ingeniería' }).click();
    await expect(tarjeta).toBeVisible();

    await tarjeta.click();
    await expect(page).toHaveURL(/\/tools\/career-path/);
  });
});

test('sin ficha se ve igual: el marco de niveles es de la organización', async ({ page }) => {
  // Quien no tiene ficha no tiene «estás aquí», pero los niveles son los mismos
  // y tiene el mismo derecho a saber qué se espera en cada uno.
  await conEscalera(async () => {
    await signInAs(page, 'superadmin');
    await page.goto('/tools/career-path');

    await expect(page.locator('career-ladder .rung')).toHaveCount(2);
    await expect(page.locator('career-ladder .mark')).toHaveCount(0);
  });
});
