# D03.3 — Candidate Discovery & Epistemic Reasoning

**Estado:** D03.3.1–D03.3.4 implementados; la aceptación externa de pilotos sigue pendiente
**Alcance:** sugerencias de correspondencia Conceptual ↔ Database y evaluaciones privadas de esas sugerencias
**Regla:** Candidate no es SemanticBinding. Solo una acción explícita, con evidencia válida, crea un binding en MY WORK; publicación sigue el flujo de Architectural Proposal.

## 1. Estado actual del código

Las afirmaciones de esta sección describen el código inspeccionado. Las decisiones de diseño se marcan como **Propuesta**.

### Modelos e índice

- `src/domain/workspace/semantic-binding.ts` define `EntityAnchor` v1 como dirección tipada: resource ID estable, representación, tipo de entidad e identidad local exacta (o fallback table/name para columnas). `entityAnchorKey` compara el anchor completo; `resolveEntityAnchor` no repara por nombre.
- El mismo módulo define `SemanticBinding`, la relación directional `represents-in` y `BindingEvidence` v1. Evidence tiene rationale obligatorio y al menos un item interno (resource/revision, anchor/rango opcional) o externo (reference/description). No declara valencia positiva/contradictoria ni calidad o suficiencia.
- `ProjectIndex` (`src/domain/project/project-index.ts`) agrega `entities: IndexedEntity[]` a partir del análisis independiente por recurso. Los anchors son exactos y los nombres son display data. El índice es derivado/reconstruible; no persiste propuestas.
- `semantic-binding-query.ts` resuelve bindings activos contra el índice y distingue endpoint `unavailable` (resource ID ausente) de `unresolved` (resource presente, entidad exacta ausente). El query no intenta inferencia.
- La registry de relaciones contiene solo `represents-in`; la validación actual exige recursos distintos pero no restringe el binding a Conceptual ↔ Database.

### Candidatos de mensajes (no candidatos de entidades)

- `src/domain/project/semantic-message-trace.ts` agrupa ocurrencias Sequence/Event Flow por `kind + nombre` normalizado. Informa recursos confirmados/no confirmados y si hay al menos una ocurrencia autoritativamente ligada a `SemanticMessageIdentity`.
- El extractor legacy en `mcp/tools.ts` detecta mensajes Sequence no estructurados por sufijo/texto (“Event”, “Command”, publish/consume/dispatch). Ambas funciones son leads para identidad y trazabilidad de mensajes, no hacen correspondencia entre Conceptual y Database, no usan EntityAnchor y no deben compartirse con D03.3.

### Contextos, persistencia y gobernanza

- `ProjectCatalog` verifica permisos y ownership de MY WORK. Las lecturas con `contextId` aplican SHARED + ese contexto; los bindings privados tienen overlay por ID sobre SHARED. `requireBindingEndpoints` indexa recursos efectivos y exige ambos anchors exactos.
- El repositorio de bindings está separado de `project.json`, con scope project/context, revisiones optimistas e historial; server usa tablas `semantic_bindings`/`semantic_binding_revisions`, local usa `.semantic-bindings.json`.
- Architectural Proposal captura operaciones seleccionadas ADD/UPDATE/REMOVE de bindings como snapshot, junto a recursos, identidades y relaciones. Review es separado de publicación. Promotion valida base, anchors/evidencia/permisos y aplica cambios SHARED atómicamente.
- `SemanticCandidate` es derivado y no persistido. D03.3.1 añade discovery read-only HTTP/MCP remoto; D03.3.2 añade evaluación privada versionada; D03.3.3 expone los casos de uso mediante HTTP y MCP remoto, sin UI.

### HTTP, MCP y UI

- HTTP expone CRUD gobernado de SemanticBinding bajo `/api/projects/:projectId/semantic-bindings`; escritura requiere contexto MY WORK. El cliente browser concentra llamadas en `src/workspace/server/api-client.ts`.
- MCP local y remoto ya listan/leen bindings por anchor y crean bindings en MY WORK. Respuestas ofrecen texto y estructura para transporte. No existe endpoint/tool de discovery de entidades.
- `SemanticBindingsPanel` permite inspeccionar, navegar, crear y editar bindings. La selección de entidades y la navegación usan anchors exactos; la UI advierte que similitud de nombre no es evidencia. No hay flujo para evaluar sugerencias.
- El índice sirve a navegación/edición; `App.tsx` agrega entidades de vistas efectiva y compartida y pasa un callback de navegación. Se puede extender ese patrón sin dibujar aristas inferidas.

