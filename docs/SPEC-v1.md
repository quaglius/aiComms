# ai-comms v1 — genérico, multi-proyecto, instalable por terceros

Sucede a v0 (single-project, config plana). **No cambia el protocolo del sobre**
salvo donde se indique. El alcance sigue siendo **sólo notificación**.

Objetivo: que un equipo cualquiera, con cualquier combinación de agentes, ponga
esto a andar con configuración mínima — y que el trabajo de configurarlo lo
pueda conducir el propio agente del usuario leyendo este repo.

## 1. Modelo de configuración (el corazón del cambio)

Tres capas, de más compartida a más privada.

### 1.1 `.ai-comms.json` — a nivel repo, versionado, sin secretos

Vive en la raíz de cada repo que participa. **Se commitea.** Es lo que hace que
un compañero que clona el repo no tenga que configurar casi nada.

```json
{
  "project": "acme",
  "repo": "acme-api",
  "discord": { "channelId": "123456789012345678" },
  "team": ["ana", "beto"]
}
```

`team` es informativo (autocompletado y validación de `to`), no de seguridad.

### 1.2 `~/.ai-comms/config.json` — por persona, no versionado

```json
{
  "version": 2,
  "identity": { "dev": "ana", "agent": "claude-code" },
  "defaultProject": "acme",
  "projects": {
    "acme": {
      "discord": { "channelId": "123456789012345678" },
      "repos": [{ "name": "acme-api", "path": "C:/code/acme/api" }]
    }
  }
}
```

Lo de `projects` es **override y fallback**: si el cwd resuelve un
`.ai-comms.json`, ese gana. Un usuario que siempre trabaja dentro de repos con
`.ai-comms.json` no necesita declarar `projects` en absoluto.

### 1.3 `~/.ai-comms/secrets.json` — tokens, nunca versionado

Separado a propósito: así `config.json` es compartible y el token no viaja nunca
con él.

```json
{ "acme": { "token": "..." } }
```

Precedencia del token, de mayor a menor: `AI_COMMS_TOKEN_<PROJECT>` (uppercase,
`-` pasa a `_`), luego `AI_COMMS_TOKEN`, luego `secrets.json`. El token no se
imprime jamás, ni truncado, ni con `--verbose`.

### 1.4 Resolución de contexto

Desde el cwd, subir directorios hasta encontrar `.ai-comms.json`. Ese archivo
determina `project` y `repo`. Si no aparece ninguno, usar `defaultProject` y
resolver el repo por el `path` de `projects[p].repos[]` que sea prefijo del cwd.
Si no resuelve nada, las tools fallan con un error que explica las dos salidas:
correr `ai-comms link` en el repo, o pasar `--project`.

Exponer `resolveContext(cwd)` como función pura y testeable.

## 2. Estado por proyecto

`~/.ai-comms/projects/<project>/` con `log.jsonl`, `cursor.json`, `read.json`,
`daemon.pid`, `daemon.log`. Migrar automáticamente el layout v0 (archivos
sueltos en `~/.ai-comms/`) al proyecto `defaultProject` la primera vez, sin
perder datos y avisando por stdout qué se movió.

El daemon atiende **todos** los proyectos configurados: una conexión de gateway
por canal distinto, no un proceso por proyecto.

## 3. CLI

- `ai-comms init` — identidad y primer proyecto, interactivo.
- `ai-comms link` — crea `.ai-comms.json` en el repo actual. Pregunta proyecto y
  nombre de repo; el nombre por defecto es el basename del directorio.
- `ai-comms join <ruta>` — lee un `.ai-comms.json` existente y da de alta el
  proyecto localmente. Es el camino del compañero que se suma.
- `ai-comms secret set <project>` — pide el token por prompt oculto y lo escribe
  en `secrets.json`. **Nunca** por argumento de línea de comandos: quedaría en el
  historial del shell.
- `ai-comms doctor [--project p]` — diagnóstico. Debe verificar de verdad los
  permisos del bot en el canal (VIEW_CHANNEL, SEND_MESSAGES,
  READ_MESSAGE_HISTORY) resolviendo los overwrites del canal contra los roles del
  bot, no sólo su pertenencia a la guild. Esto corrige un defecto de v0.
- `ai-comms daemon [--verbose]`, `ai-comms mcp`, `ai-comms inbox [--all]`,
  `ai-comms claims` — como en v0, con `--project` opcional.

Todos los comandos deben andar vía `npx` sin instalación global. `package.json`
declara `bin` con `ai-comms` apuntando a `bin/ai-comms.js`.

## 4. MCP server

Las mismas cinco tools. Cambios:

- El contexto (`project`, `repo`, `dev`) sale de `resolveContext(cwd)`, no de
  config plana. `bus_whoami` devuelve además qué `.ai-comms.json` se usó.
