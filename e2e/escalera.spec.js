/**
 * E2E de LA ESCALERA (RMR-TSK-0471). Todos los niveles con sus características
 * estaban solo en el editor del panel: para saber a qué aspirar había que ser
 * superadmin o preguntarle a alguien. Ahora se consultan desde «Mi carrera».
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { test, expect, signInAs } from './fixtures.js';

function db() {
  if (getApps().length === 0) initializeApp({ projectId: 'demo-grebla' });
  return getFirestore();
}

const FRAMEWORK = {
  tracks: [
    { id: 'ic', name: 'Individual Contributor', order: 1, description: 'Su output es el trabajo técnico.' },
    { id: 'em', name: 'Engineering Manager', order: 2, description: 'Cuida de las personas del equipo.' },
    { id: 'sinniveles', name: 'Itinerario en blanco', order: 3, description: '' },
  ],
  levels: [
    { id: 'l1', code: 'L1', title: 'Engineer', trackId: 'ic', order: 1, description: 'Trabaja de forma independiente.', typicalProfile: '2-5 años' },
    { id: 'l2', code: 'L2', title: 'Senior Engineer', trackId: 'ic', order: 2, description: 'Dueño de decisiones no triviales.', typicalProfile: '5+ años' },
    { id: 'm1', code: 'M1', title: 'Engineering Manager', trackId: 'em', order: 1, description: 'Lleva un equipo.', typicalProfile: '' },
  ],
  dimensions: [{ id: 'impacto', name: 'Impacto', order: 1 }],
  disciplines: [],
  expectations: [
    { levelId: 'l1', dimensionId: 'impacto', text: 'Su propio trabajo.' },
    { levelId: 'l2', dimensionId: 'impacto', text: 'Su área.' },
  ],
  addendums: [],
};

/** El ingeniero de las fixtures, con nivel L1 y objetivo L2 declarado. */
async function conFramework(fn, { levelId = 'l1', targetId = 'l2' } = {}) {
  await db().doc('careerFramework/engineering').set(FRAMEWORK);
  const antes = (await db().doc('people/e2e-person-eng').get()).data();
  await db().doc('people/e2e-person-eng').set({ ...antes, levelId, careerTargetLevelId: targetId });
  try { await fn(); } finally {
    await db().doc('careerFramework/engineering').delete();
    await db().doc('people/e2e-person-eng').set(antes);
  }
}

test('la escalera enseña todos los itinerarios y niveles, no solo el tuyo', async ({ page }) => {
  await conFramework(async () => {
    await signInAs(page, 'engineer');
    await page.goto('/mi-espacio');
    await page.getByRole('tab', { name: 'Mi carrera' }).click();
    await page.getByRole('tab', { name: 'La escalera' }).click();

    // Los dos itinerarios con niveles, y sus peldaños en orden.
    await expect(page.getByRole('heading', { name: 'Individual Contributor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Engineering Manager' })).toBeVisible();
    const codigos = await page.locator('engineer-space .rung .code').allInnerTexts();
    expect(codigos).toEqual(['L1', 'L2', 'M1']);

    // En la lista, lo justo para elegir: código, título y a quién describe.
    const l2 = page.locator('engineer-space .rung', { hasText: 'Senior Engineer' });
    await expect(l2).toContainText('5+ años');
    // El detalle, al desplegarlo (RMR-TSK-0492): con los doce niveles abiertos
    // de golpe no se ve nada.
    await l2.locator('summary').click();
    await expect(l2).toContainText('Dueño de decisiones no triviales');
    await expect(l2.getByText('Impacto')).toBeVisible();
  });
});

test('un itinerario sin niveles no se lista', async ({ page }) => {
  await conFramework(async () => {
    await signInAs(page, 'engineer');
    await page.goto('/mi-espacio');
    await page.getByRole('tab', { name: 'Mi carrera' }).click();
    await page.getByRole('tab', { name: 'La escalera' }).click();

    // Una columna vacía no informa de nada.
    await expect(page.getByRole('heading', { name: 'Itinerario en blanco' })).toHaveCount(0);
  });
});

test('la escalera dice dónde estás y a dónde vas', async ({ page }) => {
  await conFramework(async () => {
    await signInAs(page, 'engineer');
    await page.goto('/mi-espacio');
    await page.getByRole('tab', { name: 'Mi carrera' }).click();
    await page.getByRole('tab', { name: 'La escalera' }).click();

    await expect(page.locator('engineer-space .rung', { hasText: 'Engineer' }).first()).toContainText('Estás aquí');
    await expect(page.locator('engineer-space .rung', { hasText: 'Senior Engineer' })).toContainText('Tu objetivo');
  });
});

test('con el framework vacío lo dice, en vez de enseñar una página en blanco', async ({ page }) => {
  // Sin documento en Firestore NO significa 'sin framework': el tool cae a la
  // semilla en código. El vacío de verdad es un documento sin itinerarios.
  await db().doc('careerFramework/engineering').set({ tracks: [], levels: [], dimensions: [], disciplines: [], expectations: [], addendums: [] });
  try {
    await signInAs(page, 'engineer');
    await page.goto('/mi-espacio');
    await page.getByRole('tab', { name: 'Mi carrera' }).click();
    await page.getByRole('tab', { name: 'La escalera' }).click();

    await expect(page.locator('engineer-space')).toContainText('aún no está configurado');
  } finally {
    await db().doc('careerFramework/engineering').delete();
  }
});

test('atrás y adelante devuelven a la sub-pestaña que dice el hash', async ({ page }) => {
  await conFramework(async () => {
    await signInAs(page, 'engineer');
    await page.goto('/mi-espacio#escalera');
    await page.evaluate(() => { location.hash = 'carrera'; });

    // #carrera es la pestaña sin sub-pestaña fijada: toca la primera. Si el
    // handler solo atendiera «mapa» y «escalera», la escalera se quedaría puesta
    // y se vería una sección que no es la que dice el hash.
    await expect(page.getByRole('tab', { name: 'Nivel y expectativas' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'La escalera' })).toHaveAttribute('aria-selected', 'false');
  });
});