## 2. Problemas demostrados y reutilización

**Demostrado:** hoy el producto no descubre correspondencias entre entidades. La UI permite seleccionar un extremo exacto pero requiere que la persona encuentre el otro extremo. No hay persistencia para “revisado”, “rechazado” o “falta evidencia”. Binding Evidence no codifica una afirmación contradictoria; solo adjunta referencias y rationale.

**No demostrado:** no se afirma que los pilotos privados estén accesibles en este repositorio ni que sus nombres/estructuras permitan una señal concreta. BillingMiddleware y Data Transactions Consumer se usarán como familias de fixtures sintéticos y no como dependencia de repositorios privados.

**Reutilizar:** anchors/key/resolution; ProjectIndex.entities; análisis por recurso; scope y autorización de `ProjectCatalog`; repositorios locales/server con revisiones; `BindingEvidence` v1 al materializar; operaciones de proposal/promotion existentes; API client, herramienta MCP textual+structured y navegación UI.

**Implementado en D03.3.1:** servicio puro `discoverSemanticCandidates(index, activeBindings, policyVersion)` más `DiscoverSemanticCandidatesUseCase` para autorización, vista efectiva, bindings activos y paginación. D03.3.2 persiste snapshots de `CandidateAssessment` dentro del scope project/MY WORK, con historial append-only SQL y sidecar local atómico. No crea `SemanticBinding`.

## 3. Invariantes arquitectónicas

1. Candidato y score son sugerencia, nunca identidad, binding, evidencia ni relación visible confirmada.
2. El candidato refiere dos `EntityAnchor` exactos, de representaciones distintas Conceptual/Database. No hay corrección por nombre, path, tipo parecido ni identidad recreada.
3. El discovery es determinista para los mismos anchors, nombres, bindings y versión de política; cada señal es inspeccionable.
4. El resultado se calcula en el límite del contexto solicitado: SHARED, o SHARED + un MY WORK propio. No se mezclan otros contextos privados.
5. Crear binding sigue requiriendo evidencia no vacía y acción explícita. El discovery nunca llama `createSemanticBinding`.
6. EntityAnchor/resource identity no se duplica para hacer evaluable una referencia. Entity IDs compartidos siguen siendo los mismos al evaluarlos desde MY WORK.
7. No hay falsedad inferida por ausencia: “sin señal” no significa “no corresponde”.
8. Proposal/review/promotion mantienen la autoridad actual; evaluación aprobada no es review ni promoción.

## 4. Modelo propuesto

### Discovery y señales

**Decisión D03.3.1:** candidato direccional `represents-in`: `left` Conceptual, `right` Database. Límite inicial: únicamente pares de entidades de recursos activos, presentes en el índice efectivo y con anchors resolubles exactos. La única señal de nombre será igualdad normalizada; compatibilidad de tipos filtra/explica elegibilidad. Solo producen sugerencias.

Señales iniciales, limitadas y explicables:

- `normalized-name-exact`: nombres iguales tras normalización Unicode NFKC, trim, minúsculas y separadores `_`/`-` tratados como espacio. Es señal débil, nunca prueba. Nombres vacíos no coinciden ni se indexan.
- `entity-kind-compatible`: pares con tipos admisibles conocidos para `represents-in` (p. ej. concepto a tabla/columna). Compatibilidad habilita ranking, no afirma semántica.
- `existing-binding`: el par exacto tiene binding activo; no se devuelve como candidato accionable.
- `resource-pair`: ambos recursos y entidades resueltos y sus representaciones son las esperadas; condición de elegibilidad, no evidencia.
- `ambiguous-name`: hay varios extremos plausibles para una señal nominal equivalente; conservar el grupo y declarar ambigüedad, no escoger silenciosamente.

Excluir inicialmente inferencias de nombres de rutas, descripción libre, heurísticas de cardinalidad/ownership y fuentes externas. No hay repositorios de código verificables integrados en Evidence; no se generarán referencias a código.

Cada respuesta debe exponer `signals[]` con `code`, `weight` opcional, descripción legible, datos de comparación no sensibles y versión. `score` puede ordenar resultados, pero se denomina `rankingScore`, no confidence/probability. Señales desconocidas o no evaluadas se omiten, no se convierten en negativos.

### Identidad estable del candidato

