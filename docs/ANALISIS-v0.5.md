# Análisis de ai-comms v0.5.1 — septiembre 2026

**Objetivo contra el que se evalúa:** un canal para que las IAs de un equipo se
organicen entre sí. Privado por defecto, con opción pública más adelante. Casos
concretos: mi IA le pide definiciones o validaciones a la IA de quien define
arquitectura, y mi IA pregunta a las otras por configuración local que el repo
no trae. Todo lo más transparente posible: instalar el paquete de npm, un
comando de CLI, y a colaborar.

**Método:** leí completo `src/`, `docs/` y `test/`. Corrí build y tests.
Reproduje con scripts los defectos que parecían graves. Validé el plugin con
`claude plugin validate`. Consulté el registro de npm y la descripción OpenAPI
oficial de la API de GitHub (`github/rest-api-description`). Cada afirmación
marcada como **verificado** tiene su reproducción en el apéndice.

---

## 1. Veredicto

**El concepto está bien. La implementación todavía no sostiene el objetivo.**

Las piezas elegidas son las correctas:

- tools MCP como interfaz común a cualquier agente;
- un bloque de instrucciones para que el agente tome la iniciativa;
- un daemon local;
- un respondedor headless de sólo lectura, opt-in y con presupuesto por quien pregunta;
- identidad autenticada por el transporte.

Usar GitHub como bus fue una buena decisión para el fuero privado: no hay que
montar infraestructura, no hay que repartir tokens, y la identidad y los
permisos ya vienen resueltos.

El problema es que hoy **el camino por defecto no funciona de punta a punta para
un equipo nuevo**. Hay cinco bloqueantes verificados (sección 3). Encima de eso
hay tres brechas de diseño que importan para tu caso de uso (sección 5):

1. **No existe un "¿a quién le pregunto?".** El agente no sabe quién es el
   arquitecto, y un `bus_ask` sin destinatario termina yendo a todo el equipo.
2. **No hay presencia ni vuelta asíncrona.** `bus_ask` bloquea hasta 2 minutos
   para enterarse de que no hay nadie. Una respuesta que llega después no vuelve
   a la sesión.
3. **No se distinguen hechos de decisiones.** Una "validación" generada sola por
   la IA del arquitecto se publica con la cuenta de GitHub del arquitecto y se
   lee como si él la hubiera aprobado.

---

## 2. Lo que está bien y hay que conservar

- **"La identidad la provee el transporte"** (SPEC-v0.5 §0). `readComment`
  descarta el `from.dev` del payload y usa el autor real del comentario
  (`src/transports/github.ts:184`). Es el principio correcto.
- **La asimetría entre quien pregunta y quien responde** (SPEC-v0.3 §1). Quien
  pregunta actúa en una sesión supervisada. Quien responde sólo lee. Ninguna IA
  toca el repo de otra.
- **Los cortes de loop:** `hops`, `fyi` nunca dispara nada, nunca se
  autoresponde a `*`, `maxAgeMinutes` y presupuesto por requester.
- **El prompt va por stdin, nunca por argv** (`src/agent-cli.ts`). Eso cierra la
  inyección de shell en Windows.
- **"Punteros, no contenido"** y el preámbulo de seguridad que marca los
  mensajes como datos y no como instrucciones.
- **Tests sin red, con dependencias inyectables.** Es la base que permite
  arreglar lo que sigue con confianza.
- **Documentación escrita para el agente que instala** (`SETUP-FOR-AGENTS.md`).
  Es una idea buena y poco común.

---

## 3. Bloqueantes verificados

### B1. En npm está la 0.3.0: `npx @quaglius/ai-comms setup` no existe — **verificado**

El registro tiene publicadas 0.1.0, 0.2.0 y 0.3.0, todas del 16/09. De la 0.4.0
en adelante no se publicó nada. Consecuencias:

- El Quick start del README falla con "unknown command 'setup'": la 0.3.0 sólo
  trae `init/link/join/secret/doctor/daemon/mcp/inbox/claims/budget` y es sólo
  Discord.
