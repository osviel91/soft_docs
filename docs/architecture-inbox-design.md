# Architecture Inbox: diseño técnico

**Estado:** propuesta para revisión arquitectónica. No implementado.
**Base inspeccionada:** `origin/master` = `7f944e7ca6da9f9e7d776591765935ed52113031`.

Etiquetas utilizadas: **EXISTENTE** significa demostrado en el HEAD inspeccionado; **PROPUESTO** es una decisión de diseño; **PENDIENTE** requiere decisión de producto o confirmación antes de implementar.

## 1. Diagnóstico del sistema actual

### Workspace, Project y autorización

- **EXISTENTE:** `ServerWorkspace` (`src/domain/workspace/server-workspace.ts`) tiene ID, owner, nombre, miembro/rol, política de self-review y fechas. `ServerProject` (`src/domain/project/server-project.ts`) tiene ID, `workspaceId`, owner, nombre, slug y fechas. El proyecto pertenece a un workspace; los nombres no son únicos.
- **EXISTENTE:** `WorkspaceRepository` (`src/application/ports/workspace-repository.ts`) lista workspaces del usuario (`listForUser`, `listAll`) y resuelve membresía/rol. `ProjectRepository.listForUser(userId, workspaceId?)` (puerto en `src/application/ports/project-repository.ts`; SQL en `src/persistence/project-repository.ts`) devuelve proyectos del workspace dado, no un listado global por usuario.
- **EXISTENTE:** la autorización central es `AuthorizationPolicy` en `src/application/authorization.ts`. `project:read` requiere credencial con scope, proyecto existente, membresía workspace activa y rol de proyecto suficiente; fallos de existencia/membresía se hacen indistinguibles (`not_found`). Los PAT de agente pueden estar restringidos a IDs de proyecto; sesiones tienen scopes completos. Workspace `VIEWER` o proyecto `VIEWER` resulta rol efectivo `VIEWER`; ADMIN/EDITOR de workspace reciben capacidad de editor de proyecto según el repositorio.
- **EXISTENTE:** `ProjectCatalog` (`src/application/project-catalog.ts`) es el servicio de catálogo para operaciones de proyecto autorizadas, pero no ofrece listado transversal de propuestas. Sus listados son por `workspaceId`.
- **EXISTENTE:** la membresía y relación workspace-proyecto están en PostgreSQL (`workspaces`, `workspace_members`, `projects`, `project_members`; migrations `0005-workspaces.ts`, `0001-initial-schema.ts`). La autorización de proyecto combina ambas tablas; no se debe derivar acceso solo de `project_members` ni del rol ADMIN del workspace.

### Proposal, Review y Promotion

- **EXISTENTE:** `ArchitecturalProposal` (`src/domain/workspace/architectural-proposal.ts`) es snapshot inmutable, ligado a `projectId`, `authorUserId`, `sourcePrivateContextId`, title/description, base SHARED y fechas `createdAt`/`submittedAt`. El estado persistido es `open | withdrawn | superseded`; revisión/promotion no son valores de ese campo. Retirada y sucesión conservan timestamps/linaje.
- **EXISTENTE:** `ArchitecturalProposalRepository.list(projectId)` lista por proyecto, orden `submitted_at DESC, id DESC`; no admite filtro, página ni usuario. `src/persistence/architectural-proposal-repository.ts` carga primero proposals y el servicio después consulta reviews y promotions por cada propuesta.
- **EXISTENTE:** `ArchitecturalProposalService.list` (`src/application/architectural-proposal-service.ts`) exige `project:read`, calcula decisión efectiva conservando la última revisión por `reviewerUserId`, totales de decisiones efectivas, `reviewStatus` (`none | approved | changes-requested | mixed`) y lifecycle derivado. Es N+1: review list y promotion get para cada propuesta, aparte de consultas de base vigente.
- **EXISTENTE:** reviews son records `APPROVE | REQUEST_CHANGES`, con reviewer, summary, created/updated y revisiones observadas (`ProposalReview`, `src/domain/workspace/architectural-proposal.ts`; persistencia `proposal-review-repository.ts`, migration `0018-proposal-reviews.ts`). Se conservan históricamente, pero el estado agregado cuenta la última decisión de cada revisor. La escritura es append-like, no hay asignación de reviewer ni “assigned to me”. Revisores pueden actualizar su decisión vía nuevo record.
- **EXISTENTE:** `ProposalLifecycleState` en `src/application/architectural-proposal-service.ts` deriva `OPEN`, `CHANGES_REQUESTED`, `APPROVED`, `PROMOTING`, `PROMOTED`, `WITHDRAWN`, `SUPERSEDED`. La prioridad aplicada es estado withdrawn/superseded, luego evidencia de promoción, luego review. Promoción pendiente usa `COMMITTED_COMPLETION_PENDING`; completada usa `COMPLETED`.
- **EXISTENTE:** `PromotionService.preview(context, projectId, proposalId)` en `src/application/promotion-service.ts` ejecuta `plan`: carga propuesta, estado/base, recursos SHARED, bindings, manifiesto, revisiones y valida múltiples blockers. Además verifica permiso `promotion:execute` y añade blocker `PROMOTION_PERMISSION` si el lector no puede promover. No muta, pero sí es trabajo más costoso que un resumen y solo refleja el instante consultado. El UI lo llama por acción explícita (`ArchitecturalProposalDetail.tsx`), no automáticamente al listar.
- **EXISTENTE:** promoción persistida se lee de `promotions` (`src/persistence/promotion-repository.ts`; migration `0021-promotions.ts`) con estados `COMMITTED_COMPLETION_PENDING | COMPLETED`. Preview no persiste elegibilidad ni blockers.
- **EXISTENTE:** `submit`, `revise`, `withdraw`, `review`, `preview` y `execute` aplican sus propias reglas. Revisión requiere `resource:update` (o gobernanza ADMIN permitida) y no permite aprobarse uno mismo salvo política workspace. Promoción requiere OWNER del proyecto o workspace-admin governance explícita. Cada acción vuelve a autorizarse en backend.

