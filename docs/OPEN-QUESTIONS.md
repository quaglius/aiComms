# Preguntas abiertas

## v1

### Proyecto sin repos en `projects` y sin `.ai-comms.json`

Si el cwd no tiene `.ai-comms.json` y `projects[p].repos` está vacío, v1 usa el
basename del cwd como nombre de repo y el `channelId` del proyecto. Esto permite
`doctor` y MCP sin `link`, pero es menos explícito. Preferí siempre `link`.

### Daemon con múltiples tokens

Si dos proyectos usan tokens distintos, el daemon abre un cliente gateway por
token. Si comparten token, un solo cliente escucha todos los canales.

---

# Preguntas abiertas (protocolo v0)

Interpretaciones conservadoras aplicadas. No modifican el schema del sobre.

## 1. «Ignorar sobres propios» en el daemon

**Protocolo/spec:** paso 3 del daemon — `from.dev === config.dev`.

**Interpretación:** no se re-persisten ni se notifican (el envío vía MCP ya
appendea al log). Sí se avanza `cursor.json` para no reprocesar el mensaje.

## 2. Notificación con sonido

**Spec:** «Los `fyi` broadcast notifican sin sonido; `need` y `ask` dirigidos
notifican con sonido.»

**Interpretación:** sonido sólo si `type ∈ {need, ask}`, `to` incluye el `dev`
local y `to` no incluye `*`. Un `need`/`ask` con `to: ["*"]` notifica sin
sonido.

## 3. Truncado cuando el JSON del sobre supera 1900 chars

**Spec:** truncar `body` hasta que el mensaje entre en 1900 chars.

**Interpretación:** si con `body` vacío el mensaje sigue excediendo el límite
(p. ej. muchos `refs.paths`), se usa JSON compacto y, en último caso, se corta
el contenido renderizado. Ese corte puede dejar un bloque ```json inválido para
parseo inverso. Caso extremo; en uso normal alcanza con truncar `body`.

## 4. Detección de daemon caído (`bus_inbox`)

**Spec:** log sin escrituras > 5 min y daemon no corre.

**Interpretación:** se usa `daemon.pid` + `process.kill(pid, 0)` y `mtime` de
`log.jsonl`. Falso positivo si el bus está quieto pero el daemon vivo; falso
negativo si el pidfile quedó stale.