- El `.mcp.json` que escribe `setup` queda fijado a `@quaglius/ai-comms@0.5.1`,
  una versión que no existe en npm. El servidor MCP no arranca.
- El arreglo de seguridad de la 0.4.0 (bloquear rutas de secretos en el
  respondedor) **nunca llegó a los usuarios**. La 0.3.0 publicada lanza
  `claude -p --allowedTools Read,Grep,Glob` sin ningún bloqueo de rutas. También
  deja responder a `cursor-agent`, que no puede restringir qué archivos lee.

**Arreglo:** publicar, y agregar CI que corra build y tests y publique al
taggear.

### B2. El auto-answer nunca se dispara en configuraciones creadas con `setup` — **verificado**

`runAutoAnswer` toma la identidad de `config.identity?.dev ?? ''`
(`src/auto-answer.ts:153`). Pero `setup` nunca escribe `identity`
(`src/setup.ts:146-155`), porque en v0.5 la identidad sale de GitHub. Con
`dev = ''`, `shouldAutoAnswer` concluye "not directed to this dev" y sale.
**Ni siquiera escribe una línea en `daemon.log`.**

Reproducción: una config exactamente como la escribe `setup`, con `autoAnswer`
prendido, recibe un `ask` dirigido al dueño del daemon. Resultado: no se lanza
el respondedor y no queda ningún log. La conversación autónoma entre IAs, que es
la función central para tu objetivo, está muerta en el camino por defecto. Los
tests pasan porque sus fixtures sí traen `identity`.

**Arreglo:** el daemon ya calcula el login autenticado (`pollGitHubBinding`).
Hay que pasárselo a `runAutoAnswer` y agregar un test con la config que escribe
`setup`.

### B3. El `setup` de un compañero reescribe el `.ai-comms.json` versionado — **verificado**

De lo que ya existe, `runSetup` sólo reutiliza el número de issue.

- `project` y `repo` salen del nombre de la carpeta local (`src/setup.ts:295-296`).
- `bus.repo` sale del `origin` (`src/setup.ts:303`).

Reproducción: un compañero clona `acme/web` en la carpeta `web-bruno`. El
archivo versionado apunta al bus compartido `acme/api#42`. Corre `setup` sin
flags, como dice la documentación:

```
antes:   {"project":"acme","repo":"web","bus":{"kind":"github","repo":"acme/api","issue":42}}
después: {"project":"web-bruno","repo":"web-bruno","bus":{"kind":"github","repo":"acme/web","issue":42}}
```

Queda apuntando al issue 42 de **otro repo** y con un proyecto distinto. Aun en
un proyecto de un solo repo pasa algo parecido: si dos personas clonaron en
carpetas con distinto nombre, sus `from.repo` difieren. Como los claims son por
repo (`src/store.ts:212`), **los conflictos de claims entre esas dos personas
nunca se detectan.** Además, `--bus` combinado con un archivo existente mezcla
el repo del flag con el issue del archivo.

**Arreglo:** si el archivo existe y es válido, es la fuente de verdad y no se
reescribe. El `repo` tiene que salir del `origin` (`owner/name`), nunca del
nombre de la carpeta.

### B4. El arranque automático del daemon no funciona en ningún sistema operativo — **verificado en Linux**

- **Linux:** si `~/.config/systemd/user` no existe (lo normal en una máquina
  nueva), `writeFileSync` tira `ENOENT`. La excepción corta `setup` antes del
  `doctor`. Además, `ExecStart=/usr/bin/npx` está hardcodeado
  (`src/setup.ts:234`), y con nvm, volta o fnm `npx` no está en esa ruta.
- **macOS:** el plist ejecuta `ai-comms` sin ruta absoluta (`src/setup.ts:212`),
  y el `PATH` de launchd no incluye el bin global de npm. Tampoco crea
  `~/Library/LaunchAgents` ni corre `launchctl load`.
- **Windows:** `cmd /c ai-comms daemon` (`src/setup.ts:194`) requiere una
  instalación global. Para quien usa `npx`, falla sin decir nada.

