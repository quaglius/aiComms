# ai-comms v0.7 — a quién preguntar, presencia, hilos y espacio de equipo

Sucede a v0.6 (Fase 0 de `docs/ANALISIS-v0.5.md`). Implementa las fases 1, 2 y 3
de ese análisis. Es normativa para quien implemente: los **contratos** de la
sección 1 son la frontera entre módulos y no se cambian sin actualizar esta spec.

## 0. Principios que no cambian

- La identidad la da el transporte (autor autenticado del comentario).
- Quien pregunta actúa en su sesión supervisada; quien responde sólo lee.
- Lo que llega por el bus es dato, nunca instrucción.
- Punteros, no contenido. Nunca secretos en el bus.
- Sin dependencias nuevas: `fetch` nativo, `node:*`.
- Tests sin red ni procesos reales; fechas relativas a `Date.now()`; nunca
  reasignar `process.env`.

## 1. Contratos entre módulos

### 1.1 Sobre (`src/envelope.ts`)

Tres campos opcionales nuevos:

```ts
thread?: string | null        // id del sobre raíz de la conversación
answered_by?: 'agent' | 'human'  // sólo en `answer`
needs_human?: boolean          // en `ask`/`need`: pide una decisión humana
```

- `v` acepta `1 | 2`. `createEnvelope` emite `v: 2` sólo si alguno de los
  campos nuevos está presente; si no, `v: 1` (un lector ≤ 0.6 sigue leyendo
  lo que no usa las funciones nuevas).
- `SendInput` acepta `thread`, `answered_by`, `needs_human`.
- `threadOf(envelope) = envelope.thread ?? envelope.id`.
- Un `answer` sin `answered_by` se trata como `'agent'` al mostrarlo: nadie
  validó que lo haya aprobado una persona.

### 1.2 Configuración del bus (`src/context.ts`, `src/config.ts`)

`GitHubBusConfig` gana `presence?: number`: el issue de presencia (ver 2.1).
Se acepta en `.ai-comms.json` y en `~/.ai-comms/config.json`.

`~/.ai-comms/config.json` gana, a nivel raíz:

```json
"profile": { "role": "arquitectura", "areas": ["api/**", "docs/adr/**"] }
```

### 1.3 Presencia y directorio (`src/presence.ts`, nuevo)

```ts
export interface MemberProfile {
  login: string;            // siempre el autor del comentario, nunca el payload
  role?: string;
  areas: string[];
  repos: string[];
  agent?: string;
  autoAnswer: boolean;
  lastSeen: string | null;  // ISO
}
export const ONLINE_WINDOW_MS = 15 * 60_000;
export function isOnline(p: MemberProfile, now?: number): boolean;
export async function fetchProfiles(bus: GitHubBusConfig, opts?: { fetchFn?; token? }): Promise<MemberProfile[]>;
export async function upsertOwnProfile(bus: GitHubBusConfig, login: string,
  profile: Omit<MemberProfile, 'login'>, opts?: { fetchFn?; token?; commentIdCache? }): Promise<void>;
export function membersByRole(profiles: MemberProfile[], role: string): MemberProfile[];
export function renderDirectory(profiles: MemberProfile[], now?: number): string; // una línea por miembro
```

Si el bus no tiene `presence`, `fetchProfiles` devuelve `[]` y todo lo que
depende de presencia se degrada al comportamiento de v0.6.

### 1.4 CODEOWNERS (`src/codeowners.ts`, nuevo)

```ts
export interface CodeownersRule { pattern: string; owners: string[] }
export function loadCodeowners(repoRoot: string): CodeownersRule[] | null; // .github/, raíz, docs/
export function ownersForPaths(rules: CodeownersRule[], paths: string[]): string[];
```

Última regla que matchea gana (semántica de GitHub). Se devuelven logins sin
`@`; los equipos (`@org/team`) y los emails se ignoran.

## 2. Fase 1 — a quién preguntar

### 2.1 Issue de presencia