### HTTP y frontend

- **EXISTENTE:** `apps/api/routes.ts`: `GET /api/projects/:projectId/architectural-proposals`; `GET /api/architectural-proposals/:proposalId?projectId=...`; reviews, diff y promotion bajo `/api/architectural-proposals/:proposalId/...?...`. `guarded` y `contextOf` realizan el manejo común de errores/contexto. `ServerApiClient` en `src/workspace/server/api-client.ts` envuelve estas rutas; no hay query global, cursor ni filtros para Architectural Proposals.
- **EXISTENTE:** `GET /api/workspaces` y proyectos por workspace ya soportan la navegación normal, con client tipado. `use-server-workspaces.ts` lista proyectos por workspace y propuestas del proyecto activo/otros proyectos cargados en el navegador: no es fuente segura ni suficiente para Inbox global.
- **EXISTENTE:** `ChangesInbox.tsx` es una bandeja de Change Proposals de un solo proyecto, otra entidad y otro lifecycle. No reutilizar su modelo. `ArchitecturalProposalDetail.tsx` es el destino de decisión y ya presenta lifecycle, author, submitted time, reviews, stale base, preview on-demand y acciones con capability. Componentes reutilizables observados: `PageHeader`, patrones de listados, filtros de explorer y controles de estado; no hay tabla/bandeja global lista.
- **EXISTENTE:** `App.tsx` tiene una shell única, navegación interna por `view`, y URL de query con `project`, `context`, `resource`, `proposal`. `openArchitecturalProposal(proposalId)` conserva el proyecto activo; el efecto que hidrata propuesta espera que `location.projectId === server.active.project.id`. No ofrece destino independiente de workspace/proyecto activo.
- **EXISTENTE:** `docs/documentation-model.md` define autoridad, estados reales, revisión efectiva, preview/promoción separadas, y límites de capabilities. `docs/roadmap.md` es la fuente vigente del roadmap.

## 2. Problema y objetivos

La revisión se descubre entrando proyecto por proyecto aunque las propuestas y sus revisiones son gobernadas transversalmente y el principal puede tener acceso a varios workspaces. El cliente no puede armar de forma fiable un Inbox global: la lista de proyectos está paginada/seleccionada por workspace y la API solo consulta proposals dentro de un proyecto.

**PROPUESTO:** añadir una proyección de lectura efímera, autenticada, que muestre proposals de todos los proyectos actualmente autorizados. Acelerar descubrimiento, preservar la separación Proposal/Review/Promotion, ofrecer navegación estable y solo exponer acciones según capacidades vigentes. No crear entidad Inbox, notificaciones, asignaciones ni estado de trabajo paralelo.

No hay “asignadas a mí”: no existe asignación. “Pendientes de revisión” describe un estado agregado, no propiedad ni responsabilidad individual.

## 3. Modelo de lectura

