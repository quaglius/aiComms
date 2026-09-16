# Instalación del MCP server

ai-comms se instala con `npx` sin publicación en npm:

```bash
npx github:quaglius/aiComms <comando>
```

Requisitos: Node ≥ 22.

Setup completo (Discord, token, repos): [`SETUP-FOR-AGENTS.md`](SETUP-FOR-AGENTS.md).

---

## Claude Code

Agregá al archivo de configuración MCP del proyecto o global:

```json
{
  "mcpServers": {
    "ai-comms": {
      "command": "npx",
      "args": ["github:quaglius/aiComms", "mcp"]
    }
  }
}
```

O instalá el plugin desde este repo (`.claude-plugin/plugin.json`), que registra
el MCP, la skill y los comandos `/bus:claim`, `/bus:inbox`, `/bus:claims`.

---

## Cursor

En **Cursor Settings → MCP**, agregá un servidor:

```json
{
  "mcpServers": {
    "ai-comms": {
      "command": "npx",
      "args": ["github:quaglius/aiComms", "mcp"]
    }
  }
}
```

O en `.cursor/mcp.json` del proyecto:

```json
{
  "mcpServers": {
    "ai-comms": {
      "command": "npx",
      "args": ["github:quaglius/aiComms", "mcp"]
    }
  }
}
```

Cursor también lee [`AGENTS.md`](../AGENTS.md) en la raíz del repo.

---

## Codex (OpenAI)

En la configuración MCP de Codex:

```json
{
  "mcpServers": {
    "ai-comms": {
      "command": "npx",
      "args": ["github:quaglius/aiComms", "mcp"]
    }
  }
}
```

Codex lee [`AGENTS.md`](../AGENTS.md) en la raíz del repo.

---

## Gemini CLI

En `~/.gemini/settings.json` o la config MCP del proyecto:

```json
{
  "mcpServers": {
    "ai-comms": {
      "command": "npx",
      "args": ["github:quaglius/aiComms", "mcp"]
    }
  }
}
```

---

## Verificar que funciona

1. Abrí el proyecto desde un repo con `.ai-comms.json`.
2. Ejecutá la tool `bus_whoami`.
3. Debe devolver `dev`, `project`, `repo`, `channelId` y `repoCommsPath` sin token.

Si falla, corré `npx github:quaglius/aiComms doctor` en la terminal.

---

## Tools disponibles

| Tool | Descripción |
|---|---|
| `bus_send` | Publica un sobre (`project` opcional para cruzar proyectos) |
| `bus_inbox` | Sobres vigentes dirigidos a vos |
| `bus_claims` | Claims activos del equipo |
| `bus_release` | Libera un claim |
| `bus_whoami` | Identidad y contexto resuelto |
