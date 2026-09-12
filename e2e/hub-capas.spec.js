/**
 * E2E de las CAPAS del hub (ADR «Tres capas en el hub», RMR-TSK-0487).
 *
 * Lo que se defiende aquí es que las pestañas digan la verdad sobre quien mira:
 * se derivan de las tarjetas que han quedado visibles, así que una pestaña nunca
 * aparece vacía ni enseña algo que su dueño no tendría. Y lo que más importa:
 * al SIMULAR un rol, las pestañas son las de ese rol — si no, el superadmin
 * creería estar viendo lo que ve un empleado y estaría viendo lo suyo.
 */
import { test, expect, signInAs } from './fixtures.js';

// Los dos botones existen SIEMPRE en el HTML (los estilos de Astro no alcanzan
// a lo que crea el cliente), así que aquí se cuentan solo los que se ven: si no,
// un `toHaveCount(2)` pasaría antes incluso de que el hub se pintara.
const pestanas = (page) => page.locator('#hub-layers .layer-tabs button:not([hidden])');
const pestana = (page, nombre) => page.locator('#hub-layers .layer-tabs button:not([hidden])', { hasText: nombre });
const vista = (page, nombre) => page.getByRole('button', { name: nombre, exact: true });
/** Tarjetas que se están viendo AHORA: ni ocultas por política ni de otra capa. */
const visibles = async (page) => (await page
  .locator('#tenant-tools [data-tool-id]:not([hidden]):not([data-off-layer])')
  .evaluateAll((els) => els.map((e) => e.dataset.toolId))).sort();
/**
 * ¿Cuadra la barra con lo que hay? Lee las capas con tarjeta y las pestañas en
 * la MISMA evaluación, para no comparar dos fotos de instantes distintos.
 */
const barra = (page) => page.evaluate(() => {
  const capas = [...new Set([...document.querySelectorAll('#tenant-tools [data-layer]:not([hidden])')]
    .map((e) => e.dataset.layer))].toSorted();
  const tabs = [...document.querySelectorAll('#hub-layers .layer-tabs button:not([hidden])')]
    .map((e) => e.dataset.layer).toSorted();
  // Una sola capa no lleva pestañas: una pestaña sola no es una pestaña.
  const esperadas = capas.length > 1 ? capas : [];
  return { capas, tabs, cuadra: tabs.join() === esperadas.join() };
});

test('un superadmin ve las dos pestañas, y cada una enseña lo suyo', async ({ page }) => {
  await signInAs(page, 'superadmin');
  await page.goto('/');

  await expect(pestanas(page)).toHaveCount(2);
  await expect(pestanas(page).first()).toHaveText('TRIBBU');

  // TRIBBU arranca abierta y NO enseña lo de ingeniería.
  const enTribbu = await visibles(page);
  expect(enTribbu).toContain('kudos');
  expect(enTribbu).not.toContain('dora');

  await pestana(page, 'Ingeniería').click();
  const enIngenieria = await visibles(page);
  expect(enIngenieria).toContain('dora');
  expect(enIngenieria).not.toContain('kudos');
});

test('la pestaña abierta se marca, y solo una', async ({ page }) => {
  await signInAs(page, 'superadmin');
  await page.goto('/');
  await pestana(page, 'Ingeniería').click();

  await expect(pestana(page, 'Ingeniería')).toHaveAttribute('aria-selected', 'true');
  await expect(pestana(page, 'TRIBBU')).toHaveAttribute('aria-selected', 'false');
});

test('al simular a un empleado, el hub se pinta como lo vería él', async ({ page }) => {
  // El punto entero del conmutador: un superadmin tiene que poder ver lo que ve
  // cada perfil. Si la barra siguiera siendo la del superadmin, la simulación
  // mentiría con aspecto de verdad.
  await signInAs(page, 'superadmin');
  await page.goto('/');
  await expect(page.locator('#admin-link')).toBeVisible();

  await vista(page, 'Empleado').click();

  // La administración es de quien gobierna: simulando, desaparece.
  await expect(page.locator('#admin-link')).toBeHidden();
  // Y la barra sigue cuadrando con lo que ese rol tiene delante.
  await expect.poll(async () => (await barra(page)).cuadra).toBe(true);
});

test('las pestañas cuadran SIEMPRE con las capas que tienen tarjetas', async ({ page }) => {
  // La invariante que sostiene el diseño: las pestañas se derivan de lo que ha
  // quedado visible, nunca de un cálculo paralelo desde el rol. Así no puede
  // aparecer una pestaña vacía ni faltar una que sí tiene herramientas.
  await signInAs(page, 'superadmin');
  await page.goto('/');

  for (const rol of ['Manager', 'Ingeniero', 'Empleado', 'Admin (superadmin)']) {
    await vista(page, rol).click();
    // Con poll: cambiar de vista repinta el hub de forma asíncrona, y sin
    // esperar se leería el estado anterior.
    await expect.poll(async () => (await barra(page)).cuadra, { message: `vista ${rol}` }).toBe(true);
  }
});

test('al volver de la simulación, vuelve lo del superadmin', async ({ page }) => {
  await signInAs(page, 'superadmin');
  await page.goto('/');
  await vista(page, 'Empleado').click();
  await expect(page.locator('#admin-link')).toBeHidden();

  await vista(page, 'Admin (superadmin)').click();

  await expect(pestanas(page)).toHaveCount(2);
  await expect(page.locator('#admin-link')).toBeVisible();
});

test('una herramienta de otra capa sigue siendo alcanzable por su URL', async ({ page }) => {
  // Las pestañas ORGANIZAN, no protegen: la capa no es una puerta. Quien tiene
  // acceso entra igual escribiendo la dirección, y quien no lo tiene se topa
  // con el gate de la herramienta, que es quien decide — igual que antes.
  await signInAs(page, 'superadmin');
  await page.goto('/');
  await expect(pestana(page, 'TRIBBU')).toHaveAttribute('aria-selected', 'true');

  await page.goto('/tools/dora');
  await expect(page).toHaveURL(/\/tools\/dora/);
});