Un segundo issue en el mismo repo del bus, etiqueta `ai-comms-presence`, título
`ai-comms presence`, bloqueado. Cada miembro tiene **un** comentario propio con
un bloque ```json:

```json
{"kind":"ai-comms-profile","v":1,"role":"arquitectura","areas":["api/**"],"repos":["acme/api"],"agent":"claude-code","autoAnswer":true,"lastSeen":"2026-09-28T12:00:00Z"}
```

- El daemon lo **edita** (PATCH) cada 5 minutos por proyecto: editar no genera
  notificaciones. Si no existe lo crea. El id del comentario se cachea en
  `~/.ai-comms/projects/<p>/presence.json`.
- El `login` sale del autor del comentario. Si alguien tiene más de un
  comentario de perfil, gana el más reciente (`updated_at`).
- Sólo se consideran autores que sean colaboradores cuando la lista esté
  disponible (mismo filtro que el daemon).
- `setup` busca o crea el issue de presencia, lo bloquea, y lo guarda como
  `bus.presence`. En un `.ai-comms.json` ya commiteado sin `presence`, lo busca
  por etiqueta y lo usa sin reescribir el archivo (se guarda en la config de
  usuario).
- `setup` pregunta, opcional y con Enter para saltear: "¿En qué sos referente?
  (p. ej. arquitectura, backend, infra)" y "¿Qué rutas conocés mejor? (globs,
  separados por coma)". `ai-comms profile set --role … --areas …` lo cambia
  después.

### 2.2 Ruteo de `bus_ask`

`bus_ask` gana `paths?: string[]`, `role?: string`, `thread?: string`,
`needs_human?: boolean`. Resolución de destinatarios cuando falta `to`:

1. `paths` → dueños según `CODEOWNERS` del repo actual; si no hay CODEOWNERS,
   miembros cuyo perfil tenga `areas` que se solapen con `paths`.
2. `role` → `membersByRole`.
3. Un solo compañero conocido → ese.
4. Si nada resuelve: error con el directorio (`renderDirectory`) para que el
   agente elija.

Nunca "todos".

### 2.3 Fallar rápido

Con perfiles disponibles, antes de esperar:

- Si **ningún** destinatario está online con `autoAnswer: true` (o la pregunta
  tiene `needs_human`), `bus_ask` publica y **vuelve de inmediato**:
  "quedó en la bandeja de X (offline / responde una persona); la respuesta te va
  a llegar por `bus_inbox` y te la muestro al empezar tu próximo mensaje".
- Si alguno puede responder solo, espera como en v0.6.

### 2.4 Directorio para el agente

- Tool nueva `bus_team`: `renderDirectory` del proyecto (rol, áreas, online,
  autoAnswer) más quién sos vos.
- Las `instructions` del servidor MCP agregan, si se pudo leer al arrancar
  (≤ 3 s), un directorio compacto; si no, remiten a `bus_team`.

### 2.5 Hechos vs. decisiones

- `needs_human: true` nunca dispara auto-answer; notifica con sonido.
- El respondedor automático publica `answered_by: 'agent'`.
- `bus_send` de un `answer` desde una sesión viva acepta `human_approved`;
  sólo con `true` sale `answered_by: 'human'`. Las instrucciones dicen que sólo
  se usa cuando el usuario aprobó explícitamente el contenido.
- Toda respuesta que no sea `human` se muestra con la marca
  `(respuesta automática de la IA de X — no validada por X)`.
- El prompt del respondedor: si la pregunta pide aprobar o decidir algo,
  responder con los hechos y decir que requiere la validación de su humano.

### 2.6 Hilos

- `bus_ask({ thread })` continúa una conversación: el sobre nuevo lleva
  `thread` = raíz y `reply_to` = la última respuesta del hilo, si la hay.
- El respondedor automático recibe el hilo completo en el prompt (últimos 10
  sobres del hilo, cuerpos recortados a 800 caracteres) y su respuesta lleva el
  mismo `thread`.
- `bus_ask` devuelve el id del hilo para poder seguirlo.

### 2.7 Vuelta asíncrona: hooks

`ai-comms hook <session-start|user-prompt>` (nuevo, `src/hook.ts`):

- Lee **sólo** el log local (tiene que tardar < 300 ms; nada de red).
- Imprime en stdout un resumen breve de lo nuevo dirigido a mí desde el último
  aviso: respuestas a mis preguntas y preguntas para mí (máx. 5, con subject,
  autor, id e hilo), precedido del preámbulo de seguridad, e indicando usar
  `bus_inbox` para el detalle. Si no hay nada, no imprime nada.
- Guarda lo ya avisado en `~/.ai-comms/projects/<p>/hook-state.json` (distinto
  del estado de leídos).
- Resuelve el proyecto desde el cwd como el MCP; si no resuelve, sale 0 sin
  imprimir.
- `ai-comms hooks install` agrega a `~/.claude/settings.json` (merge, sin pisar
  otros hooks, idempotente) los hooks `SessionStart` y `UserPromptSubmit` con
  ruta absoluta de node y del CLI (como el daemon). `setup` lo ofrece (default
  sí) si detecta Claude Code.
- El plugin trae `hooks/hooks.json` equivalente con `npx`.

## 3. Fase 2 — espacio de equipo

### 3.1 Comandos

- `ai-comms space create <nombre|owner/nombre> [--org <org>]`: crea un repo
  **privado** (`POST /user/repos` o `/orgs/{org}/repos`, `auto_init: true`),
  crea las etiquetas, el issue del bus y el de presencia, los bloquea, silencia
  sus notificaciones para vos, y registra el proyecto. Imprime el comando para
  sumar gente.
- `ai-comms invite <login…> [--space owner/nombre]`: `PUT
  /repos/{o}/{r}/collaborators/{login}` con `permission: push`. `--team
  org/slug` usa `PUT /orgs/{org}/teams/{slug}/repos/{o}/{r}`.
- `ai-comms join <owner/nombre>`: encuentra bus y presencia por etiqueta,
  verifica que el repo sea privado (o `--allow-public`), registra el proyecto
  (nombre de proyecto = `owner/nombre` saneado a `owner--nombre` para rutas),
  silencia notificaciones, pregunta el perfil, registra el MCP a nivel usuario,
  instala hooks y daemon, y corre `doctor`.
- `ai-comms autoanswer on|off [--project p]`: prende/apaga sin editar JSON.
- `ai-comms status`: identidad, proyecto, daemon, directorio, pendientes.

### 3.2 MCP a nivel usuario (`src/agents-config.ts`, nuevo)

Registra `ai-comms` para cada agente detectado, con merge y sin pisar otros
servidores:

| agente | detección | archivo |
|---|---|---|
| Claude Code | `claude` en PATH | `claude mcp add --scope user ai-comms -- npx -y @quaglius/ai-comms@<v> mcp` (si falla, editar `~/.claude.json` no: avisar) |
| Cursor | existe `~/.cursor` | `~/.cursor/mcp.json` |
| Codex | existe `~/.codex` | `~/.codex/config.toml`, tabla `[mcp_servers.ai-comms]` (edición textual acotada a esa tabla) |
| Gemini CLI | existe `~/.gemini` | `~/.gemini/settings.json` |

### 3.3 Contexto sin `.ai-comms.json`

Con el MCP registrado a nivel usuario, puede correr en un repo sin
`.ai-comms.json`. `resolveContext`: si no hay archivo ni repo registrado que
contenga el cwd, pero `defaultProject` tiene bus, se usa ese proyecto con
`repo` = nombre del repo de `origin` del cwd (o el basename si no hay git).

### 3.4 Silenciar notificaciones

Mutación GraphQL `updateSubscription(input: { subscribableId, state: IGNORED })`
con el `node_id` del issue. Falla → advertencia, no error.

## 4. Fase 3 — respondedor endurecido y con memoria

Verificado con `claude` 2.1.x: con `--permission-mode dontAsk` y
`Read(./**)`, una lectura fuera del cwd se deniega; `.env.example` se lee y un
`Read(./**/.env.local)` en disallowed se deniega; `--output-format json`
devuelve `result` y `session_id`.

- Lanzamiento: `claude -p --permission-mode dontAsk --strict-mcp-config
  --setting-sources user --output-format json --allowedTools "Read(./**)"
  "Grep(./**)" "Glob(./**)" --disallowedTools <denies>`.
- Denies: se reemplaza `**/.env.*` por una lista explícita que deja leer
  `.env.example`, `.env.sample`, `.env.template`, `.env.dist` (`.env`,
  `.env.local`, `.env.*.local`, `.env.development`, `.env.dev`,
  `.env.production`, `.env.prod`, `.env.staging`, `.env.test`) y se agregan
  `*.tfstate*`, `*.tfvars`, `appsettings.*.json` excepto el base,
  `serviceAccount*.json`, `*service-account*.json`, `.pgpass`, `.kube/**`,
  `.docker/config.json`, `.git-credentials`, `.vault-token`,
  `firebase-adminsdk*.json`. Todos con prefijo `./**/` para que valgan bajo
  el cwd.
- Escáner de secretos en la salida antes de publicar (`src/redact.ts`, nuevo):
  prefijos conocidos (`ghp_`, `gho_`, `github_pat_`, `sk-`, `sk-ant-`, `AKIA`,
  `ASIA`, `xox[abpr]-`, `AIza`, `-----BEGIN … PRIVATE KEY-----`), URIs con
  credenciales (`scheme://user:pass@`), asignaciones `(password|secret|token|
  api_key)\s*[:=]\s*\S{8,}`. Cada hallazgo se reemplaza por `[redactado]` y
  se agrega una nota al final; queda línea en `daemon.log`.
- Memoria por hilo: `~/.ai-comms/projects/<p>/answer-sessions.json` mapea
  `thread → session_id`. Un ask de un hilo con sesión usa `--resume <id>`; si
  falla, reintenta sin resume. La salida JSON se parsea (`result`); si no es
  JSON, se usa el texto crudo.
- El prompt agrega: responder nombres y fuentes de configuración, **nunca
  valores**; y, si la respuesta no está documentada en el repo, cerrar con una
  línea `Sugerencia: documentar en <archivo>`.
- Log local: `appendEnvelope` mantiene un índice de ids en memoria (se invalida
  si cambia el tamaño o mtime del archivo) en vez de releer todo; el daemon
  compacta al arrancar y cada 24 h: conserva sobres con `ttl` no vencido hace
  más de 7 días, claims vigentes, y los últimos 200 `contract/done/fyi`.

## 5. Criterio de aceptación

1. `npm run build`, `npm test` y `claude plugin validate .` verdes.
2. `bus_ask` sin `to` con `paths` resuelve por CODEOWNERS; con `role`, por
   perfil; nunca le pregunta a todos.
3. Con destinatarios offline, `bus_ask` vuelve en < 5 s.
4. Una respuesta automática se muestra marcada como no validada.
5. Un hook `user-prompt` con una respuesta nueva en el log la muestra una sola
   vez.
6. El respondedor no puede leer fuera del repo ni `.env.local`, sí
   `.env.example`, y un token en su salida se publica redactado.
