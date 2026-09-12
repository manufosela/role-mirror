/**
 * Inicialización de Firebase (Web SDK).
 *
 * IMPORTANTE: este módulo SOLO debe importarse desde scripts de cliente
 * (componentes Lit o <script> de páginas Astro), nunca desde el frontmatter
 * Astro (servidor), porque depende de variables PUBLIC_* y del runtime de
 * navegador para auth.
 */
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, connectAuthEmulator, signInWithCustomToken } from 'firebase/auth';
import {
  initializeFirestore, getFirestore, connectFirestoreEmulator,
  persistentLocalCache, persistentMultipleTabManager, clearIndexedDbPersistence, terminate,
} from 'firebase/firestore';

/** ¿Se apunta a los emuladores? Solo en E2E; en producción NUNCA (env apagada). */
const useEmulators = import.meta.env.PUBLIC_USE_EMULATORS === 'true';

/** @returns {import('firebase/app').FirebaseOptions} */
function readConfig() {
  const config = {
    apiKey: import.meta.env.PUBLIC_FIREBASE_API_KEY,
    authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.PUBLIC_FIREBASE_APP_ID,
  };

  // Sin fallbacks silenciosos: si falta configuración, fallar de forma explícita.
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Falta configuración de Firebase: ${missing.join(', ')}. ` +
        'Copia .env.example a .env y rellena las variables PUBLIC_FIREBASE_*.',
    );
  }
  return config;
}

/**
 * Bandera de «queda caché por borrar». La deja el cierre de sesión cuando no
 * puede limpiar en caliente —pasa si hay otra pestaña con la base abierta— y se
 * salda AQUÍ, en el arranque siguiente, antes de que Firestore abra nada.
 *
 * Sin esto, un fallo al limpiar dejaba fichas de personas en el disco de un
 * ordenador compartido, y el aviso se quedaba en la consola donde no lo ve
 * nadie (RMR-BUG-0112).
 */
const CACHE_SUCIA = 'grebla-cache-por-borrar';

/** Borra las bases de Firestore a pelo. Aquí se puede: aún no hay nada abierto. */
async function limpiezaPendiente() {
  if (typeof indexedDB === 'undefined' || localStorage.getItem(CACHE_SUCIA) !== '1') return;
  try {
    const bases = await indexedDB.databases();
    const resultados = await Promise.all(bases
      .map((b) => b.name ?? '')
      .filter((nombre) => nombre.includes('firestore'))
      .map((nombre) => new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(nombre);
        // `blocked` es el caso de la otra pestaña, que sigue con la base
        // abierta: cuenta como NO borrada.
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
        req.onblocked = () => resolve(false);
      })));
    // La bandera solo se retira si se borró TODO. Si una quedó bloqueada y se
    // retirara igual, los datos se quedarían en el disco para siempre y nadie
    // volvería a intentarlo — justo lo contrario de para lo que está.
    if (resultados.every(Boolean)) localStorage.removeItem(CACHE_SUCIA);
  } catch {
    // Si ni siquiera se puede enumerar, la bandera se queda y se reintenta.
  }
}
await limpiezaPendiente();

// Reutiliza la app si ya estaba inicializada (HMR / múltiples imports).
const app = getApps().length > 0 ? getApp() : initializeApp(readConfig());

export const auth = getAuth(app);

/**
 * Firestore con CACHÉ PERSISTENTE (RMR-BUG-0112).
 *
 * Por defecto el SDK web cachea en memoria, y la memoria se va con la pestaña:
 * cada recarga volvía a pedir por red hasta el último documento, y por eso la
 * segunda visita tardaba lo mismo que la primera. Con la caché en IndexedDB, lo
 * ya visto se pinta al instante desde el disco y se refresca por detrás.
 *
 * `persistentMultipleTabManager` porque la app se usa con varias pestañas
 * abiertas —el panel en una, la herramienta en otra— y sin él la persistencia
 * se desactiva en todas menos en la primera, en silencio.
 *
 * Lo que queda en el disco son datos de personas, así que al cerrar sesión se
 * borra: ver `forgetCachedData()`, que llama el cierre de sesión.
 */
export const db = getApps().length > 1
  ? getFirestore(app)
  : initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });

export const googleProvider = new GoogleAuthProvider();

/**
 * Borra la caché local de Firestore. Se llama al cerrar sesión: lo cacheado son
 * fichas de personas, niveles y O2O, y en un ordenador compartido el siguiente
 * que entrara se encontraría con los datos del anterior servidos desde disco.
 *
 * El `terminate` NO es opcional: el SDK solo deja limpiar antes de inicializar
 * o después de terminar, y sin él la llamada falla y la caché se queda entera
 * —con la falsa sensación de haberla borrado—. Después de esto la instancia ya
 * no sirve, así que quien lo llama debe recargar.
 *
 * Falla en silencio A PROPÓSITO y solo aquí: si otra pestaña tiene la base
 * abierta, el SDK se niega a borrar, y eso no puede impedir que alguien cierre
 * su sesión. Queda anotado en la consola para que no sea invisible del todo.
 * @returns {Promise<void>}
 */
export async function forgetCachedData() {
  // La bandera se pone ANTES de intentarlo: si el intento falla —otra pestaña
  // con la base abierta— queda constancia y el siguiente arranque la salda.
  localStorage.setItem(CACHE_SUCIA, '1');
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
    localStorage.removeItem(CACHE_SUCIA);
  } catch (err) {
    console.warn('[firebase] la caché local se borrará al volver a abrir (¿otra pestaña?):', err);
  }
}

/**
 * Instancia de Cloud Functions de la región, conectada al emulador cuando toca.
 *
 * Los callables se pedían con `getFunctions(app, 'europe-west1')` en cada sitio,
 * y ahí faltaba lo que sí se hacía con auth y Firestore: apuntar al emulador.
 * En los tests eso significa que la llamada sale hacia el proyecto real y no
 * llega nunca — sin error visible si quien llama se traga la excepción.
 * @returns {Promise<import('firebase/functions').Functions>}
 */
let regionalFunctions = null;
export async function getRegionalFunctions() {
  if (regionalFunctions) return regionalFunctions;
  const { getFunctions, connectFunctionsEmulator } = await import('firebase/functions');
  const fns = getFunctions(app, 'europe-west1');
  if (useEmulators && typeof window !== 'undefined') {
    const host = import.meta.env.PUBLIC_FIRESTORE_EMULATOR_HOST ?? '127.0.0.1';
    connectFunctionsEmulator(fns, host, 5001);
  }
  regionalFunctions = fns;
  return fns;
}

// E2E (RMR-TSK-0299): apuntar a los emuladores y exponer un login por custom
// token para que Playwright entre como cualquier rol sin pasar por el OAuth de
// Google (que no se puede automatizar). Todo esto queda MUERTO en producción:
// PUBLIC_USE_EMULATORS solo se pone en el arranque de los tests.
if (useEmulators && typeof window !== 'undefined') {
  const authHost = import.meta.env.PUBLIC_AUTH_EMULATOR_URL ?? 'http://127.0.0.1:9099';
  const fsHost = import.meta.env.PUBLIC_FIRESTORE_EMULATOR_HOST ?? '127.0.0.1';
  connectAuthEmulator(auth, authHost, { disableWarnings: true });
  connectFirestoreEmulator(db, fsHost, 8181);
  // Puerta de entrada SOLO-test: el arnés inyecta el token de un rol y esto lo
  // canjea por una sesión real del SDK. No existe en el bundle de producción.
  // __e2eUid deja que el test espere una señal REAL de sesión (el uid ya fijado)
  // en vez de adivinar por timing.
  /** @type {any} */ (window).__e2eSignIn = (token) => signInWithCustomToken(auth, token);
  /** @type {any} */ (window).__e2eUid = () => auth.currentUser?.uid ?? null;
}

export { app };