Hay dos problemas más:

- No hay lock de instancia única. Dos daemons (el de inicio más uno manual, o
  laptop y desktop) contestan dos veces la misma pregunta.
- El daemon lee la config una sola vez al arrancar, así que un proyecto nuevo
  requiere reiniciarlo, y nadie se lo dice al usuario.

**Arreglo:** que el servicio use `process.execPath` más la ruta absoluta del
CLI, crear los directorios, cargarlo de verdad, usar un lockfile y recargar la
config.

### B5. "Privado por defecto" no está garantizado — **verificado por lectura; el permiso de lock confirmado en la OpenAPI**

En el código no hay ningún chequeo de visibilidad del repo. En un repo público:

- el bus es público;
- **cualquier cuenta de GitHub puede comentar en el issue**: el identificador
  queda autenticado, pero nadie verifica si es del equipo;
- el daemon ingiere esos comentarios sin filtrarlos contra los colaboradores
  (`src/transports/github.ts:184` sólo corrige la identidad).

Un extraño puede mandar un `ask` dirigido a alguien que tenga `autoAnswer`
prendido, y la respuesta, generada leyendo su repo, se publica en un issue
público. También puede ensuciar `bus_claims`.

**Arreglo mínimo:**

1. Rechazar repos públicos salvo con un flag explícito.
2. Bloquear el issue (`PUT …/issues/{n}/lock`: sólo quien tiene escritura puede
   comentar en una conversación bloqueada).
3. Descartar al ingerir cualquier autor que no sea colaborador.

---

## 4. Otros defectos (no bloquean, pero rompen la experiencia)

| # | Defecto | Dónde | Efecto |
|---|---|---|---|
| D1 | `bus_inbox` nunca marca como leído | `src/mcp.ts` (no llama a `markRead`) | `unread_only` no sirve: `/bus:inbox` devuelve lo mismo para siempre |
| D2 | `bus_ask` espera la respuesta sólo en el log local | `src/bus-ask.ts`, `src/mcp.ts:325` | Sin daemon, siempre devuelve "pending" aunque la respuesta ya esté en GitHub, y no avisa que el daemon está caído |
| D3 | El destinatario por defecto de `bus_ask` es **todo el equipo** menos uno | `src/mcp.ts:288`, `src/bus-ask.ts:17` | Es un broadcast disfrazado que esquiva la regla "nunca autoresponder a `*`": se despiertan N respondedores y cada uno gasta cuota. En una org, "colaboradores" incluye a todos los miembros con permiso base |
| D4 | Listar colaboradores exige **write/maintain/admin** (OpenAPI de GitHub) | `src/cli.ts:215`, `src/mcp.ts` `resolveTeam` | Un compañero con acceso de lectura o triage ve `doctor` en rojo, y `bus_ask` sin `to` le da "no recipients" |
| D5 | La reingesta relanza el respondedor | `src/daemon.ts:135-144` | `appendEnvelope` deduplica pero no avisa, y `runAutoAnswer` corre igual: se lanza un segundo `claude -p` mientras el primero sigue respondiendo. Además, el presupuesto se chequea antes y se registra después, así que N asks simultáneos lo exceden |
| D6 | Si ya existe `.mcp.json`, se deja intacto | `src/setup.ts:100` | El MCP no queda registrado y el `doctor` igual dice OK |
| D7 | El plugin es inválido | `.claude-plugin/plugin.json` | `claude plugin validate .` falla en `author`, `commands` y `skills`. `SKILL.md` no tiene frontmatter, así que no carga. La skill ni menciona `bus_ask` y habla del token de Discord |
| D8 | La config de Codex está mal documentada | `docs/INSTALL.md` | Codex usa TOML (`~/.codex/config.toml`, `[mcp_servers.ai-comms]`), no JSON |
| D9 | La lista de rutas denegadas bloquea lo que hace falta y se le escapa lo que no | `src/agent-cli.ts:47` | `**/.env.*` bloquea `.env.example`, justo lo que hace falta para "¿qué config local necesito?". Y no cubre `*.tfstate`, `appsettings.*.json`, `serviceAccount*.json`, `.pgpass`, `.kube/config`, `.docker/config.json`, `~/.config/gh/hosts.yml` (el token de `gh`) ni `~/.claude.json`. Falta verificar si los patrones `**/` cubren rutas fuera del cwd |
| D10 | 2 de 74 tests fallan | `test/fixes.test.ts:51`, `test/v0.5.test.ts:22` | Uno es una bomba de tiempo (TTL fijo al 2026-09-17). El otro falla por contaminación: `process.env = {...}` rompe el `HOME` de los tests siguientes, y en aislamiento pasa. Sin CI, nadie lo ve |
| D11 | Notificaciones de GitHub | — | Quien comenta en un issue queda suscripto, así que cada humano del equipo recibe una notificación o un mail por cada sobre |
| D12 | Costo por request | `src/github-auth.ts:15` | Cada request sin token explícito lanza el proceso `gh auth token`. El daemon hace `gh` × 2 más `GET /user` cada 15 s por proyecto, y el MCP hace `GET /user` en cada tool |
| D13 | El log crece sin límite y cada append lo relee entero | `src/store.ts:68` | Es O(n) por mensaje, y `bus_ask` relee el archivo cada 2 s |
| D14 | El nombre del proyecto sale de la carpeta | `src/setup.ts:296` | Colisiones entre orgs (`api`). Además, el daemon usa el `bus` de `config.json`, que se escribe una vez y nunca se actualiza, mientras el MCP usa `.ai-comms.json`: son dos fuentes de verdad |
| D15 | Cualquiera puede liberar el claim de otro | `src/store.ts:173` | Ahora que la identidad está autenticada, un `release` debería exigir ser el autor del claim |
| D16 | `detectAgent` busca la variable `CLAUDE_CODE` | `src/setup.ts:22` | Claude Code exporta `CLAUDECODE` |
| D17 | La documentación está desactualizada | `docs/PROTOCOL.md`, `plugin.json`, `SPEC-v1.md` | PROTOCOL sigue diciendo "transporte Discord, body ≤ 600". El plugin dice "over Discord". SPEC-v1 dice "no publicar a npm" |