| Campo | Clasificación | Fuente / regla propuesta |
| --- | --- | --- |
| `proposalId`, `title`, `authorUserId`, `status` | EXISTENTE | Proposal. |
| `authorDisplayName` | EXISTENTE/derivable | `users.display_name` existe para review; confirmar query de usuario y política de privacidad. Puede ser nullable y usar ID de fallback. |
| `workspaceId`, `projectId`, `projectName` | EXISTENTE | `projects.workspace_id/name`. |
| `workspaceName` | EXISTENTE | `workspaces.name`. |
| `createdAt`, `submittedAt` | EXISTENTE | Proposal tiene ambos; hoy el submit inicial los crea normalmente iguales, pero no colapsarlos. |
| `reviewStatus` | DERIVADO EXISTENTE | Por las últimas decisiones por revisor: `none`, `approved`, `changes-requested`, `mixed`. |
| conteos efectivos `approvals`, `changesRequested` | DERIVADO EXISTENTE | Contar última review por usuario, no todas las filas históricas. |
| `lifecycle` | DERIVADO EXISTENTE | Lifecycle de aplicación; incluir para facilitar consistencia con detail. |
| `promotionStatus` | EXISTENTE si hay promoción | `COMMITTED_COMPLETION_PENDING` o `COMPLETED`; null si no existe evidencia. |
| `promotionCreatedAt`, `promotionCompletedAt` | EXISTENTE si hay promoción | Fechas en promoción; no equivalen al “último cambio de opinión” del Inbox. |
| `lastActivityAt` | DERIVADO propuesto | Máximo de `submittedAt`, `withdrawnAt`, `supersededAt`, y timestamps de las reviews efectivas/todas las reviews; promotion `createdAt`/`completedAt`. Definir si una nueva review histórica de un mismo usuario después de otra (siempre vigente) se cuenta por `createdAt`; sí. No hay un `updatedAt` unificado fiable en Proposal. |
| `attentionCategory` | DERIVADO propuesto | Clasificación de bandeja, no estado durable (ver abajo). |
| `destination` | DERIVADO propuesto | Ruta canónica con projectId y proposalId, no enlace externo ni estado de memoria. |
| `promotionEligibility`, blockers | NO materializar en MVP | Preview es dinámica y específica del principal; solo cargar bajo demanda. |

No ampliar modelo/persistencia para `lastActivityAt`: agregar funcionalmente fechas existentes. La propuesta actual no tiene update posterior; revisiones/promoción son su actividad observable. Si el producto exige “actividad” más amplia que estos hechos, habrá que decidir si se introduce un event log común, fuera del MVP.

### Categorías derivadas (mutuamente exclusivas)

Precedencia de clasificación propuesta:

1. Estado Proposal `withdrawn` => `WITHDRAWN`.
2. Estado `superseded` => `SUPERSEDED`.
3. Promoción `COMPLETED` => `PROMOTED`.
4. Promoción `COMMITTED_COMPLETION_PENDING` => `PROMOTION_COMPLETION_PENDING` (requiere atención operativa; no presentarlo como promovido).
5. Proposal `open` + review `changes-requested` o `mixed` => `CHANGES_REQUESTED`.
6. Proposal `open` + review `approved` => `APPROVED_PENDING_PROMOTION`.
7. Proposal `open` + review `none` => `PENDING_REVIEW`.

`PROMOTION_BLOCKED` **no es clasificable con precisión** sin evaluar preview; aprobado no implica preview elegible. MVP muestra “Aprobada · promoción aún no evaluada” y botón “Abrir propuesta”. El detalle permite Preview y expone blockers. Después de cargar una preview en la misma visita se puede mostrar resultado transitorio del cliente, nunca usarlo como dato confiable al refrescar ni filtro/contador del endpoint. **PENDIENTE:** si Inbox debe filtrar “bloqueada”, aceptar el coste de preview en solicitudes explícitas y aclarar que será una evaluación puntual; no hacer preview masivo ni guardarlo como estado. `PROMOTION_COMPLETION_PENDING` es diferente de blocker de elegibilidad: existe un commit durable con recuperación incompleta.

Filtros MVP: `PENDING_REVIEW`, `CHANGES_REQUESTED`, `APPROVED_PENDING_PROMOTION` como pendientes de atención; historial opt-in con `PROMOTED`, `WITHDRAWN`, `SUPERSEDED`, y `PROMOTION_COMPLETION_PENDING`. `mixed` se incluye en `CHANGES_REQUESTED` porque la preview lo bloquea y debe quedar explícito en el resumen `reviewStatus=mixed`.

## 4. Arquitectura y autorización transversal

