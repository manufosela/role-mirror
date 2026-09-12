/**
 * Tests de las DECISIONES del arranque del hub (RMR-BUG-0112).
 *
 * El arranque encadenaba cinco esperas —cuatro de ellas independientes— y una
 * era una Cloud Function que bloqueaba el pintado. Para poder pedirlo todo a la
 * vez hay que separar QUÉ se decide de CUÁNDO se piden los datos: esto es lo
 * primero, y se prueba sin red.
 */
import { describe, it, expect } from 'vitest';
import { isEmployeeOf, hubDestination, needsEmployeePerson } from './hubBoot.js';

describe('isEmployeeOf: quién es empleado del dominio de la instancia', () => {
  it('lo es con el email verificado del dominio configurado', () => {
    expect(isEmployeeOf('ana@tribbuapp.com', true, 'tribbuapp.com')).toBe(true);
  });

  it('sin verificar el email, no', () => {
    // El dominio se comprueba sobre algo que el usuario podría no controlar:
    // sin verificación, cualquiera se pone ese correo al registrarse.
    expect(isEmployeeOf('ana@tribbuapp.com', false, 'tribbuapp.com')).toBe(false);
  });

  it('de otro dominio, no', () => {
    expect(isEmployeeOf('ana@gmail.com', true, 'tribbuapp.com')).toBe(false);
  });

  it('sin dominio configurado no lo es NADIE: la demo no reparte acceso por email', () => {
    expect(isEmployeeOf('ana@tribbuapp.com', true, '')).toBe(false);
  });

  it('no se cuela quien lleva el dominio en otra parte del correo', () => {
    expect(isEmployeeOf('tribbuapp.com@evil.com', true, 'tribbuapp.com')).toBe(false);
  });
});

describe('hubDestination: a dónde va quien entra', () => {
  const sinNada = { functionalRole: null, instanceAccess: null };

  it('sin rol, sin gobierno y sin ser empleado: la landing pública', () => {
    expect(hubDestination({ access: sinNada, isEmployee: false, canManageSurveys: false })).toBe('landing');
  });

  it('un viewer va al panel en solo lectura: es observador, no gestiona', () => {
    expect(hubDestination({ access: { instanceAccess: 'viewer' }, isEmployee: false, canManageSurveys: false }))
      .toBe('admin');
  });

  it('con rol funcional, al hub', () => {
    expect(hubDestination({ access: { functionalRole: 'engineer' }, isEmployee: false, canManageSurveys: false }))
      .toBe('tools');
  });

  it('un empleado del dominio sin rol también entra al hub', () => {
    expect(hubDestination({ access: sinNada, isEmployee: true, canManageSurveys: false })).toBe('tools');
  });

  it('quien gestiona encuestas entra aunque no tenga otro rol', () => {
    // People gestiona las encuestas sin ser de ingeniería: si no entrara, no
    // podría llegar a su propia herramienta.
    expect(hubDestination({ access: sinNada, isEmployee: false, canManageSurveys: true })).toBe('tools');
  });
});

describe('needsEmployeePerson: cuándo hace falta la Cloud Function', () => {
  it('solo si es empleado del dominio y NO tiene ficha', () => {
    expect(needsEmployeePerson({ isEmployee: true, person: null })).toBe(true);
  });

  it('con ficha, NO se llama: es el caso de casi todas las cargas', () => {
    // Aquí estaba el coste: se llamaba en cada entrada de cada empleado, y una
    // función fría tarda segundos delante de una pantalla en blanco.
    expect(needsEmployeePerson({ isEmployee: true, person: { id: 'p1' } })).toBe(false);
  });

  it('quien no es empleado del dominio nunca la necesita', () => {
    expect(needsEmployeePerson({ isEmployee: false, person: null })).toBe(false);
  });
});
