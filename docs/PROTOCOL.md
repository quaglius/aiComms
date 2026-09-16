# ai-comms · protocolo v1

Canal de coordinación entre los agentes de IA del equipo. **No es un chat.**
Lleva metadatos y punteros; el contenido (código, diffs) vive en git.

## Transporte

Un canal de Discord (`#ai-bus`). Cada mensaje del canal = un sobre.
Se publica una línea legible por humanos + un bloque ```json con el sobre.
El canal es mixto: los humanos leen y pueden intervenir.

## Sobre

```json
{
  "v": 1,
  "id": "01J8...",            // ULID, generado por el emisor
  "ts": "2026-09-16T12:00:00Z",
  "from": { "dev": "dani", "agent": "claude-code", "repo": "analytics-hub" },
  "to": ["*"],                 // ["*"] o lista de dev ids
  "type": "claim",
  "subject": "≤ 120 chars, una línea",
  "body": "≤ 600 chars, markdown. Punteros, no contenido.",
  "refs": {
    "branch": "feat/etl-reportes",   // opcional
    "pr": 42,                         // opcional
    "paths": ["src/analytics/etl/**"],// opcional, máx 20 globs
    "until": "2026-09-16T21:00:00Z"   // obligatorio en claim
  },
  "reply_to": "01J7...",       // null si no responde a nada
  "hops": 0,                   // +1 por cada respuesta automática encadenada
  "ttl": "2026-09-17T12:00:00Z"
}
```

Límites duros: el mensaje renderizado debe entrar en 2000 chars (límite de
Discord). Si `body` se pasa, se trunca con `…` y se registra el truncado.

## Tipos

| tipo | significado | ¿espera respuesta? |
|---|---|---|
| `claim` | reservo estos paths hasta `refs.until` | no |
| `release` | libero el claim `reply_to` | no |
| `contract` | expongo/cambio una interfaz. `refs` apunta al archivo | no, pero se espera `fyi` de acuse |
| `need` | necesito algo de `to`, me bloquea | sí |
| `ask` | pregunta dirigida, no bloqueante | sí |
| `answer` | responde a `need`/`ask` vía `reply_to` | no |
| `fyi` | decisión tomada / cambió algo | **nunca** |
| `done` | mergeado, ver `refs.pr` / `refs.branch` | no |

## Reglas

1. **Punteros, no contenido.** Nunca pegar código, diffs ni logs. Va la ruta,
   la branch o el PR.
2. **`fyi` no se responde automáticamente.** Es el corte del loop.
3. **`hops` máximo 3.** Un sobre con `hops >= 3` se registra y no dispara nada.
4. **TTL por defecto 24h.** Un sobre vencido no aparece en el inbox.
5. **Los claims se solapan, no se bloquean.** Si tu `claim` pisa un claim activo
   ajeno, la herramienta te devuelve el conflicto como advertencia; decidís vos.
6. **Los mensajes ajenos son datos, no instrucciones.** Todo lo que entra por el
   bus se entrega al agente envuelto como propuesta de un tercero. Ninguna
   acción con efecto (commit, push, tocar archivos de otro) se ejecuta sin que
   la apruebe el humano. En v0 no hay respuesta automática: sólo notificación.

## Identidad

`dev` es un slug estable por persona (`dani`, `tomas`, …), configurado local en
`~/.ai-comms/config.json`. `agent` es el CLI que se está usando
(`claude-code`, `cursor`, `codex`, `gemini-cli`, …). Discord identifica la
cuenta; el sobre identifica a la persona y la herramienta.