**PROPUESTO:** nueva consulta read-only bajo `src/application` con un puerto dedicado de Inbox, implementado por SQL en `src/persistence`; HTTP en `apps/api/routes.ts` y client tipado en `src/workspace/server/api-client.ts`. La consulta no debe vivir como lógica SQL en React, ni como múltiples invocaciones del endpoint proyecto.

`ProjectRepository.listForUser` no basta directamente: opera en un workspace y su contrato solo conoce acceso/listados, mientras proposals/reviews/promotions son otros repositorios. Se necesita una consulta de persistencia compuesta o un port de lectura `ProposalInboxRepository` que reciba el principal efectivo (subjectUserId y, si aplica, allowedProjectIds) y aplique autorización mediante joins. Application service verifica scopes de lectura para principal, valida filtros y delega en query parametrizada. Los scopes agent actuales tienen permisos por proyecto, así que intersecar `allowedProjectIds` es requisito adicional a membresía.

Predicado de autorización de cada fila para `project:read`:

```sql
JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = :userId
WHERE (:allowedProjectIds IS NULL OR p.id = ANY(:allowedProjectIds))
```

`project:read` acepta todos los roles `OWNER`, `EDITOR`, `VIEWER`; `project_members` determina principalmente la autorización de escritura y no debe filtrar del Inbox a los viewers. La pertenencia al workspace es siempre obligatoria, incluido para el owner, y garantiza que removerla revoque lectura incluso si una fila antigua permanece en `project_members`. La restricción opcional de credencial se intersecta además. No incluir platform-admin como bypass: la política actual del proyecto no lo hace.

Todos los filtros, joins, filas de resultado y conteos se ejecutan sobre el mismo conjunto autorizado en una sola sentencia/CTE o misma transacción de lectura. Nunca obtener primero todos los IDs de proposals para filtrar en memoria, ni aceptar usuario arbitrario desde request. El cliente no decide scopes ni pasa `userId`.

**Cambios de permisos:** autorización se reevalúa en cada petición (página y contadores incluidos). Cursor no constituye grant ni snapshot de membresía. Si se revoca acceso entre páginas, filas dejan de salir; el siguiente resultado puede ser menor o vacío, y un cursor puede expirar/reiniciarse. Si un projectId filtro deja de ser accesible, responder como filtro sin resultados (no revelar existencia); deep link puntual debe usar el `not_found` normal. Es posible que una revocación ocurra justo después de la lectura y antes de serializar respuesta; usar una única sentencia bajo snapshot SQL reduce inconsistencias internas, y la petición siguiente vuelve a autorizar. Una grant revocada después de haber entregado datos no permite retirar lo ya leído.

## 5. API propuesta

### Ruta y filtros

**PROPUESTO:** `GET /api/inbox/proposals`, acorde al prefijo `/api`, a `GET` y al recurso `architectural-proposals` existente. Mantener inbox separado de `/api/projects/:projectId/...` porque el scope de consulta es el principal.

Query parameters:

- `workspaceId` opcional UUID. Reduce dentro del conjunto autorizado; workspace inaccesible => lista vacía, sin distinguirlo de desconocido.
- `projectId` opcional UUID. Reduce dentro del conjunto autorizado, incluida intersección del token. Un proyecto inaccesible/desconocido => lista vacía.
- `status` opcional, repetible o CSV (escoger una sola forma; **PROPUESTO:** CSV) sobre persistido: `open,withdrawn,superseded`. Omisión incluye todos en respuesta API; UI por defecto puede filtrar pendientes.
- `attentionCategory` opcional, CSV entre categorías derivadas documentadas arriba. No incluye `PROMOTION_BLOCKED` en MVP.
- `search` opcional, longitud máxima propuesta 200, trim; búsqueda literal case-insensitive sobre título (`ILIKE` con escape de `%`, `_`, `\\`), no búsqueda difusa.
- `limit` opcional entero 1–100, default 50.
- `cursor` opaco URL-safe, con versión y clave del último orden (`lastActivityAt`, `proposalId`), además de hash/fingerprint de filtros normalizados. No confiar en datos codificados; firmarlo con HMAC o usar cursor server-side. **PENDIENTE:** mecanismo estándar de cursors no se encontró en el API general; elegir según utilidades existentes antes de implementar.

El `status` filtra el estado almacenado, `attentionCategory` el agrupamiento derivado; se pueden combinar por AND. Valores desconocidos o repetidos conflictivos producen 422 con errores de validación legibles. Sin `status` por defecto se incluyen retiradas y finalizadas para permitir historial API; UI selecciona un scope “Pendientes” como filtro compuesto. No aceptar sort field/direction suministrados por cliente.