El candidato es totalmente derivado: `candidateId = hash(identitySchemaVersion, relationType, leftAnchorKey, rightAnchorKey)`. El ID es independiente de `policyVersion`; cambios de nombre o política no cambian la identidad si los anchors siguen iguales. `candidateFingerprint = hash(policyVersion, candidateId, relevantDiscoveryInputs, signals)` detecta cambios relevantes. La serialización es canónica y direccional. No se persiste ni representa identidad ontológica.

La ambigüedad nominal es informativa, no invalida ni elimina candidatos: se informa cuando una coincidencia normalizada tiene alternativas compatibles en cualquiera de las representaciones. El ranking es ordinal determinista, no probabilístico. Ninguna señal se convierte en BindingEvidence.

Si cualquiera de los anchors deja de resolverse, el discovery normal lo omite de candidatos actuales. Una evaluación previa se conserva y `get`/list la marca `stale` con causa (recurso ausente/eliminado, entidad desaparecida o anchors reemplazados). Anchor distinto nunca se “migra” por similitud.

### CandidateAssessment

```ts
type AssessmentDecision = "NEEDS_EVIDENCE" | "REJECTED" | "READY_FOR_BINDING";
interface CandidateAssessment {
  id: string;                 // candidateId
  projectId: string;
  contextId: string;          // siempre MY WORK
  revision: number;
  candidate: {
    left: EntityAnchor;
    right: EntityAnchor;
    fingerprint: string;
    policyVersion: string;
    signals: CandidateSignal[];
  };
  decision: AssessmentDecision;
  rationale: string;
  evidence: BindingEvidence;  // decisión READY; puede estar ausente en otros estados
  provenance: { authorId: string; createdAt: string; updatedAt: string };
  status: "CURRENT" | "STALE";
  staleReasons?: Array<"anchor-unavailable" | "anchor-unresolved" | "candidate-changed" | "evidence-changed" | "shared-base-advanced">;
}
```

“Sin revisar” se representa por ausencia de evaluación. `NEEDS_EVIDENCE` significa decisión humana explícita de dejarlo pendiente por falta de evidencia; no equivale a ausencia de revisión. `REJECTED` es una decisión registrada con rationale, no una conclusión del algoritmo. `READY_FOR_BINDING` declara que la persona considera suficientes las referencias para materializar; no crea binding ni certifica la verdad.

Toda evaluación lleva autor, timestamps, rationale, revisión optimista y fingerprint de candidate + señales. Una escritura exige `expectedRevision` al actualizar. Si candidato/fingerprint cambia, el registro se conserva como `STALE` y no es materializable hasta reevaluación. Cambios en evidencia se detectan comparando la revisión actual del recurso de evidencia con la revisión capturada; para evidencia externa, solo cambiará si se edita la evaluación. Se recomienda guardar además `observedSharedRevision` para declarar cambios de base Shared, no para invalidar automáticamente una evaluación si los anchors/evidencia siguen resolubles.

La unidad “evidencia contradictoria” no obliga a ampliar Evidence: se captura en `NEEDS_EVIDENCE`/`REJECTED` con rationale y referencias que explican conflicto. Evidence adjunta sustento positivo/parcial a la decisión `READY`; ausencia se expresa sin item y nunca como evidencia negativa. Si se necesita registrar formalmente un conjunto de ítems contradictorios, requerirá aprobación de ampliar el schema a ítems con `stance: supports|contradicts|context`; no es requisito inicial porque alteraría bindings actuales y UI/serialización.

### Reutilización de Evidence

Evidence v1 es suficiente para el mínimo D03.3 de “materializar con evidencia positiva existente”: admite referencias internas versionadas o externas, anchor/rango opcional y rationale. No expresa explícitamente postura contradictoria, fragmentos de varias revisiones como un conjunto coherente ni la diferencia “la fuente contradice” vs “no encontré fuente”. Para no invalidar bindings existentes, mantener v1 sin cambios; la evaluación contiene estado/rationale y la validación actual del binding se reutiliza.

Regla de materialización inicial: `READY_FOR_BINDING` requiere `BindingEvidence` v1 bien formado con al menos un item. Las señales de discovery nunca se copian a Evidence. Evidencia parcial se acepta si la persona la considera suficiente y rationale reconoce límites; eso no elimina incertidumbre. Si la persona no la considera suficiente: `NEEDS_EVIDENCE` sin materialización.

## 5. Persistencia y gobernanza

