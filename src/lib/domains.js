/**
 * Lectura y escritura del catálogo de DOMINIOS y SUBDOMINIOS
 * (ADR «De squads a dominios y subdominios»).
 *
 * Colecciones de la organización, planas y de primer nivel:
 *   /domains/{id}      { key, name, channel? }
 *   /subdomains/{id}   { key, name, domainKey, linearProject?, githubTeam? }
 *
 * El subdominio referencia a su dominio por `domainKey` y no por el id del
 * documento: `key` es la clave del contrato entre sistemas, y así el enganche se
 * lee igual desde GREBLA, desde el portal o desde un volcado. Las reglas exigen
 * que ambos vengan con `key` y que el subdominio traiga su `domainKey`.
 *
 * Las lee cualquiera con acceso (para pintar a qué pertenece cada persona) y las
 * escribe solo el superadmin, igual que el catálogo al que sustituyen.
 *
 * La lógica pura —validar claves, agrupar, rotular— vive en
 * src/tools/team/domain/domains.js; aquí solo está la IO.
 */
import { collection, doc, getDocs, getDocsFromServer, setDoc, updateDoc, deleteDoc, addDoc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase.js';

const DOMAINS = 'domains';
const SUBDOMAINS = 'subdomains';

/** @param {import('firebase/firestore').QuerySnapshot} snap */
const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

/**
 * El catálogo se lee SIEMPRE del servidor, saltándose la caché local
 * (RMR-BUG-0112). Con estos datos se valida que una clave no esté repetida, y
 * la clave es la identidad de la entidad para el resto de sistemas: validar
 * contra una copia vieja dejaría crear un duplicado, que es lo único que este
 * modelo no puede permitirse. Son nueve documentos y se miran en una pantalla
 * de administración, así que el viaje no le cuesta a nadie.
 * @param {string} col
 */
const fromServer = (col) => getDocsFromServer(collection(db, col));

/**
 * Catálogo de dominios, ordenado por nombre.
 * @returns {Promise<Array<{ id: string, key: string, name: string, channel?: string }>>}
 */
export async function listDomains() {
  return rows(await fromServer(DOMAINS))
    .toSorted((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'es'));
}

/**
 * Catálogo de subdominios, ordenado por nombre.
 * @returns {Promise<Array<{ id: string, key: string, name: string, domainKey: string,
 *   linearProject?: string, githubTeam?: string }>>}
 */
export async function listSubdomains() {
  return rows(await fromServer(SUBDOMAINS))
    .toSorted((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'es'));
}

/**
 * Crea un dominio JUNTO A su «Core», en una sola escritura atómica.
 *
 * Van juntos a propósito: la regla del modelo es que todo dominio tiene al menos
 * un subdominio, porque lo que se mide es el subdominio. En dos escrituras
 * sueltas, un fallo en la segunda dejaría un dominio sin Core —inmedible— y
 * nadie se enteraría hasta que faltasen sus métricas.
 *
 * El `key` se pasa explícito y nunca se deriva aquí del nombre: es la clave del
 * contrato, y derivarla es lo que hoy parte las series históricas al renombrar.
 *
 * @param {{ key: string, name: string, coreKey: string, coreName: string }} data
 * @returns {Promise<string>} id del dominio
 */
export async function createDomainWithCore({ key, name, coreKey, coreName }) {
  const batch = writeBatch(db);
  const domainRef = doc(collection(db, DOMAINS));
  batch.set(domainRef, { key, name, createdAt: serverTimestamp() });
  batch.set(doc(collection(db, SUBDOMAINS)),
    { key: coreKey, name: coreName, domainKey: key, createdAt: serverTimestamp() });
  await batch.commit();
  return domainRef.id;
}

/**
 * Crea un subdominio dentro de un dominio ya existente.
 * @param {{ key: string, name: string, domainKey: string }} data
 * @returns {Promise<string>}
 */
export async function createSubdomain({ key, name, domainKey }) {
  const created = await addDoc(collection(db, SUBDOMAINS),
    { key, name, domainKey, createdAt: serverTimestamp() });
  return created.id;
}

/**
 * Renombra un dominio o subdominio. NO toca su `key`: ese es justo el punto del
 * modelo — el rótulo se puede cambiar cuantas veces haga falta sin que nada más
 * se entere.
 * @param {'domain'|'subdomain'} kind
 * @param {string} id
 * @param {string} name
 * @returns {Promise<void>}
 */
export function renameScope(kind, id, name) {
  return updateDoc(doc(db, kind === 'domain' ? DOMAINS : SUBDOMAINS, id), { name });
}

/**
 * Borra un subdominio. El caller debe haber comprobado que no tiene métricas
 * publicadas: borrarlo con serie viva la deja huérfana en el portal.
 * @param {string} id
 * @returns {Promise<void>}
 */
export function deleteSubdomain(id) {
  return deleteDoc(doc(db, SUBDOMAINS, id));
}

/**
 * Escribe un dominio con id conocido. Solo lo usa la migración desde el catálogo
 * antiguo, que CONSERVA los ids para no romper las referencias existentes.
 * @param {string} id
 * @param {{ key: string, name: string, channel?: string }} data
 * @returns {Promise<void>}
 */
export function putDomainWithId(id, data) {
  return setDoc(doc(db, DOMAINS, id), data, { merge: true });
}

/**
 * Escribe un subdominio con id conocido. Igual que el anterior: solo migración.
 * @param {string} id
 * @param {{ key: string, name: string, domainKey: string }} data
 * @returns {Promise<void>}
 */
export function putSubdomainWithId(id, data) {
  return setDoc(doc(db, SUBDOMAINS, id), data, { merge: true });
}
