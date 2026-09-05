/**
 * Composition root de LEAN: selecciona la persistencia (memory/firestore) y expone
 * `refresh` (la Cloud Function que recalcula desde Linear). Espeja DORA.
 *
 * @typedef {import('../domain/ports.js').LeanPersistence} LeanPersistence
 */
import { createMemoryLeanPersistence } from '../infrastructure/memory/index.js';
import { createFirestoreLeanPersistence } from '../infrastructure/firestore/persistence.js';

/**
 * @param {Object} [options]
 * @param {'memory'|'firestore'} [options.mode]
 * @param {import('firebase/firestore').Firestore|null} [options.db]
 * @param {string|null} [options.leaderUid]
 * @param {boolean} [options.viewAll]
 * @param {object} [options.seed]  Solo para mode 'memory'.
 * @returns {Promise<{ mode: string, persistence: LeanPersistence, refresh: () => Promise<object> }>}
 */
export async function createLeanContainer(options = {}) {
  const { mode = 'firestore', db = null, leaderUid = null, viewAll = false, seed } = options;
  if (mode === 'memory') {
    return {
      mode,
      persistence: createMemoryLeanPersistence(seed, { leaderUid, viewAll }),
      refresh: async () => ({ results: [] }),
      discover: async () => ({ created: [] }),
      listTeams: async () => ({ teams: [] }),
    };
  }
  if (mode === 'firestore') {
    if (!leaderUid) throw new Error('El modo Firestore requiere leaderUid (resuelto por el cliente)');
    let database = db;
    if (!database) {
      const firebase = await import('../../../lib/firebase.js');
      database = firebase.db;
    }
    const callFn = async (name) => {
      const { getRegionalFunctions } = await import('../../../lib/firebase.js');
      const { httpsCallable } = await import('firebase/functions');
      const fns = await getRegionalFunctions();
      // El timeout del CLIENTE es 70s por defecto y estas funciones tienen 300s
      // en servidor: sin esto, un recálculo largo daba «deadline-exceeded» en la
      // UI aunque la función terminaba bien (RMR-BUG-0046).
      const res = await httpsCallable(fns, name, { timeout: 300_000 })({});
      return res.data;
    };
    // refresh: recalcula las métricas de flujo desde Linear. discover: auto-descubre
    // equipos (Squad) y gremios (Chapter) desde los labels de Linear.
    const refresh = () => callFn('refreshLean');
    const discover = () => callFn('discoverLeanUnits');
    // listTeams: equipos de Linear para poder medir los que no llevan label de
    // «Squad» —Matcher y Plataforma, hoy invisibles—. Solo lectura.
    const listTeams = () => callFn('listLinearTeams');
    return { mode, persistence: createFirestoreLeanPersistence(database, leaderUid, { viewAll }), refresh, discover, listTeams };
  }
  throw new Error(`Modo de container LEAN desconocido: ${mode}`);
}