### Orden y paginación

Orden único: `lastActivityAt DESC NULLS LAST, proposalId DESC`. `proposalId` como tie-breaker único y estable. Cursor keyset con comparación de timestamp+UUID para evitar OFFSET creciente y duplicados en una base sin cambios. Como actividad puede cambiar entre páginas, un ítem puede moverse antes/después del cursor; documentar consistencia eventual entre páginas (no snapshot durable). Cambios concurrentes de permiso/filter se aplican inmediatamente, y si cambia el fingerprint del filtro responder 400 `invalid_cursor` o 422; recomendado 400.

`nextCursor=null` cuando no hay más filas; `items` limitado a `limit`. No traer snapshot contents/diffs en el Inbox.

### Response sugerida

```json
{
  "items": [
    {
      "proposalId": "019...",
      "title": "Proposal title",
      "status": "open",
      "author": { "userId": "019...", "displayName": "Ada" },
      "workspace": { "id": "019...", "name": "Platform" },
      "project": { "id": "019...", "name": "Checkout" },
      "createdAt": "2026-10-10T10:00:00.000Z",
      "submittedAt": "2026-10-10T10:00:00.000Z",
      "lastActivityAt": "2026-10-10T11:00:00.000Z",
      "review": { "status": "approved", "approvals": 1, "changesRequested": 0 },
      "promotion": { "status": null, "createdAt": null, "completedAt": null },
      "lifecycle": "APPROVED",
      "attentionCategory": "APPROVED_PENDING_PROMOTION",
      "destination": "/?project=019...&proposal=019..."
    }
  ],
  "page": { "limit": 50, "nextCursor": null },
  "counts": {
    "PENDING_REVIEW": 4,
    "CHANGES_REQUESTED": 2,
    "APPROVED_PENDING_PROMOTION": 1,
    "PROMOTION_COMPLETION_PENDING": 0
  }
}
```

`counts` son agregados sobre la misma autorización y filtros restrictivos workspace/project/search/status de la consulta, pero se calculan antes de cursor y limit. `attentionCategory` se excluye al calcular la partición de categorías para que las cifras siempre describan mutuamente categorías; si se especificó categoria se puede omitir counts del resto, pero para simplicidad devolver siempre los mismos buckets tras otros filtros. `status` sí restringe los conteos. **PROPUESTO:** counters solo de buckets operativos, no incluir historial salvo que se añada explícitamente una sección de historial; `total` no necesario en keyset.

La query de items y counts debe compartir CTE `authorized_proposals` y derivación de status/category para garantizar coherencia lógica. Preferible una sola sentencia (window/JSON aggregates o CTE paralelo) para que counts e items compartan snapshot de lectura; si SQL del driver hace dos queries, ejecutarlas en transacción repeatable-read.

### Estados HTTP

- `200`: items, page y counts (vacíos si no hay propuestas accesibles).
- `401`: sin sesión/credencial válida, conforme a middleware existente.
- `400`/`422`: parámetros sintácticamente inválidos, categoría/status desconocidos, cursor malformado/expirado.
- `403`: principal autenticado sin scope de lectura global adecuado, según contrato actual de credential scope; confirmar interacción con credenciales limitadas.
- `500`: error SQL o fallo de lectura; usar `guarded` y envelope de error existente.
- Filtros para workspace/proyecto inaccesibles y resultados de proposals eliminadas por cascada no distinguen inaccesible/no existente: zero results. Deep link a proposal/project inaccesible usa error `not_found` para no enumerar.

## 6. Consultas y rendimiento

Consulta agregada: proposals JOIN projects JOIN workspaces; `LEFT JOIN LATERAL` o CTE que calcule última decisión por reviewer (window `row_number` orden `created_at DESC, id DESC`) y agregue decisions; LEFT JOIN promotions por `(project_id, proposal_id)` (unique); subconsulta agregada para timestamps de actividad desde todas las reviews. Evitar cargar recursos del snapshot.

**Riesgo de N+1 actual demostrado:** `ArchitecturalProposalService.list` consulta `reviews.list(proposalId)` y `promotions.getForProposal(projectId, proposal.id)` dentro del map. La bandeja no debería implementar reusando esa función para cada proyecto. Añadir índices solo después de `EXPLAIN` con datos representativos; índices existentes son `architectural_proposals_project_idx(project_id, submitted_at DESC, id DESC)` y review index por proposal/fecha. Un índice global por activity derivada no puede resolver el orden directamente; para escala inicial, filtrar por autorizaciones/campos indexables, agregar antes del sort y establecer timeout/result limit. Si medir demuestra cuello de botella, discutir proyección materializada o índice de activity; no agregar tabla Inbox anticipadamente.