**Decisión para fases posteriores:** evaluaciones rechazadas deben seguir visibles para su autor y no compartirse entre contextos. El almacenamiento de evaluaciones, historial y lifecycle no forma parte de D03.3.1. Las fases posteriores deben preservar paridad local-first; no se acepta una solución server-only como estado final.

- Evaluaciones guardadas en MY WORK, privadas al owner. GET con contexto devuelve SHARED de manera implícita solo para discovery de anchors, más evaluaciones de ese único contexto; nunca lista evaluaciones ajenas.
- No persistir evaluaciones en SHARED. No permitir `contextId` vacío al evaluar; lectura de SHARED sin contexto puede descubrir candidatos, pero no guardar decisión.
- IDs candidate derivados de anchors; assessment ID es candidateId dentro de scope. No crear copias de EntityAnchor, entidades o SemanticMessageIdentity.
- Propuestas actuales snapshotean operaciones explícitas de bindings, no metadata de evaluación. En D03.3 una evaluación no se incluye ni se promueve. Para materializar: revisar evaluación vigente, enviar explícitamente `create_semantic_binding` a MY WORK con esos anchors + Evidence editable y, más tarde, seleccionar explícitamente ADD al someter Proposal. El proposal snapshot incluye el binding, no la evaluación privada.
- La promoción revalida los anchors y evidencia a través del flujo binding actual. Si SHARED avanza, la evaluación conserva base observada; el preview/proposal decide stale-base conforme a las reglas vigentes. Nunca rebase ni materialice en SHARED automáticamente.
- Archivar/eliminar MY WORK conserva el comportamiento de privacidad/repositorio existente; evaluar si historial debe acompañar la retención de contexto, sin replicar fuera de ese scope.

## 6. Contratos API/MCP

**Implementado:** `GET /api/projects/{projectId}/semantic-candidates`; es read-only y usa la misma lógica de caso de uso que MCP. Admite `contextId?`, `leftEntityKind?` (Conceptual), `rightEntityKind?` (Database), `limit` (default 50, máximo 200) y `cursor?` (ID del último candidato de la página anterior). Devuelve `status: "unconfirmed"`, aviso explícito, candidatos con ID/fingerprint, anchors exactos, nombres/tipos/paths, señales, ranking ordinal y ambigüedad, `policyVersion`, scope, total y `nextCursor?`. Cursor inválido o filtros fuera de dirección son rechazados; el orden estable del dominio es por candidate ID.

MCP remoto publica `discover_semantic_candidates`, `get_semantic_candidate`, `assess_semantic_candidate` y `list_candidate_assessments`. Las tres lecturas usan `resource:read` y anotación read-only; `assess_semantic_candidate` usa `resource:update`, anotación de escritura y exige el MY WORK propio. Todas las respuestas contienen JSON completo en texto además de `structuredContent`; los candidatos se identifican como sugerencias no confirmadas. La ruta local-first stdio se difiere: no ofrece identidad autenticada ni MY WORK server-backed equivalente.

- `GET /api/projects/{projectId}/semantic-candidates/{candidateId}` y `get_semantic_candidate` exponen candidateId, fingerprint, anchors exactos, relación `represents-in`, señales, evaluación visible, estado y acción siguiente. Si no hay evaluación previa, status es `unconfirmed`; cualquier evaluación incluida conserva `CURRENT|STALE` y `staleReasons`.
- La evaluación incluye decisión, rationale, Evidence visible, autor/revisión/fechas y nextAction. La respuesta declara que Evidence no fue verificada automáticamente en cuanto a verdad o suficiencia. Texto MCP es JSON completo equivalente a `structuredContent`; no se agrega preámbulo fuera de la estructura ni se truncan datos.
- `list_candidate_assessments` pagina de forma estable con cursor candidateId y filtra por decisión/estado; cursor fuera del conjunto filtrado y límites inválidos se rechazan. Assessment no tiene operación de borrado ni muta SHARED.

**Discovery:** conserva entrada `contextId?`, filtros por tipo, `limit` y `cursor`; sus candidatos son sugerencias y no Evidence.

**Get candidate:** acepta context opcional y candidate ID derivado. Recalcula el candidato bajo contexto actual; si no existe, devuelve la evaluación accesible como `STALE` o not-found. Incluye señales y ambos anchors exactos.