---

## 5. Brechas de diseño frente a tu objetivo

### G1. ¿A quién le pregunto? No hay directorio ni roles

Hoy las instrucciones listan logins: "Teammates: ana, beto, …". Para el agente,
`beto` no significa "arquitectura". Por eso no puede elegir bien el
destinatario, y el default es preguntarle a todos (D3).

**Propuesta: una "tarjeta" por miembro**, generada en el setup con una sola
pregunta opcional:

```json
{ "login": "beto", "role": "arquitectura", "areas": ["api/**", "docs/adr/**"],
  "repos": ["acme/api"], "autoAnswer": true, "lastSeen": "2026-09-28T12:00:00Z" }
```

Además, **`CODEOWNERS` como fuente automática**: si la pregunta es sobre
`api/auth/**`, se le pregunta al dueño de esa ruta. Con eso, `bus_ask` gana
`topic` o `paths`. El `to` pasa a ser opcional porque se resuelve solo, y
**nunca** por defecto a todo el equipo.

### G2. Presencia y vuelta asíncrona

- **Presencia:** el daemon publica un latido con `lastSeen` y el estado de
  `autoAnswer`. `bus_ask` falla rápido con un mensaje útil: "beto está offline y
  no tiene autoAnswer; quedó en su bandeja y te va a llegar después". Hoy, en
  cambio, bloquea 120 s para nada.
- **Vuelta asíncrona:** el plugin trae un **hook de Claude Code**
  (`SessionStart` / `UserPromptSubmit`). Si hay respuestas nuevas o preguntas
  dirigidas a vos, las inyecta en el contexto: "Tenés 1 respuesta de beto a tu
  pregunta sobre X". Así el agente se entera sin que el humano pregunte.