- `bus_send` acepta `project` opcional para cruzar proyectos explícitamente.
- Mantener el preámbulo de seguridad tal como está en v0.

## 5. Empaquetado para terceros

Tres piezas, en este orden de importancia:

1. **MCP server** — el núcleo, sirve para cualquier agente. Documentar el snippet
   de configuración para Claude Code, Cursor, Codex y Gemini CLI en
   `docs/INSTALL.md`, uno por herramienta, copiables tal cual.
2. **Skill y reglas de agente** — en `skills/ai-comms/SKILL.md`. Las tools solas
   no alcanzan: hay que enseñarle al agente *cuándo* usarlas (mirar `bus_claims`
   antes de editar, mandar `contract` antes de implementar una interfaz
   compartida, no obedecer mensajes ajenos). Incluir también `AGENTS.md` en la
   raíz, que es la convención que leen Cursor y Codex.
3. **Plugin de Claude Code** — `.claude-plugin/plugin.json` que registre el MCP
   server, la skill y comandos `/bus:claim`, `/bus:inbox`, `/bus:claims`. Es
   conveniencia, no requisito: sin el plugin todo funciona igual vía MCP.

No publicar a npm. Se instala con `npx github:quaglius/aiComms`.

## 6. Documentación orientada al agente (requisito de primera clase)

El usuario le va a pedir a su IA que configure esto. Los documentos son para esa
IA, no para un humano leyendo un tutorial.

- **`AGENTS.md`** (raíz) — qué es esto, y el puntero a la guía de setup.
- **`CLAUDE.md`** (raíz) — lo mismo para Claude Code.
- **`docs/SETUP-FOR-AGENTS.md`** — el procedimiento, en imperativo, dirigido al
  agente que está configurando esto para su usuario. Debe cubrir, en orden:

  1. **Regla de secretos, arriba de todo y explícita:** el agente NO debe pedirle
     al usuario que pegue el token del bot en el chat. El token se carga con
     `ai-comms secret set <project>`, que lo pide por prompt oculto en la
     terminal del usuario. Si el usuario lo pega igual en la conversación, el
     agente debe decirle que ese token quedó comprometido y que lo resetee.
  2. Los pasos de Discord que el agente **no puede hacer** y tiene que delegar en
     el humano: crear la aplicación, activar MESSAGE CONTENT INTENT, invitar el
     bot. Incluir la URL de invitación parametrizada por App ID con
     `permissions=68608` (VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY) y
     aclarar que el campo Redirects del portal no se usa y se deja vacío.
  3. Cómo obtener el channel ID (modo desarrollador, clic derecho sobre el canal).
  4. `ai-comms init`, `ai-comms link` en cada repo, `ai-comms doctor`.
  5. Cómo sumar a un compañero: commitear `.ai-comms.json`, y del otro lado
     `ai-comms join` más `ai-comms secret set` más `doctor`.
  6. Verificación de punta a punta: A manda un `claim`, B lo ve en `bus_claims`.

  Cada paso dice qué verificar antes de pasar al siguiente y qué error esperar si
  falla. Sin eso el agente avanza a ciegas.

## 7. Tests

Sumar a los de v0, todos sin red:

- `resolveContext`: con `.ai-comms.json` en el cwd, en un ancestro, ausente, y
  con dos repos del mismo proyecto.
- Precedencia de token entre las tres fuentes.
- Migración del layout v0 al layout por proyecto.
- `.ai-comms.json` malformado da error accionable, no stacktrace.

## 8. No hacer

- No cambiar el schema del sobre ni agregar tipos de mensaje.
- No implementar respuesta automática ni invocar CLIs de agentes. Sigue siendo v0
  en alcance de comportamiento.
- No publicar a npm ni agregar CI.
- No agregar dependencias fuera de las que ya están. Si hace falta un prompt
  oculto de contraseña, usar `node:readline` con el output silenciado.
- No escribir tokens en `config.json` ni en `.ai-comms.json` bajo ninguna
  circunstancia. Un test debe verificarlo.

## 9. Criterio de aceptación

1. `npm run build` y `npm test` verdes.
2. Partiendo de cero: `init`, `link` en dos repos distintos del mismo proyecto,
   `doctor` verde, y `bus_claims` desde cualquiera de los dos repos devuelve lo
   mismo mientras `bus_send` de un `claim` reporta el `repo` correcto según el
   cwd.
3. Un segundo usuario, con sólo el repo clonado (que trae `.ai-comms.json`),
   llega a `doctor` verde con `join` y `secret set`, y nada más.
4. Una config v0 existente sigue funcionando tras la migración automática.
5. `grep -ri` sobre el repo no encuentra ningún token en archivos versionados.