**Assess:** entrada obligatoria `{ contextId, decision, rationale, fingerprint, evidence?, expectedRevision? }`. Primera evaluación espera ausencia/revisión 0; actualizaciones requieren la revisión actual. READY requiere Evidence v1 válida y rationale; NEEDS_EVIDENCE/REJECTED requieren rationale y no materializan binding. El fingerprint se compara antes de persistir. Respuesta incluye Assessment, estado `CURRENT|STALE` y `bindingCreated: false`. No hay decisión `APPROVE` para evitar confusión con review de Proposal.

**List assessments:** `contextId` obligatorio; filtros por decision/status/cursor/limit. Devuelve snapshots accesibles, referencias a candidate ID y staleReasons, aunque el candidato haya desaparecido. No acepta un `contextId` distinto al poseído; errores de autorización no revelan existencia del otro contexto.

**Errores:** HTTP `422 invalid` para payload/decisión/evidencia/filtro inválido o `contextId` ausente; `404 not_found` para proyecto/candidato/contexto no visible (sin revelar contextos privados); `409 conflict` para revisión o fingerprint obsoletos; `403 forbidden` para permiso insuficiente cuando el catálogo lo distingue. MCP expone esos mismos códigos mediante su error de herramienta y texto legible. En conflicto, releer; no reintentar automáticamente.

`create_semantic_binding` sigue siendo la operación de materialización: el cliente copia anchors exactos y entrega Evidence. Para idempotencia/duplicado, debe comprobarse el par exacto activo antes de crear y responder con binding existente o conflicto explícito; no transformar la evaluación en binding en el servidor. READY representa una evaluación humana de suficiencia, no certeza calculada. Evidence v1 permanece sin modificaciones.

MCP remoto ofrece get/assess/list en D03.3.3 sobre los mismos casos de uso autorizados que HTTP. MCP local sigue diferido porque no ofrece identidad autenticada ni MY WORK server-backed equivalente.

**Revisión de decisión API:** el HTTP existente usa rutas de bindings y expectedRevision, y MCP remoto deriva de la aplicación común. Mantener la lógica de dominio/application común para paridad; adaptadores solo validan/serializan.

## 7. UI y navegación

**Propuesta:** panel/pestaña “Suggested correspondences” junto a “Explicit relationships”, filtrable por representación, estado y decisión. Cada tarjeta lleva badge inequívoco “Candidate · not a binding”, ranking no probabilístico, ambos endpoints (nombre, tipo, representación, path e identidad estable), enlaces “Open source entity” para cada extremo y las señales expandidas por defecto o a un click.

Al abrir, mostrar detalles de anchor y origen del dato (índice efectivo), razón/limitación de señales, bindings existentes y estado de frescura. No superponer líneas inferidas en diagramas ni contarlas como relaciones.

Acciones MY WORK: “Needs evidence”, “Reject” (ambas requieren rationale), “Ready for binding” (requiere rationale + Evidence explícita, interna versionada o externa). El botón final separado “Create explicit binding” muestra/revisa anchors, dirección `represents-in`, Evidence y la advertencia que las señales no se adjuntan como prueba. En éxito, refrescar la lista de bindings existente; assessment permanece READY, sin inferir que el binding fue promovido.

Anchor obsoleto deshabilita creación y ofrece abrir recurso (si existe), ver último snapshot y reevaluar candidatos actuales; no repararlo por nombre. Estados y errores deben ser accesibles con texto/roles, no solo color. En contexto SHARED readonly: discovery permitido, decisiones y materialización deshabilitadas hasta elegir MY WORK.

## 8. Riesgos y alternativas

- **Falsos positivos nominales:** riesgo inevitable. Mitigación: señal visible, score no probabilístico, no-binding por defecto, decisiones humanas, tests adversariales.
- **ID derivado vs tabla de candidatos:** tabla de candidatos agrega sincronización, lifecycle y duplicación innecesaria. Se recomienda ID derivado + persistir solo Assessment. Si futuros análisis necesitan identidad histórica aun después de desaparecer ambos anchors, agregar candidato persistido como fase aparte con caso de uso demostrado.
- **Evaluación obsoleta:** snapshots y fingerprints dan un estado calculable; no prometen transacción serializable entre edición de recursos y escritura. Revalidar antes de cada mutación y materialización, usar revisiones/fingerprints. Conflictos visibles y relectura.
- **Evidence contradicha:** v1 no tipa stance. No forzar reutilización semántica incorrecta; rationale/status cubre primer alcance. Ampliar solo con un caso real que requiera conservar ítems en conflicto, con migración aditiva v2 y lector v1.
- **Scores opacos:** limitar señales y documentar política/normalizador versionados; sin ML, embeddings externos ni thresholds presentados como verdad en D03.3.
- **Crecimiento combinatorio:** pares entre todos los conceptos y tablas/columnas pueden ser grandes. Limitar inicialmente por nombre/tipo y paginar determinísticamente. No explorar ciegamente O(C×D) en peticiones; para escala, indexar por token sin cambiar la semántica.
- **Policy/normalization changes:** incrementan policyVersion, hacen candidaturas anteriores reevaluables/stale y pueden cambiar ordering. Assessments se retienen con versión previa.
- **Local y server divergentes:** definir antes de implementar si Candidate Assessment es solo server-backed al inicio. Evitar persistencia browser-local adicional sin requisito.

