/**
 * DECISIONES del arranque del hub (RMR-BUG-0112). Puro: sin red ni DOM.
 *
 * El arranque encadenaba cinco esperas, cuatro de ellas independientes entre sí,
 * y la quinta era una Cloud Function que bloqueaba el pintado. Se encadenaban
 * porque cada decisión se tomaba con el dato recién llegado y el siguiente
 * `await` estaba escrito a continuación.
 *
 * Separando el QUÉ se decide del CUÁNDO se piden los datos, el glue puede
 * lanzar las lecturas en paralelo y decidir después — y además estas reglas, que son las
 * que gobiernan quién entra a dónde, pasan a poder probarse sin montar nada.
 *
 * @typedef {{ functionalRole?: string|null, instanceAccess?: string|null }} Access
 */
import { hasAccess } from '../lib/accessRoles.js';

/**
 * ¿Es empleado del dominio de la instancia? Con email VERIFICADO del dominio
 * configurado. Sin verificación no vale: el dominio se comprueba sobre algo que
 * cualquiera puede escribir al registrarse.
 *
 * Sin dominio configurado no lo es nadie — es el caso de la demo, donde el
 * acceso no se reparte por correo.
 *
 * @param {string} email
 * @param {boolean} emailVerified
 * @param {string} domain
 * @returns {boolean}
 */
export function isEmployeeOf(email, emailVerified, domain) {
  if (!domain || emailVerified !== true) return false;
  return String(email ?? '').toLowerCase().endsWith('@' + domain.toLowerCase());
}

/**
 * A dónde va quien acaba de entrar.
 *  - `landing`: sin rol, sin gobierno, sin gestión de encuestas y sin ser
 *    empleado del dominio. No hay nada que enseñarle.
 *  - `admin`: un viewer es observador puro y entra al panel en solo lectura.
 *  - `tools`: el hub.
 *
 * @param {{ access: Access, isEmployee: boolean, canManageSurveys: boolean }} input
 * @returns {'landing'|'admin'|'tools'}
 */
export function hubDestination({ access, isEmployee, canManageSurveys }) {
  if (!hasAccess(access) && !canManageSurveys && !isEmployee) return 'landing';
  if (access?.instanceAccess === 'viewer') return 'admin';
  return 'tools';
}

/**
 * ¿Hay que pedirle a la Cloud Function que cree la ficha? SOLO si es empleado
 * del dominio y todavía no la tiene.
 *
 * Antes se llamaba en CADA entrada de cada empleado, aunque su ficha existiera
 * desde meses atrás, y esa llamada bloqueaba el pintado: una función fría son
 * segundos de pantalla en blanco para no hacer nada.
 *
 * @param {{ isEmployee: boolean, person: { id?: string }|null }} input
 * @returns {boolean}
 */
export function needsEmployeePerson({ isEmployee, person }) {
  return isEmployee === true && !person;
}
