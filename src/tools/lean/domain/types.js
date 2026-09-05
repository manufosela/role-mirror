/**
 * Tipos del dominio LEAN / Flow: métricas de cómo FLUYE el trabajo de un equipo,
 * a partir de las issues de Linear. JSDoc puro, sin Firebase. Complementa a DORA
 * (entrega) y es SIEMPRE de equipo, nunca por persona.
 *
 * @typedef {'squad'|'chapter'} LeanUnitKind   Equipo (label del grupo Squad) o gremio (grupo Chapter).
 *
 * @typedef {Object} LeanUnit   Unidad de flujo monitorizada = un LABEL de Linear
 *   (equipo o gremio). El flujo se mide filtrando las issues por ese label.
 * @property {string} id
 * @property {string} [linearLabel]   Nombre del label en Linear (p. ej. «Trust», «Backend»).
 * @property {string} [linearTeamKey] Clave del EQUIPO de Linear (p. ej. «MAT»), cuando el trabajo
 *   no lleva label: manda sobre el label si están los dos.
 * @property {LeanUnitKind} kind       'squad' (equipo) o 'chapter' (gremio).
 * @property {string} name            Nombre visible (por defecto = linearLabel).
 * @property {string} [ownerLeaderUid]   Líder dueño (permisología multi-leader).
 * @property {string} [subdomainKey]  Clave del subdominio del catálogo al que mide (ADR de dominios).
 *   Se guarda la CLAVE y no el nombre: renombrar el subdominio no rompe el enganche.
 * @property {string} createdAt       ISO de alta.
 * @property {FlowMetrics} [metrics]   Última métrica calculada por la Cloud Function.
 *
 * @typedef {Object} FlowIssue   Issue de Linear normalizada (lo mínimo para las métricas de flujo).
 * @property {string} id
 * @property {'backlog'|'unstarted'|'started'|'completed'|'canceled'} stateType   `state.type` de Linear.
 * @property {string} createdAt
 * @property {string|null} [startedAt]     Cuándo pasó a «en curso».
 * @property {string|null} [completedAt]   Cuándo se completó.
 * @property {string|null} [canceledAt]
 * @property {string} [identifier]         Identificador humano de Linear (p. ej. «TRIBBU-123»).
 * @property {string|null} [url]           Enlace directo a la issue en Linear.
 * @property {string} [title]              Título de la issue.
 *
 * @typedef {Object} OldestWipIssue   Issue en curso del reporte «más antiguas» (con enlace a Linear).
 * @property {string} identifier
 * @property {string|null} url
 * @property {string} title
 * @property {number} agingDays        Días que lleva abierta (en curso).
 * @property {string|null} [stateName] Columna de Linear donde está atascada (p. ej. «In Review»).
 *
 * @typedef {Object} FlowMetrics   Métricas de flujo de un equipo en una ventana.
 * @property {number} completed              Issues completadas en la ventana.
 * @property {number} throughputPerWeek      Completadas por semana.
 * @property {number|null} cycleTimeP50Hours Cycle time (started→completed) percentil 50, en horas.
 * @property {number|null} cycleTimeP85Hours Cycle time percentil 85, en horas.
 * @property {number} wip                    Issues en curso ahora (`started`).
 * @property {number|null} agingDaysMax      Antigüedad máxima de un WIP, en días.
 * @property {number} agingDaysAvg           Antigüedad media de los WIP, en días.
 * @property {OldestWipIssue[]} [oldestWip]  Las 3 issues en curso más antiguas (con enlace a Linear).
 * @property {number|null} [flowEfficiencyPct]  Flow efficiency (% activo/total) — Fase 2.
 * @property {string} [periodFrom]           ISO inicio de la ventana.
 * @property {string} [periodTo]             ISO fin de la ventana.
 * @property {string} [computedAt]           ISO del cálculo.
 * @property {string} [error]                Mensaje si el refresh falló para este equipo.
 */