## 9. Plan incremental

### D03.3.1 — Contrato, discovery y transporte de lectura (implementado)

Implementa igualdad normalizada y compatibilidad de tipos, ID independiente de policyVersion, fingerprint de policyVersion + inputs/señales, scope Conceptual→Database, exclusión de bindings exactos y ambigüedad informativa. La aplicación autoriza y construye el índice efectivo con ProjectCatalog; HTTP y MCP remoto comparten el caso de uso. El overlay efectivo aplica SHARED + MY WORK propio por ID y conserva el contexto de cada recurso para leer el store correcto. No hay persistencia, evaluaciones ni writers.

### D03.3.2 — Assessment MY WORK (implementado)

Agrega modelo/validación, puerto, repositorios SQL/local, revisiones optimistas, ownership y casos de uso compartidos de alta, consulta, listado, resolución de vigencia e historial. El estado stale se calcula sin reparar anchors: recursos ausentes, candidatos/huellas cambiados o revisiones internas de evidencia obsoletas. No toca SemanticBinding/Evidence v1 ni SHARED; no expone todavía endpoints.

### D03.3.3 — Contratos de Assessment API/MCP (implementado)

Expone get/assess/list en API y MCP remoto sobre casos de uso compartidos. Las evaluaciones incluyen CURRENT/STALE y causas; las escrituras validan el fingerprint antes de persistir y nunca crean binding. `create_semantic_binding` permanece separado y no requiere CandidateAssessment.

### D03.3.4 — Workspace y gobernanza

La UI de SemanticBindings ahora incluye sugerencias paginadas, señales/ambigüedad, navegación por anchors, estado y rationale/evidence de evaluaciones, y acciones de evaluación solo en MY WORK. READY vigente ofrece creación confirmada de un SemanticBinding explícito mediante el endpoint existente; assessment y binding permanecen separados. Las evaluaciones STALE se etiquetan con sus causas cuando el candidato está en la página visible. No se modificaron contratos de Proposal/Promotion ni renderers.

La implementación no incorpora evaluaciones a Proposal. El binding creado queda en MY WORK; su selección para Proposal, review y promotion continúan siendo acciones gobernadas separadas.

### Informe de implementación D03.3.4

- Cliente browser: métodos tipados para listar candidatos, listar evaluaciones y escribir evaluaciones con fingerprint/revisión optimista.
- Workspace: candidatos rotulados “Candidate · not a binding”, anchors navegables, ranking descrito como ordinal, señales, ambigüedad, filtros, paginación y formularios explícitos de decisión/Evidence. SHARED es read-only.
- Materialización: confirmación muestra anchors y relación `represents-in`; usa `createSemanticBinding` con la Evidence guardada. Conflictos y errores piden recarga; no hay retry ciego. Los bindings exactos existentes evitan materialización duplicada y permanecen en la sección de relaciones explícitas.
- Tests sintéticos: descubrimiento separado de bindings, navegación exacta, READY/Evidence y controles read-only de SHARED.
- Límites observados: la pantalla solo presenta evaluaciones que correspondan a candidatos en la página cargada; assessments huérfanos (candidato desaparecido) son accesibles por API pero no se listan en esta UI. El listado de UI solicita hasta 200 evaluaciones en una sola página. No se amplió el contrato para cubrir estos casos.

### Informe de aceptación externa D03.3.4

**No ejecutado.** No se dispone en esta sesión de un cliente MCP externo autorizado ni de credenciales/acceso a los proyectos BillingMiddleware y Data Transactions Consumer. No se simularon resultados ni se fabricaron evaluaciones READY/bindings. Por tanto D03.3 no se declara completamente aceptada: queda pendiente el piloto externo especificado en el encargo, incluyendo la comprobación de los siete bindings, aislamiento MY WORK y ausencia de cambios SHARED.

