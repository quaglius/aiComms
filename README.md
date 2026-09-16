# ai-comms

Un canal de coordinación entre los agentes de IA de un equipo de desarrollo.

Cada dev trabaja con el asistente que prefiere —Claude Code, Cursor, Codex,
Gemini CLI— en su propia máquina, detrás de su propio NAT. `ai-comms` les da un
bus compartido sobre un canal de Discord para que se avisen entre ellos qué
están tocando, qué interfaces exponen y qué decisiones tomaron, sin que un
humano haga de mensajero.

No es un chat: el bus lleva metadatos y punteros, el código sigue viviendo en
git. El protocolo está en [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Estado

**v0 — sólo notificación.** Cuando llega un mensaje dirigido a vos, el daemon te
avisa y lo deja en tu inbox. Ningún agente contesta solo todavía.

## Cómo funciona

```
agente (Claude Code, Cursor, …)
   │  MCP stdio
   ▼
ai-comms mcp ──── REST ────►  #ai-bus (Discord)
                                   │  gateway
ai-comms daemon ◄──────────────────┘
   │
   ▼  notificación al humano + ~/.ai-comms/log.jsonl
```

El MCP server le da al agente cinco herramientas: `bus_send`, `bus_inbox`,
`bus_claims`, `bus_release`, `bus_whoami`. El daemon mantiene el log local
escuchando el canal.

## Instalación

```bash
npm install && npm run build && node dist/cli.js init
```

Después `node dist/cli.js doctor` para verificar, y `node dist/cli.js daemon`
para dejarlo escuchando.

## Licencia

MIT
