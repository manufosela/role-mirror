/**
 * E2E de la CACHÉ LOCAL y el cierre de sesión (RMR-BUG-0112).
 *
 * Firestore cachea ahora en disco (IndexedDB) para que la segunda visita no
 * vuelva a pedirlo todo por red. Eso deja en el dispositivo fichas de personas,
 * niveles y O2O — datos de gente—, así que al cerrar sesión hay que borrarlos:
 * en un ordenador compartido, el siguiente en entrar se encontraría con los
 * datos del anterior servidos desde el disco.
 *
 * Esto no prueba que la caché sea rápida (en el emulador no hay latencia que
 * ahorrar); prueba que existe y que se limpia.
 */
import { test, expect, signInAs } from './fixtures.js';

/** Bases de IndexedDB que ha creado el SDK de Firestore. */
const cachesDeFirestore = (page) => page.evaluate(async () => {
  const bases = await indexedDB.databases();
  return bases.map((b) => b.name ?? '').filter((n) => n.includes('firestore'));
});

/**
 * Documentos guardados en el disco por el SDK. Se cuentan los REGISTROS, no las
 * bases: al volver a arrancar, Firestore recrea su base vacía, así que «no hay
 * base» no significa «no hay datos» y esperar eso sería una carrera.
 *
 * Si el SDK cambiara el nombre de su almacén, esto devuelve -1 en vez de 0: un
 * test que pasa porque ya no encuentra dónde mirar es peor que uno que falla.
 */
const documentosEnDisco = (page) => page.evaluate(async () => {
  const bases = (await indexedDB.databases()).map((b) => b.name ?? '').filter((n) => n.includes('firestore'));
  let total = 0;
  let encontrado = false;
  for (const nombre of bases) {
    const base = await new Promise((resolve, reject) => {
      const req = indexedDB.open(nombre);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    for (const store of [...base.objectStoreNames].filter((n) => n.startsWith('remoteDocument'))) {
      encontrado = true;
      total += await new Promise((resolve) => {
        const req = base.transaction(store, 'readonly').objectStore(store).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      });
    }
    base.close();
  }
  if (bases.length > 0 && !encontrado) return -1;
  return total;
});

test('la caché local existe: los datos se guardan entre visitas', async ({ page }) => {
  await signInAs(page, 'superadmin');
  await page.goto('/');
  await page.locator('#tenant-tools:not([hidden])').waitFor();

  await expect.poll(async () => (await cachesDeFirestore(page)).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  // Y con documentos dentro: si no, no estaría cacheando nada.
  await expect.poll(async () => documentosEnDisco(page), { timeout: 10_000 }).toBeGreaterThan(0);
});

test('al cerrar sesión se borra: no quedan datos de personas en el dispositivo', async ({ page }) => {
  await signInAs(page, 'superadmin');
  await page.goto('/');
  await page.locator('#tenant-tools:not([hidden])').waitFor();
  expect((await cachesDeFirestore(page)).length).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Salir' }).click();

  // Cero DOCUMENTOS en disco. Que la base exista o no da igual: al recargar, el
  // SDK la recrea vacía, y lo que importa es que no queden datos de nadie.
  await expect.poll(async () => documentosEnDisco(page), { timeout: 15_000 }).toBe(0);
});

test('si no se pudo borrar en el momento, se borra al volver a abrir', async ({ page }) => {
  // Es el caso de tener otra pestaña con la base abierta: el SDK se niega a
  // limpiar. Entonces queda una bandera, y el arranque siguiente la salda antes
  // de que Firestore abra nada — para que no se quede en el disco de un
  // ordenador compartido.
  await signInAs(page, 'superadmin');
  await page.goto('/');
  await page.locator('#tenant-tools:not([hidden])').waitFor();
  expect((await cachesDeFirestore(page)).length).toBeGreaterThan(0);

  // Se simula el fallo: la bandera puesta y la caché intacta.
  await page.evaluate(() => localStorage.setItem('grebla-cache-por-borrar', '1'));
  await page.reload();

  await expect.poll(async () => documentosEnDisco(page), { timeout: 15_000 }).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('grebla-cache-por-borrar'))).toBeNull();
});