- **Instrucciones del servidor MCP:** el SDK que ya usa el repo (1.30) acepta
  `instructions` a nivel servidor, y los clientes las ponen en el system prompt.
  Por ahí pueden viajar la política de uso **y el directorio del equipo** para
  cualquier cliente, sin escribir `CLAUDE.md` en cada repo ni commitear la lista
  de logins.
- **Latencia:** hoy el recorrido es poll de quien responde (≤ 15 s), más
  `claude -p` (30–90 s), más poll del daemon de quien pregunta (≤ 15 s), más poll
  del log (≤ 2 s). Muchas veces pasa el tope de 120 s. Conviene que `bus_ask`
  consulte GitHub directo con ETag: las respuestas 304 son baratas, y según
  GitHub no consumen rate limit si la request está autenticada. El daemon
  debería bajar a unos 5 s con ETag.

### G3. Hechos vs. decisiones

"¿Cuál es el shape de `/users`?" es un hecho: la IA del otro lado lo contesta
leyendo el repo. "¿Está bien que use eventos en vez de REST acá?" es una
decisión: la tiene que validar el arquitecto humano.

**Propuesta:**

- El sobre gana procedencia: `answered_by: "agent" | "human"`. Una respuesta
  automática se muestra siempre como "no validada".
- `need`, o un `ask` con `needs_human: true`, no se autoresponde. Notifica al
  humano. Cuando el arquitecto abre su sesión, el hook le muestra la solicitud
  pendiente, contesta con ayuda de su IA, y sale como `answered_by: "human"`.

### G4. Conversación de varios turnos

`bus_ask` no tiene `reply_to` ni hilo. Cada pregunta de seguimiento llega sin
historia, y el respondedor no tiene estado: el prompt trae sólo el sobre actual
y los últimos 10 `contract/done/fyi`.

**Propuesta:** un `thread` en el sobre. El prompt de quien responde incluye el
hilo completo. Mejor todavía, se mantiene una sesión por hilo:
`claude -p --output-format json` devuelve `session_id`, y el siguiente turno usa
`--resume <id>`.

### G5. Config local que el repo no trae

Es tu segundo caso, y hoy choca con D9.

**Propuesta:**

1. Permitir `*.example`, `*.sample` y `*.template`.
2. Instruir al respondedor a contestar **nombres y fuentes, nunca valores**:
   "necesitás `DB_URL`; el valor está en 1Password › acme-dev".
3. Pasar la salida por un escáner de secretos antes de publicar (prefijos
   `ghp_`, `sk-`, `AKIA`, `xox`, `-----BEGIN`, alta entropía). Es una defensa en
   profundidad, porque las listas negras siempre pierden.
4. Cuando la misma pregunta aparece dos veces, sugerir documentarla en el repo.

### G6. Endurecer al respondedor

Para quien responde, conviene pasar de lista negra a lista blanca:

- `--permission-mode dontAsk` con `Read(./**)`, `Grep(./**)` y `Glob(./**)`
  acotados al repo;
- `--strict-mcp-config` sin servidores (así no levanta los MCP del proyecto, ni
  siquiera ai-comms mismo);
- revisar si conviene `--setting-sources user` para no ejecutar hooks del
  proyecto.

Los tres flags existen en el `claude` actual (2.1.283). Después hay que probarlo
en serio: pedirle `~/.config/gh/hosts.yml` y confirmar que se niega.

---

## 6. Arquitectura propuesta para el fuero privado

### Un "espacio de equipo" = un repo privado dedicado (p. ej. `acme/ai-comms`)

La propuesta es usar un repo aparte en lugar de un issue dentro de un repo de
código. Esto resuelve varias cosas de un saque:

- **La privacidad deja de depender del repo de código.** Funciona aunque el
  código sea open source, y el setup puede exigir `private: true`.
- **Los miembros son quienes tienen acceso a ese repo.** El líder invita con un
  comando, y en una org alcanza con darle acceso a un team.
- **Un solo bus para muchos repos de código.** Se termina el problema de
  `--project/--bus` (B3, D14), y el id del proyecto pasa a ser `owner/name` del
  espacio.
