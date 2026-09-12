/**
 * Catálogo de HERRAMIENTAS de GREBLA y su política de acceso por defecto
 * (RMR-PCS-0027 · F3). El superadmin ajusta cada política en el panel; esto es
 * solo el punto de partida del seed y la lista canónica de toolIds/labels.
 *
 * @typedef {import('../domain/toolAccess.js').ToolPolicy} ToolPolicy
 */

/** @type {ToolPolicy[]} Defaults acordados: everyone (Marea/Motivators), branch:engineering (resto), Encuestas gestionadas por People. */
export const TOOLS = [
  { toolId: 'organigrama', label: 'Organigrama', audience: { everyone: true }, managedBy: {} },
  { toolId: 'marea', label: 'Marea', audience: { everyone: true }, managedBy: {} },
  { toolId: 'motivators', label: 'Moving & Affective Motivators', audience: { everyone: true }, managedBy: {} },
  { toolId: 'surveys', label: 'Encuestas de clima', audience: { everyone: true }, managedBy: { branches: ['people'] } },
  { toolId: 'kudos', label: 'Kudos', audience: { everyone: true }, managedBy: {} },
  { toolId: 'library', label: 'Biblioteca de la bodega', audience: { everyone: true }, managedBy: {} },
  { toolId: 'career', label: 'Plan de desarrollo', audience: { branches: ['engineering'] }, managedBy: { roleIds: ['head-eng'] } },
  { toolId: 'careerpath', label: 'Career path', audience: { branches: ['engineering'] }, managedBy: { roleIds: ['head-eng'] } },
  { toolId: 'rolemirror', label: 'Role Mirror', audience: { branches: ['engineering'] }, managedBy: { roleIds: ['head-eng'] } },
  { toolId: 'dora', label: 'DORA', audience: { branches: ['engineering'] }, managedBy: { roleIds: ['head-eng'] } },
  { toolId: 'lean', label: 'LEAN', audience: { branches: ['engineering'] }, managedBy: { roleIds: ['head-eng'] } },
  { toolId: 'o2o', label: 'One-to-Ones', audience: { branches: ['engineering'] }, managedBy: { roleIds: ['head-eng', 'em'] } },
  { toolId: 'poker', label: 'Scrum Poker', audience: { branches: ['engineering'] }, managedBy: {} },
  { toolId: 'retros', label: 'Retros', audience: { branches: ['engineering'] }, managedBy: {} },
];

/** @type {Record<string,string>} toolId → label, para pintar sin recargar el catálogo. */
export const TOOL_LABELS = Object.fromEntries(TOOLS.map((t) => [t.toolId, t.label]));
