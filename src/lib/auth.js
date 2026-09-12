/**
 * Helpers de autenticación (Google OAuth) y gestión del rol admin.
 *
 * @typedef {import('firebase/auth').User} User
 */
import {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db, googleProvider, forgetCachedData } from './firebase.js';

/**
 * Registra la presencia del usuario en /users/{uid} (directorio de quién ha
 * entrado y cuándo, para la pestaña Usuarios del panel). La escritura es
 * idempotente (setDoc merge) y no bloquea el flujo de sesión si falla; se escribe
 * en cada cambio de estado con sesión, lo que además refresca `lastLogin`.
 * @param {User} user
 */
async function registerUserPresence(user) {
  try {
    await setDoc(
      doc(db, 'users', user.uid),
      {
        displayName: user.displayName ?? null,
        email: user.email ?? null,
        photoURL: user.photoURL ?? null,
        lastLogin: serverTimestamp(),
      },
      { merge: true },
    );
  } catch (err) {
    // Best-effort: no debe romper la sesión, pero lo dejamos visible para depurar.
    console.warn('No se pudo registrar la presencia del usuario en /users:', err);
  }
}

// Suscripción global (una por contexto de página): registra al usuario en cuanto
// hay sesión, para que aparezca en el directorio /users aunque aún no tenga rol.
onAuthStateChanged(auth, (user) => {
  if (user) registerUserPresence(user);
});

/**
 * Suscribe a cambios de sesión. Devuelve la función para desuscribirse.
 * @param {(user: User|null) => void} callback
 * @returns {() => void}
 */
export function onUserChanged(callback) {
  return onAuthStateChanged(auth, callback);
}

/** Usuario actualmente autenticado (o null). @returns {User|null} */
export function getCurrentUser() {
  return auth.currentUser;
}

/**
 * Inicia sesión con Google mediante popup.
 * @returns {Promise<User>}
 */
export async function signInWithGoogle() {
  const credential = await signInWithPopup(auth, googleProvider);
  return credential.user;
}

/**
 * Cierra la sesión actual y OLVIDA lo cacheado en este dispositivo.
 *
 * El orden importa: primero se cierra la sesión —que es lo que el usuario ha
 * pedido y no puede fallar por nada— y después se limpia la caché. Al revés, un
 * fallo al limpiar dejaría la sesión abierta.
 * @returns {Promise<void>}
 */
export async function signOutUser() {
  await signOut(auth);
  await forgetCachedData();
  // Limpiar la caché deja la instancia de Firestore terminada e inservible, así
  // que se vuelve a casa con la página recargada. Al cerrar sesión es además lo
  // que se espera: salir, no quedarse en una pantalla que ya no es tuya.
  globalThis.location.assign('/');
}

/**
 * Indica si un uid es administrador (existe /admins/{uid}).
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
export async function isAdmin(uid) {
  if (!uid) return false;
  const snapshot = await getDoc(doc(db, 'admins', uid));
  return snapshot.exists();
}

// El alta de administradores se hace SOLO server-side (Admin SDK / script de
// seed / Cloud Function `grantAdmin`). No existe ningún mecanismo cliente para
// auto-concederse admin: sería un agujero de seguridad.