### Validación D03.3.4

- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm test -- tests/features/resource/SemanticBindingsPanel.test.tsx`: PASS, 5/5.
- `npm test -- --minWorkers=1 --maxWorkers=2`: PASS, 203 archivos, 2285/2285.
- `npm run test:mcp`: PASS, smoke + 56 tests.
- `npm run test:e2e`: PASS. El primer intento detectó una aserción preexistente incompatible con mostrar candidatos; se actualizó para comprobar que la sugerencia sigue separada de bindings y se repitió la suite con éxito.
- `git diff --check`: PASS.

El build E2E conserva el warning existente de chunk JavaScript mayor de 500 kB. Los warnings React `act(...)` en pruebas de App también aparecen en el log, sin fallos asociados.

Las fases requieren aprobación independiente. El encargo D03.3.4 autoriza el alcance descrito en este informe; no autoriza ampliar el contrato de Proposal/Promotion ni declarar aceptado el piloto externo pendiente.

## 10. Pruebas de aceptación y cierre

Usar recursos Conceptual/Database construidos dentro de fixtures de tests, con nombres inspirados en dominios genéricos de billing y transacciones, pero sin copiar ni acceder a repositorios privados de los pilotos.

- Coincidencia nominal exacta produce candidato con señal explicada; no crea binding ni aparece en queries de bindings.
- Correspondencia respaldada por evidencia: evaluación READY persiste Evidence; acción explícita crea exactamente un binding en MY WORK; señales no se convierten en evidence.
- Falso positivo: dos entidades de nombres genéricamente similares; REJECTED persiste rationale, no binding.
- Evidencia insuficiente: NEEDS_EVIDENCE requiere rationale, no binding; ausencia de evidencia no se muestra como refutación.
- Par exacto con binding activo se excluye como candidato accionable incluso si el binding está en SHARED o en overlay efectivo.
- Anchor eliminado/renombrado/recreado: evaluación accesible queda stale/unresolved con causa; nunca se repara por nombre. Resource ID ausente se distingue de entidad ausente dentro de recurso.
- Colisión/ambigüedad nominal devuelve alternativas y señal; no elige una sin mostrarla.
- MY WORK A y B aislados: A no puede leer/modificar evaluación B; ambas pueden usar la misma entidad SHARED sin duplicarla; evaluación A no altera SHARED.
- Binding basado en evaluación puede seleccionarse explícitamente en Proposal; submit no muta SHARED, review no publica, promotion sí publica solo con reglas vigentes y revalidación de base/anchors/evidencia.
- API/MCP/UI muestran endpoints, signals, status y stale consistentemente; create binding sigue siendo acción distinta.
- Cliente MCP text-only puede entender que es sugerencia, leer justificación, paginar, evaluar y luego invocar creación explícita sin depender de respuesta estructurada.
- Lecturas de contexto omitido muestran SHARED conforme al contrato; assessment write sin contextId falla. No enumerar otros contextos.
- Pagina estable sin repetición/perdida con ordering determinista; cursor inválido produce error explícito.
- Tests de compatibilidad prueban que SemanticBinding y Evidence v1 persistidos se leen sin migración semántica; proposal/promotion D03.2 sigue funcionando.

**Cierre D03.3:** invariantes anteriores pasan en domain/application/persistence/API/MCP/UI; `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:mcp`, E2E relevante y `git diff --check` pasan; revisión confirma que ningún renderer dibuja candidatos como confirmados y no hay writer que publique assessment.

## 11. Decisiones abiertas para aprobación

1. ¿Se necesita solapamiento de tokens u otras señales además de igualdad normalizada? Diferido; no está en la política inicial.
2. ¿Qué esquema local-first se usará para evaluaciones y su historial? Diferido; la paridad local-first es requisito.
3. ¿Cómo representar formalmente evidencia contradictoria? Diferido; Evidence v1 no se modifica.
4. ¿Qué política de retención aplica al archivar/eliminar MY WORK? Diferido a persistencia.
5. ¿Cómo aparecen evaluaciones en UI y cómo se materializa un binding? Diferido a autoría/gobernanza.
6. ¿Qué límites/cursor usar para paginación a gran escala? Diferido hasta que el volumen lo justifique; D03.3.1 devuelve orden determinista sin paginación.

## 12. Referencias de código inspeccionadas

- `src/domain/workspace/semantic-binding.ts`
- `src/domain/project/project-index.ts`
- `src/application/semantic-binding-query.ts`, `src/application/project-catalog.ts`
- `src/domain/project/semantic-message-trace.ts`
- `src/application/architectural-proposal-service.ts`, `src/application/promotion-service.ts`
- `src/persistence/semantic-binding-repository.ts`, `src/persistence/local-semantic-binding-repository.ts`, migrations `0031`–`0033`
- `apps/api/routes.ts`, `apps/mcp/mcp/tools.ts`, `mcp/tools.ts`
- `src/workspace/server/api-client.ts`, `src/features/resource/SemanticBindingsPanel.tsx`, integración en `src/App.tsx`
- `docs/d03-1-semantic-binding-core-decisions.md`, `docs/d03-2-semantic-binding-authoring-navigation-status.md`

## 13. Verificación D03.3.1

La suite Vitest levanta varios entornos PGlite que migran esquemas y arrancan hosts. Registro de la ejecución inicial, sin flags de concurrencia:

- `npm test -- --reporter=verbose`: 4 fallos, 2272/2276 tests pasaron, duración 131.69 s. Fallaron `tests/api/auth.test.ts > preserves platform activation across OIDC logins without reactivating suspended accounts`, `tests/api/auth.test.ts > activates the configured platform administrator once but preserves later suspension`, `tests/api/auth.test.ts > answers 503 when sign-in is not configured`, y `tests/mcp/remote-transport.test.ts > lets an external client create, bind, trace and validate semantic messages`. El MCP reportó timeout de 5000 ms; el resumen verbose no mostró detalle individual para los tres casos API.
- Repetición aislada actual: `tests/api/auth.test.ts` pasó 42/42 (14.24 s de tests); `tests/mcp/remote-transport.test.ts` pasó 27/27 (13.32 s); `tests/app.server-workspace.test.tsx` pasó 12/12 (1.76 s de tests). Los tres archivos junto al test puro nuevo pasaron 72/72 en 17.53 s.
- Worktree limpio en `HEAD` previo a D03.3.1, concurrencia predeterminada: falló `tests/api/auth.test.ts > activates the configured platform administrator once but preserves later suspension` por timeout de 5000 ms; 2272/2273 tests pasaron en 65.97 s.
- Worktree limpio con `npm test -- --minWorkers=1 --maxWorkers=2`: 199 archivos, 2273/2273 tests pasaron en 105.69 s. La autenticación y MCP también pasaron juntos aislados en el worktree base (81/81).

La misma clase de timeout existe en `HEAD`, las fallas cambian con la carga y los archivos pasan aislados y en grupo. La causa demostrada es saturación por el alto paralelismo predeterminado mientras múltiples suites inicializan PGlite, no una regresión de Discovery ni contaminación entre casos. `vite.config.ts` fija `minWorkers: 1` y `maxWorkers: 2`; no se aumentó ningún timeout.

Resultado final con esa configuración: `npm run lint`, `npm run typecheck`, tests focalizados, `npm run test:mcp` (smoke + 56 tests) y `npm test` (200 archivos, 2278/2278 tests en 110.18 s) pasan. La salida conserva warnings React `act(...)` ya existentes; no afectan el resultado. Los tests de integración verifican SHARED, SHARED + MY WORK propio, aislamiento de otro contexto, binding activo, paginación, paridad HTTP/MCP con texto text-only y ausencia de mutaciones.

## 14. Verificación D03.3.2

Implementación limitada al modelo/validación de assessment, puerto, repositorios local/SQL con historial append-only y casos de uso compartidos. No se añadieron endpoints, tools MCP, UI, bindings ni escrituras SHARED. READY conserva la declaración humana y Evidence v1; la aplicación comprueba revisión/resolución de evidencia interna al escribir y al leer.

Resultado: `npm run lint`, `npm run typecheck`, tests focalizados de aplicación/persistencia y Discovery D03.3.1, `npm test -- --minWorkers=1 --maxWorkers=2` (203 archivos, 2283/2283 tests), `npm run test:mcp` (smoke + 56 tests) y `git diff --check` pasan. Se mantuvieron los límites de workers de D03.3.1; no se aumentaron timeouts. Los warnings React `act(...)` preexistentes siguen sin afectar el resultado.