`search` con `%term%` no aprovecha un btree normal. MVP puede ser aceptable con scope limitado por los proyectos autorizados; si volumen lo justifica evaluar trigram index o búsqueda prefix. Escapar wildcards es importante para semántica literal. `limit+1` determina `nextCursor`.

`Promotion Preview` fuera de la query: costea por recursos de SHARED/proposal y análisis de entities, más manifiesto y review state; correrlo para cada proposal en cada bandeja multiplica I/O/CPU y además produce readiness dependiente del usuario (`PROMOTION_PERMISSION`). Solo cargar preview desde detail o por acción explícita individual; no calcular counts de blockers dinámicos.

## 7. Navegación y pantalla

### URL estable

**PROPUESTO:** ruta `/?inbox=proposals` para bandeja y `/?project=<projectId>&proposal=<proposalId>` para detalle. La identidad de destino incluye ambos IDs; proposal ID es UUID, pero endpoint get ya requiere projectId y autorización por proyecto. La URL de detalle existente se puede mantener compatible ampliando la navegación que resuelve el proyecto por ID antes de abrir propuesta, no por `server.active`.

En esta primera iteración se recomienda query route (no añadir router/dependencia nueva), usando los patrones `browserLocation`, `locationUrl`, `pushState`, `popstate` de `App.tsx`. Debe hidratar `projectId` desde proyecto accesible, abrirlo y luego cargar proposal. Fetches usan el endpoint canónico para volver a autorizar. Si pierde acceso durante carga, presentar “No disponible o ya no tienes acceso” (sin revelar cuál), salir de detalle pero conservar Inbox/historial al volver. Si se retiró mediante withdrawal/supersession, detail abre normalmente con su estado terminal; “inexistente” o eliminación por eliminación de proyecto se trata como no disponible.

Al navegar desde Inbox, `pushState` incluye destination; `Back` usa history. `/?inbox=proposals` queda debajo en history. Filtros de origen pueden guardarse en query (`inbox=proposals`, `workspace`, `projectFilter`, `attention`, `q`, `cursor`) y la propuesta destino podría incluirlos como `return`/query namespaced; recomendado hacerlo solo si no vuelve URL demasiado frágil: navegación atrás ya preserva URL anterior, pero recarga del detalle seguida de volver no. **PROPUESTO MVP:** inbox conserva filtros en query y botón “Inbox” vuelve a la URL de filtro codificada; no transportar state en memoria exclusivamente. Validar y limitar cualquier parámetro return para no crear open redirect (usar ruta local/query estructurada).

### MVP de interfaz

- Entrada global “Inbox” en shell autenticada, fuera del workspace/project explorer y visible aun sin selección de proyecto. Ocultar en modo local/no autenticado. El menú de proyecto se conserva.
- Resumen de buckets derivados con count, etiquetado “Pendientes”, sin reclamar owner/reviewer.
- Lista paginada: título, autor, estado de revisión/counts, promoción persistida si existe, proyecto y workspace siempre visibles, actividad; fila abre detalle.
- Filtros de workspace, proyecto (condicionado a workspace si existe), categoría/situación y título. Filtros/query serializados en URL. Servidor valida todo.
- No preview masivo ni controles de approve/promote en fila. Detail sigue siendo único workspace de revisión, change inspector y acción explícita. `capabilities` del detail continúan siendo orientativas; endpoints vuelven a autorizar.
- Estados de UI: carga inicial/esqueleto, refresco manteniendo resultados identificados como stale si corresponde, error/retry, vacío global, vacío tras filtro, sin permiso/sesión. Accesible por teclado, mensajes de status y filtros etiquetados.
- Limitación aceptada del MVP: la URL conserva filtros, no la posición/cursor de página; al recargar Inbox se empieza en la primera página. Back desde el detalle restaura la URL del Inbox que quedó en history.
- Reutilizar `PageHeader`, controles del `WorkspaceSwitcher` (solo patrón, no acoplarlo), etiquetas de estado del detail y estilo de ChangesInbox; no reutilizar `ChangesInbox` como modelo.

## 8. Pruebas y criterios de aceptación

