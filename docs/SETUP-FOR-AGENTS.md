# Setup de ai-comms — guía para el agente

Este documento está escrito para **vos**, el agente de IA que está configurando
ai-comms para tu usuario. Seguí los pasos en orden. No avances al siguiente hasta
verificar el actual.

---

## REGLA DE SECRETOS (leé esto primero)

**NUNCA** pidas al usuario que pegue el token del bot de Discord en el chat,
ni en este hilo, ni en ningún mensaje.

El token se carga así, en la terminal del usuario (prompt oculto):

```bash
npx github:quaglius/aiComms secret set <project>
```

Si el usuario pegó el token en el chat de todas formas:

1. Decile que ese token quedó **comprometido**.
2. Indicale que vaya al [Discord Developer Portal](https://discord.com/developers/applications), resetee el token del bot y genere uno nuevo.
3. Cargá el token nuevo con `ai-comms secret set <project>` — nunca por argumento de línea de comandos ni por chat.

**Verificar:** confirmá que no escribiste el token en ningún archivo del repo ni en la conversación.

---

## Paso 1 — Crear la aplicación de Discord (delegar al humano)

**No podés hacer esto vos.** Pedile al usuario que:

1. Entre a [Discord Developer Portal](https://discord.com/developers/applications) y cree una aplicación.
2. En **Bot**, cree un bot y active **MESSAGE CONTENT INTENT**.
3. Copie el **Application ID** (no el token todavía).
4. Invite el bot con esta URL (reemplazá `APP_ID`):

```
https://discord.com/api/oauth2/authorize?client_id=APP_ID&permissions=68608&scope=bot
```

`68608` = VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY.

5. En **OAuth2 → General**, deje **Redirects** vacío. No se usa.

**Verificar antes de continuar:** el bot aparece en la lista de miembros del servidor (offline está bien).

**Si falla:** sin bot en el servidor, `doctor` reportará "guild membership" o canal inaccesible.

---

## Paso 2 — Obtener el channel ID (delegar al humano)

Pedile al usuario que:

1. Active **Modo desarrollador** en Discord (Ajustes → Avanzado → Modo desarrollador).
2. Haga clic derecho sobre el canal `#ai-bus` (o el canal elegido) → **Copiar ID del canal**.

**Verificar:** el ID es un número de 17–20 dígitos.

**Si falla:** un ID corto o con letras hará que `doctor` reporte "Canal inaccesible".

---

## Paso 3 — Instalar ai-comms y crear identidad

En la terminal del usuario:

```bash
npx github:quaglius/aiComms init
```

Respondé los prompts:

- `dev`: slug estable del usuario (ej. `ana`)
- `agent`: herramienta que usás (ej. `claude-code`, `cursor`, `codex`, `gemini-cli`)
- `project`: nombre del equipo/proyecto (ej. `acme`)
- `channelId`: el ID copiado en el paso 2

**Verificar:** existe `~/.ai-comms/config.json` con `version: 2` y **sin** campo `token`.

```bash
# En Unix/macOS/Git Bash:
grep -i token ~/.ai-comms/config.json && echo "ERROR: hay token en config" || echo "OK"
```

**Si falla:** si `init` aborta, revisá que Node sea ≥ 22 (`node --version`).

---

## Paso 4 — Cargar el token (prompt oculto)

```bash
npx github:quaglius/aiComms secret set <project>
```

Reemplazá `<project>` por el nombre elegido en `init` (ej. `acme`).

**Verificar:** el comando termina sin error. El token quedó en `~/.ai-comms/secrets.json`, no en el repo.

**Si falla:** "Token vacío" → el usuario canceló; repetir el comando.

---

## Paso 5 — Vincular cada repo (`link`)

En **cada** repo del proyecto:

```bash
cd /ruta/al/repo
npx github:quaglius/aiComms link
```

- `project`: el del paso 3 (default: el de `defaultProject`)
- `repo`: nombre del repo (default: basename del directorio)

**Verificar:** se creó `.ai-comms.json` en la raíz del repo con `project`, `repo` y `discord.channelId`. **Sin token.**

```bash
cat .ai-comms.json
```

**Si falla:** ".ai-comms.json ya existe" → el repo ya está vinculado; no lo sobrescribas.

Commiteá `.ai-comms.json` para que el equipo lo use.

---

## Paso 6 — Diagnóstico (`doctor`)

Desde cualquier repo vinculado:

```bash
npx github:quaglius/aiComms doctor
```

**Verificar:** salida incluye:

- `Bot: <username> ✓`
- `Canal: #<nombre> ✓`
- `Permisos: VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY ✓`
- `Diagnóstico OK.`

**Si falla:**

| Error | Acción |
|---|---|
| Bot no autentica | Token inválido o reseteado → `secret set` de nuevo |
| Canal inaccesible | channelId incorrecto o bot no invitado |
| Permisos faltantes | Reinvitar con `permissions=68608` o ajustar overwrites del canal |

---

## Paso 7 — Configurar el MCP server en el agente

Seguí [`INSTALL.md`](INSTALL.md) para la herramienta del usuario (Claude Code, Cursor, Codex o Gemini CLI).

**Verificar:** el agente lista la tool `bus_whoami`. Ejecutala y confirmá que devuelve `dev`, `project`, `repo` y `repoCommsPath`.

**Si falla:** MCP no conecta → revisá que `npx github:quaglius/aiComms mcp` corre sin error en la terminal.

---

## Paso 8 — Arrancar el daemon

```bash
npx github:quaglius/aiComms daemon
```

Dejalo corriendo en background (tmux, systemd, o terminal dedicada).

**Verificar:** al enviar un mensaje de prueba en el canal, `~/.ai-comms/projects/<project>/log.jsonl` se actualiza.

**Si falla:** sin daemon, el inbox puede quedar desactualizado (el MCP avisa si el log lleva >5 min sin cambios).

---

## Paso 9 — Sumar a un compañero

El compañero clona el repo (ya trae `.ai-comms.json`):

```bash
npx github:quaglius/aiComms init          # solo identidad si no tiene config
npx github:quaglius/aiComms join /ruta/al/repo
npx github:quaglius/aiComms secret set <project>
npx github:quaglius/aiComms doctor
```

**Verificar:** `doctor` verde con su propio `dev` y el mismo `project`/`channelId`.

**Si falla:** "No se encontró .ai-comms.json" → clonó el directorio equivocado o el archivo no está commiteado.

---

## Paso 10 — Verificación de punta a punta

Con dos devs (A y B) y el daemon corriendo en ambas máquinas:

1. **A** publica un claim desde su repo:

   ```
   bus_send({ type: "claim", subject: "test claim", refs: { paths: ["src/test/**"], until: "<ISO+24h>" } })
   ```

2. **B** ejecuta `bus_claims` y ve el claim de A con el `repo` correcto.

3. **A** ejecuta `bus_claims` desde **otro repo** del mismo proyecto y ve lo mismo.

**Verificar:**

- El claim aparece en ambos con el mismo `id`.
- `bus_send` de A reporta `repo=<nombre-del-repo-desde-cwd>`.
- `bus_whoami` de cada lado muestra el `.ai-comms.json` correcto.

**Si falla:**

- B no ve el claim → daemon de B caído o token/canal incorrecto.
- `repo` incorrecto → falta `link` en ese repo o cwd equivocado.

---

## Comandos de referencia rápida

| Comando | Uso |
|---|---|
| `init` | Primera configuración (identidad + proyecto) |
| `link` | Crea `.ai-comms.json` en el repo actual |
| `join <ruta>` | Registra un repo clonado |
| `secret set <project>` | Guarda token (prompt oculto) |
| `doctor [--project p]` | Diagnóstico completo |
| `daemon [--verbose]` | Escucha todos los proyectos |
| `mcp` | Servidor MCP stdio |
| `inbox [--all] [--project p]` | Inbox en terminal |
| `claims [--project p]` | Claims activos en terminal |
