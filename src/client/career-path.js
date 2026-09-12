/**
 * Glue de cliente del CAREER PATH (RMR-TSK-0488).
 *
 * La escalera ya se veía, pero enterrada en «Mi espacio › Mi carrera › La
 * escalera»: para saber qué se espera de un nivel había que saber que estaba
 * ahí dentro. Aquí es una herramienta con su puerta, y se ve entera al entrar,
 * sin pestañas ni pasos intermedios.
 *
 * Se sigue viendo también en Mi espacio: esto se AÑADE, no sustituye.
 */
import '../components/common/tool-nav.js';
import '../components/career/career-ladder.js';
import { onUserChanged } from '../lib/auth.js';
import { resolveAccess } from '../lib/access.js';
import { canGovern } from '../lib/accessRoles.js';
import { guardToolPage } from '../lib/toolGate.js';
import { getFramework } from '../lib/careerFramework.js';
import { getMyPerson } from '../lib/engineer.js';

const app = document.querySelector('career-ladder');

onUserChanged(async (user) => {
  if (!user || !app) return;
  let isSuperadmin = false;
  try { isSuperadmin = canGovern(await resolveAccess(user)); } catch { /* sin acceso de gobierno */ }
  if (!(await guardToolPage('careerpath', user, { isSuperadmin, appEl: app }))) return;

  // El framework es lo que se viene a ver; la persona solo sirve para marcar
  // dónde estás. Si no hay ficha, la escalera se pinta igual: el marco de
  // niveles es de la organización, no de quien lo mira.
  const [framework, person] = await Promise.all([
    getFramework(),
    getMyPerson(user.uid).catch(() => null),
  ]);
  app.framework = framework;
  app.person = person;
});