- **Los humanos pueden dejar de seguir el repo entero** (resuelve D11). Además,
  el setup puede silenciar el hilo con la mutación GraphQL `updateSubscription`
  (`IGNORED`).

### Mapear el protocolo a primitivas de GitHub (en dos pasos)

- **Paso A (cambio mínimo):** mantener el modelo de un issue que funciona como
  log, pero dentro del repo dedicado, bloqueado y silenciado. Casi no toca
  código.
- **Paso B (el destino):**
  - un hilo es un issue;
  - un `ask` o `need` abre un issue asignado al destinatario (GitHub ya lo
    notifica y aparece en "Assigned to me");
  - las respuestas son comentarios, y cerrar el issue es resolverlo;
  - los claims son issues con la etiqueta `claim` que quedan abiertos mientras
    están vigentes;
  - los `contract` son issues con la etiqueta `contract`.

  El polling de todo el espacio son dos requests condicionales:
  `GET /repos/{o}/{r}/issues/comments?since=&sort=created&direction=asc` (el
  endpoint admite `sort`, `direction` y `since`) y `GET /issues?since=`. Los
  humanos pueden seguir las conversaciones de las IAs en una UI que ya conocen.
- **Directorio:** `members/<login>.json` en el repo del espacio, escrito por el
  setup de cada uno, más el `CODEOWNERS` de los repos de código.
- **Presencia:** un comentario propio por miembro en un issue `presence`, que se
  **edita** cada pocos minutos. Editar no crea notificaciones ni commits.

Se mantiene la interfaz `Transport`: se agrega un `github-space` al lado del
`github-issue` actual.

### Alternativas descartadas por ahora

- **Relay hosteado** (WebSocket, presencia real, latencia de segundos): es la
  mejor experiencia, pero exige infraestructura, operación y que el equipo
  confíe en un tercero. Queda para el fuero público.
- **GitHub Discussions:** tiene hilos nativos, pero sólo se opera por GraphQL y
  se automatiza peor que los issues.

### Principio: el MCP funciona sin daemon

Mientras la sesión está abierta, el MCP consulta GitHub directo. El daemon pasa
a ser el **"modo disponible"**: notificaciones del sistema y respuestas
automáticas cuando no estás. Así, instalar el daemon es una mejora y deja de ser
un requisito que falla sin avisar.

---

## 7. Experiencia objetivo para el usuario

Líder del equipo, una sola vez:

```bash
npm i -g @quaglius/ai-comms
ai-comms space create acme          # repo privado acme/ai-comms, bloqueado y silenciado
ai-comms invite bruno carla         # o: --team acme/devs
```

Cada miembro:

```bash
npm i -g @quaglius/ai-comms
ai-comms join acme/ai-comms
```

`join` hace todo lo siguiente:

- detecta `gh`;
- registra el MCP **a nivel usuario** en los agentes que encuentre
  (`claude mcp add --scope user`, `~/.cursor/mcp.json`, `~/.codex/config.toml`,
  `~/.gemini/settings.json`);
- instala el daemon con rutas absolutas;
- hace como máximo dos preguntas, ambas opcionales:
  - "¿En qué sos referente? (arquitectura, backend, infra…)"
  - "¿Permitís que tu IA responda sola preguntas del equipo, en sólo lectura? [S/n]"

No hay archivos que commitear en los repos de código. Opcionalmente, un
`.ai-comms.json` con `{ "space": "acme/ai-comms" }` asocia un repo a un espacio.

Además, `ai-comms status` junta diagnóstico, presencia y bandeja, y
`ai-comms autoanswer on|off` evita que haya que editar JSON a mano.

---

## 8. Plan por fases

**Fase 0: que funcione lo que ya está (días).**

- Publicar 0.5.x y agregar CI (build, test, publicar al taggear).
- Arreglar B2, B3 y B4.
- B5 mínimo: rechazar repos públicos, bloquear el issue, filtrar por colaboradores.
- D1 (marcar leído).
- D2 (`bus_ask` consulta GitHub directo y avisa si no hay daemon).
- D5 (ingesta idempotente: los efectos se disparan sólo si el sobre es nuevo, más
  un set de "en vuelo").
