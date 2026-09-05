/**
 * Da de alta las unidades de flujo que miden un EQUIPO de Linear
 * (RMR-TSK-0485) y comprueba qué queda sin medir.
 *
 * Medido en Linear el 2026-09-05: Matcher (team MAT, 110 issues vivas) y
 * Platform (team PLA, 105) no llevan NINGUNA issue con label del grupo «Squad».
 * Por label son invisibles, y por eso sus subdominios del catálogo —`matcher` y
 * `plataforma-core`— no tenían quien los midiera.
 *
 * Además del alta, el script hace de informe: al terminar dice qué subdominios
 * siguen sin unidad y qué unidades siguen sin subdominio. Un hueco que no se
 * nombra se convierte en «lo medido es todo», que es de donde venimos.
 *
 * SEGURO: dry-run por defecto e idempotente (si la unidad ya existe, no duplica).
 *
 * Uso:
 *   node scripts/seed-lean-team-units.mjs --target=tribbu            (dry-run)
 *   node scripts/seed-lean-team-units.mjs --target=tribbu --apply
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { serviceAccountPath } from './lib/service-account.mjs';
import { classifyUnits } from '../src/tools/lean/domain/scope.js';

const target = (process.argv.find((a) => a.startsWith('--target=')) || '').split('=')[1] || 'app';
const apply = process.argv.includes('--apply');

/**
 * Qué equipo de Linear mide cada subdominio. Escrito a mano: es una decisión de
 * modelo, no algo derivable de un nombre.
 * @type {Array<{ teamKey: string, name: string, subdomainKey: string }>}
 */
const PLAN = [
  { teamKey: 'MAT', name: 'Matcher', subdomainKey: 'matcher' },
  { teamKey: 'PLA', name: 'Plataforma', subdomainKey: 'plataforma-core' },
];

initializeApp({ credential: cert(serviceAccountPath(target)) });
const db = getFirestore();

const [unitsSnap, subsSnap] = await Promise.all([
  db.collection('leanTeams').get(),
  db.collection('subdomains').get(),
]);
const units = unitsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
const subdomains = subsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

// El dueño de las unidades nuevas es el mismo que el de las que ya hay: las
// reglas filtran por `ownerLeaderUid`, y una unidad con otro dueño no la vería
// nadie desde la aplicación.
const owner = units.map((u) => u.ownerLeaderUid).find(Boolean);
if (!owner) {
  console.log(`[${target}] no hay ninguna unidad con dueño: no se sabe a quién asignarlas.`);
  process.exit(1);
}

const acciones = [];
for (const p of PLAN) {
  const ya = units.find((u) => u.linearTeamKey === p.teamKey);
  if (ya) { console.log(`  · ${p.name}: ya existe (${ya.id})`); continue; }
  if (!subdomains.some((s) => s.key === p.subdomainKey)) {
    console.log(`  ⚠ ${p.name}: «${p.subdomainKey}» no está en el catálogo, no se crea`);
    continue;
  }
  acciones.push(p);
}

console.log(`\n[${target}] altas (${acciones.length}):`);
for (const a of acciones) {
  console.log(`  «${a.name}» mide el equipo ${a.teamKey} de Linear → subdominio ${a.subdomainKey}`);
}

if (apply) {
  const now = new Date().toISOString();
  for (const a of acciones) {
    const ref = await db.collection('leanTeams').add({
      linearTeamKey: a.teamKey, name: a.name, kind: 'squad',
      subdomainKey: a.subdomainKey, ownerLeaderUid: owner, createdAt: now,
    });
    console.log(`  ✓ ${a.name} (${ref.id})`);
  }
} else if (acciones.length > 0) {
  console.log('\nDry-run: no se ha escrito nada. Repite con --apply.');
}

// ── Informe de cobertura: lo que queda fuera, dicho ──────────────────────────
const finales = apply
  ? (await db.collection('leanTeams').get()).docs.map((d) => ({ id: d.id, ...d.data() }))
  : units;
const { publishable, skipped } = classifyUnits(finales, subdomains);

const medidos = new Set(publishable.map((p) => p.subdomainKey));
const sinMedir = subdomains.map((s) => s.key).filter((k) => !medidos.has(k));
const equiposSueltos = skipped.filter((s) => s.reason !== 'no-es-equipo');

console.log(`\n[${target}] cobertura:`);
console.log(`  subdominios medidos: ${[...medidos].toSorted().join(', ') || 'ninguno'}`);
console.log(`  subdominios SIN medir: ${sinMedir.toSorted().join(', ') || 'ninguno'}`);
console.log(`  equipos sin subdominio: ${equiposSueltos.map((s) => `${s.unit.name ?? s.unit.id} (${s.reason})`).join(', ') || 'ninguno'}`);