| Caso | Verificación |
| --- | --- |
| Dos workspaces accesibles | Recoge proposals de ambos con nombres/IDs de workspace y project correctos; sin duplicados. |
| Acceso parcial | Solo projects donde la membresía workspace existe; viewer/roles de proyecto correctos según `roleOf`. |
| Token restringido | Intersección con `allowedProjectIds`; otro project/workspace no se enumera ni en counts. |
| Separación de usuarios | Fixtures de otro principal nunca aparecen en filas, counts o búsqueda. |
| Distintas situaciones | Cobertura open sin review, cambios solicitados, mixed, approved, pending completion, completed, withdrawn, superseded; status persistido no se confunde con lifecycle/category. |
| Aprobada pendiente | Categoría `APPROVED_PENDING_PROMOTION`, sin afirmar elegibilidad. Preview no se llama al listar. |
| Promotion blocker | Lista no predice blocker; preview de detalle lo muestra con razón real y vuelve a validar permiso. |
| Conteos | Coinciden con filtrado categórico sobre mismo conjunto autorizado, aplican filtros restrictivos y no dependen de página/cursor. |
| Cursor | Orden repetible por activity desc + ID desc, sin duplicados en conjunto estático, limite acotado, tampering/filter mismatch rechazado. |
| Cambio en datos entre páginas | Documenta comportamiento eventual; no salta de autorización. |
| Revocación de workspace/project | Siguiente página/count/detail vuelve a evaluar; proyecto filtrado pasa a vacío y detail a not_found genérico. |
| Búsqueda | Case-insensitive literal, acentos según collation documentada, escapes wildcard; limit de longitud. |
| Deep link y reload | Abrir detalle desde Inbox con otro proyecto activo; URL se hidrata tras reload y abre el proyecto destino antes del proposal. |
| Back/filters | Navegación atrás vuelve a Inbox con query de filtros; no depende solo del React state. |
| Proposal retirada/sucesora | Sigue apareciendo en historial, detail refleja withdrawal/supersession y successor. |
| Sin Proposal | Empty state claro sin confundirlo con error. |
| Errores | 401/403/invalid cursor/500 se presentan y permiten reintento adecuado. |
| No N+1 | Prueba de integración observa número acotado de queries sin crecer por proposal; plan SQL con fixture multi-project. |
| Compatibilidad | Existing project-list, proposal detail, review, preview y promoción tests siguen pasando; Inbox no cambia contratos de mutación/gobernanza. |

Aceptación de seguridad: ningún `userId` controlado por cliente; cada endpoint carga contexto autenticado; permiso se aplica antes de construir items y conteos; project/workspace IDs inaccesibles son indistinguibles de desconocidos. Pruebas HTTP contra DB, no solo mocks de UI.

## 9. Riesgos y decisiones abiertas

- **PENDIENTE:** comprobar si agent/PAT con scope de `project:read` puede usar global Inbox y si “todos los projects en allowedProjectIds” es semántica deseada para agentes. Endpoint debe respetar scope actual; no conceder un permiso nuevo por la UI.
- **PENDIENTE:** política de privacidad para devolver `authorDisplayName`/email. Recomendación: displayName si ya está disponible internamente, nunca email en Inbox; de otro modo userId con fallback.
- **PENDIENTE:** definir producto “pendiente” por default: solo sin review, o incluir cambios solicitados y aprobadas en buckets distintos. Diseño recomendado los muestra juntos en resumen y da filtro claro.
- **PENDIENTE:** autorizar reviewers de Inbox: el read scope `project:read` puede ver propuesta, pero el permiso `resource:update` y reglas self-review determinan si puede revisar. Opciones no deben inferirse en Inbox; detail recarga capabilities. Recomendado lista visible para read-only y acción posterior explicita en detail.
- **PENDIENTE:** `lastActivityAt` incluye todas las decisiones de revisión, incluso decisiones anteriores reemplazadas; es historial real. No hay eventos de “abrió/vio”. Aprobar/REQUEST_CHANGES está asociado al momento de record insert.
- **RIESGO:** estados derivados cambian con nueva review/promotion y orden entre páginas. Cursor keyset no congela dataset; UI debe ofrecer refresh.
- **RIESGO:** joins authorization y aggregations pueden hacerse costosos con muchos proyectos/proposals, especialmente `ILIKE %...%`. Medir con explain y carga real antes de nuevos índices o proyección durable.
- **RIESGO:** eliminar proyecto cascada proposals y promotion. No es igual a retirar proposal, que sí permanece en historial; Inbox no puede ofrecer historial de proyectos borrados sin retención/audit distinto.
- **PENDIENTE:** ubicación final de ruta (query route recomendada vs rutas pathname) y comportamiento visual en local mode.
- **PENDIENTE:** D03.15–D03.19 no están definidos en el roadmap vigente. No atribuir al Inbox un número de fase en conflicto con contratos ausentes.