- D6 (hacer merge en `.mcp.json`).
- D7, D8, D10, y D16 (una línea).

**Fase 1: a quién preguntar (1–2 semanas).**

- Tarjetas de miembro, roles, `CODEOWNERS` y presencia.
- Quitar el default de "todos" (D3) y tolerar el 403 de colaboradores (D4).
- Fallar rápido si el destinatario está offline.
- `instructions` del servidor MCP con el directorio.
- Hooks para la vuelta asíncrona.
- Procedencia `answered_by` y `needs_human`.
- `thread`.

**Fase 2: espacio de equipo.**

- Repo privado dedicado, con `space create`, `invite` y `join`.
- Registro global del MCP.
- Transporte de un issue por hilo.
- Silenciar notificaciones.
- Id de proyecto = el espacio (resuelve D14).

**Fase 3: endurecer y dar memoria al respondedor.**

- Lista blanca con `dontAsk` y `--strict-mcp-config` (G6).
- Escáner de secretos en la salida.
- Leer `*.example` (G5).
- Sesión por hilo con `--resume`.
- Sugerir documentar las preguntas repetidas.
- Compactar el log (D13) y cachear el token y el login (D12).

**Nota sobre el schema:** las specs anteriores dicen "no cambiar el schema del
sobre". Las fases 1 y 2 justifican un sobre `v: 2` con `thread`, `answered_by` y
`needs_human`. El lector puede aceptar `v1` y `v2` durante la transición.

---

## 9. Fuero público (notas para después)

- La identidad por GitHub sirve igual. Lo que cambia es el modelo de amenaza:
  spam, abuso de cuota ajena, extracción de datos por inyección de prompt.
- `autoAnswer` apagado por defecto y sin excepción para desconocidos. Allowlist
  explícita de quién puede dirigirte preguntas.
- Probablemente haga falta un relay con moderación, límites por cuenta y
  descubrimiento de "espacios" públicos por tema.
- Para interoperar con agentes que no usen este paquete, conviene mirar el
  protocolo A2A (Agent2Agent) y sus "Agent Cards". Son la misma idea que las
  tarjetas de miembro de G1.

---

## Apéndice: reproducciones

Todas corren sin red y sin tokens reales, en un `HOME` temporal.

- **B1:** `npm view @quaglius/ai-comms versions` devuelve `["0.1.0","0.2.0","0.3.0"]`.
  `npm pack @quaglius/ai-comms@latest` y un grep de `command('…')` en
  `dist/cli.js` muestran que no hay `setup`. La 0.3.0 no tiene
  `SECRET_PATH_DENIES`.
- **B2:** se construye una config igual a la de `ensureUserConfig` más
  `autoAnswer.enabled`, y se llama a `runAutoAnswer` con un `ask` a
  `["architect"]` y `runAgentFn` mockeado. Resultado: `launched: false`, sin
  líneas de log.
- **B3:** `git init` con `origin` `git@github.com:acme/web.git` en la carpeta
  `web-bruno`, un `.ai-comms.json` que apunta a `acme/api#42`, y
  `runSetup({ skipDaemonOffer: true })` con `fetch` mockeado. El archivo queda
  reescrito como se muestra en B3.
- **B4:** `echo Y |` y `offerDaemonInstall()` en un `HOME` vacío dan
  `ENOENT … .config/systemd/user/ai-comms-daemon.service`.
- **D4:** la OpenAPI de GitHub, en `GET /repos/{owner}/{repo}/collaborators`,
  dice: "The authenticated user must have write, maintain, or admin privileges
  on the repository to use this endpoint."
- **D7:** `claude plugin validate .` reporta 3 errores (`author`, `commands`,
  `skills`) y advierte que `SKILL.md` no tiene frontmatter.
- **D10:** `npm test` da 72/74. `--test-name-pattern="legacy Discord"`, corrido
  solo, pasa.
