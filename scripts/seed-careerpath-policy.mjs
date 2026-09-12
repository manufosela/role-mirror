/**
 * Da de alta la política de la herramienta CAREER PATH (RMR-TSK-0488).
 *
 * La escalera de niveles pasa a ser herramienta propia, y en este sistema una
 * herramienta sin política no la ve nadie salvo el superadmin —y su gate corta
 * al entrar—. Así que hay que sembrarla antes de desplegar.
 *
 * La audiencia se COPIA de la del Mapa de Carrera: quien puede ver su carrera
 * puede ver la escalera. No se inventa una nueva ni se abre a todos, que sería
 * decidir por el usuario algo que ya está decidido para la herramienta hermana.
 *
 * Nadie pierde acceso: la escalera sigue estando en «Mi espacio › Mi carrera»,
 * que no pasa por política.
 *
 * SEGURO: dry-run por defecto e idempotente (si ya existe, no la pisa).
 *
 * Uso:
 *   node scripts/seed-careerpath-policy.mjs --target=tribbu            (dry-run)
 *   node scripts/seed-careerpath-policy.mjs --target=tribbu --apply
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { serviceAccountPath } from './lib/service-account.mjs';

const target = (process.argv.find((a) => a.startsWith('--target=')) || '').split('=')[1] || 'app';
const apply = process.argv.includes('--apply');

initializeApp({ credential: cert(serviceAccountPath(target)) });
const db = getFirestore();

const ya = await db.doc('toolPolicies/careerpath').get();
if (ya.exists) {
  console.log(`[${target}] careerpath ya tiene política: ${JSON.stringify(ya.data().audience)} — no se toca.`);
  process.exit(0);
}

const carrera = await db.doc('toolPolicies/career').get();
if (!carrera.exists) {
  console.log(`[${target}] no existe la política de «career»: no se copia a ciegas. Créala primero.`);
  process.exit(1);
}

const politica = {
  label: 'Career path',
  audience: carrera.data().audience ?? {},
  managedBy: carrera.data().managedBy ?? {},
};
console.log(`[${target}] careerpath ← audiencia de career: ${JSON.stringify(politica.audience)}`);

if (!apply) {
  console.log('\nDry-run: no se ha escrito nada. Repite con --apply.');
  process.exit(0);
}
await db.doc('toolPolicies/careerpath').set(politica);
console.log(`✓ [${target}] política de careerpath creada.`);