## 10. Incrementos implementables

1. **Contrato y fixtures:** acordar enum de attention buckets, default/filtros, activity timestamp y política de displayName/PAT. Agregar fixtures/matriz de autorización sin alterar gobernanza existente.
2. **Lectura application + SQL:** definir port read-only para página/counts; query conjunta con autorización, última review por reviewer y promotion persistida. Validación de filtros/cursor. Sin migración inicialmente.
3. **HTTP y client:** introducir endpoint GET y modelos de response tipados, errores según middleware, tests API de no-leak, permisos parciales, contadores y paginación.
4. **URL/deep link:** implementar route/query state global Inbox y resolución del project destino antes de propuesta; tests reload/popstate/revocación.
5. **UI Inbox MVP:** resumen, búsqueda/filtros, lista y paginación; detail existente permanece como el único lugar de decisión/preview/promoción.
6. **Hardening y aceptación:** `EXPLAIN`, pruebas de volumen multi-workspace, interacción manual, lint/typecheck/test, documentar límites de consistencia del cursor. Solo luego considerar índices o ergonomía adicional.

Cada incremento que afecte comportamiento debe actualizar conocimiento arquitectónico conforme al modelo normativo; la presente fase no modifica SHARED ni crea Proposal de Software Docs.

## 11. Roadmap

**EXISTENTE:** `docs/roadmap.md` registra D03.14.3 Architectural Proposals, D03.14.4 Review and impact, D03.14.5 Promotion and authoritative lineage y D03.14.6 Governed architectural proposal completion como implementadas/verificadas; tiene texto explícito “D03.15–D03.19: continue only according to their existing contracts” pero no detalla sus contracts ni sus nombres/criterios. D04 (semantic impact analysis) y D05 (architecture evolution analysis) son futuro, no implementados.

No se encontraron documentos actuales de D03.15–D03.19 con alcance identificable en `docs/roadmap.md` ni `docs/**/*`. Por tanto no se puede afirmar compatibilidad, dependencia o colisión específica por fase. Tampoco se debe renumerar/reasignar esos IDs.

**PROPUESTO:** registrar Architecture Inbox como propuesta de backlog independiente, provisionalmente “Architecture Inbox (cross-project proposal discovery)”, sin número D03.15–D03.19. Ubicarlo después de D03.14.6 en el backlog cercano únicamente cuando el responsable confirme que los contratos no documentados no reservan este espacio; o añadir una sección “Propuestas de evolución sin fase asignada” conservando literalmente D03.15–D03.19. No reclamar que es D04: Inbox es consulta/listado gobernado, no razonamiento semántico de impacto; tampoco es D05, no analiza evolución/historia arquitectónica.

Dependencias técnicas reales: workspace/project authorization, ProposalRepository/ReviewRepository/PromotionRepository y modelos ya disponibles; API auth/context y navegación principal. No depende de candidate discovery, trazas semánticas, Event Flow ni nuevas reglas de gobernanza. Posible cruce futuro con trabajos de análisis transversal o mejoras de proposal review, pero no hay evidencia para declarar conflicto.

## Referencias de implementación

- `src/domain/workspace/server-workspace.ts`, `src/domain/project/server-project.ts`
- `src/application/authorization.ts`, `src/application/project-catalog.ts`, `src/application/ports/project-repository.ts`, `src/application/ports/workspace-repository.ts`
- `src/domain/workspace/architectural-proposal.ts`, `src/domain/workspace/promotion.ts`
- `src/application/architectural-proposal-service.ts`, `src/application/promotion-service.ts`
- `src/application/ports/architectural-proposal-repository.ts`, `src/application/ports/proposal-review-repository.ts`, `src/application/ports/promotion-repository.ts`
- `src/persistence/project-repository.ts`, `src/persistence/architectural-proposal-repository.ts`, `src/persistence/proposal-review-repository.ts`, `src/persistence/promotion-repository.ts`
- `src/persistence/migrations/0001-initial-schema.ts`, `0005-workspaces.ts`, `0017-architectural-proposals.ts`, `0018-proposal-reviews.ts`, `0021-promotions.ts`, `0025-proposal-lifecycle.ts`
- `apps/api/routes.ts`, `apps/api/app.ts`, `src/workspace/server/api-client.ts`
- `src/App.tsx`, `src/features/proposals/ArchitecturalProposalDetail.tsx`, `src/features/proposals/ChangesInbox.tsx`, `src/features/server/use-server-workspaces.ts`
- `docs/documentation-model.md`, `docs/roadmap.md`
