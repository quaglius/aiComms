# ai-comms v0.5 — GitHub como bus, identidad autenticada, canales opcionales

Refactorización mayor. Sucede a v0.4. Cambia el modelo de identidad y el
transporte por defecto; el protocolo de mensajes se conserva.

## 0. El principio que ordena todo

**La identidad la provee el transporte, nunca el contenido del mensaje.**

Hasta v0.4 el `from.dev` del sobre lo escribía quien mandaba, y el lector le
creía. Cualquiera con el token del bot podía publicar como otro. A partir de
v0.5 el lector **descarta** el `from` del payload y lo reemplaza por el autor
que autenticó el transporte. Un `from` falso en el JSON no engaña a nadie
porque nadie lo lee.

Corolario: el usuario no configura quién es. Si hay que escribirlo en un
archivo, no es identidad.

## 1. GitHub como transporte por defecto

El bus es **un issue de GitHub**; cada comentario es un sobre.

- Historial completo y paginado por API. Mejor que Discord, sin topes de 100.
- Privacidad = la del repo. Repo privado, bus privado.
- Permisos = los colaboradores del repo. Sin lista que mantener.
- Identidad = el autor del comentario, autenticado por GitHub.
- **Sin bot, sin token que repartir, sin portal de desarrolladores.**

### 1.1 Autenticación

Por orden: `gh auth token` (el CLI que casi todos ya tienen autenticado), luego
`GITHUB_TOKEN` del entorno. Nada se guarda en `secrets.json`: el token es de la
persona, no del equipo, y ya lo administra `gh`.

Si no hay ninguno de los dos, el error dice exactamente `gh auth login`.

Con el token se habla REST directo por `fetch`. No lanzar `gh` por cada llamada.

### 1.2 Dónde vive el bus

En `.ai-comms.json`, versionado:

```json
{
  "project": "acme",
  "repo": "acme-api",
  "bus": { "kind": "github", "repo": "acme/acme-api", "issue": 42 }
}
```

`bus.repo` puede ser otro repo del que lo declara: un proyecto que abarca varios
repos —o varios forges— apunta todos al mismo issue. Ese issue es el canal.

### 1.3 Lectura

Polling de `GET /repos/{owner}/{repo}/issues/{n}/comments?since=<ISO>` cada 15 s,
con `ETag`/`If-None-Match` para no gastar cuota con respuestas 304. El límite
autenticado es 5000/hora; a 15 s son 240.

Por cada comentario: parsear el bloque ```json. **Sobrescribir `from.dev` con
`comment.user.login`** antes de validar. Si el payload declaraba otro, anotarlo
en `daemon.log` — es señal de un cliente roto o de alguien probando.

### 1.4 Escritura

`POST /repos/{owner}/{repo}/issues/{n}/comments`. El render es el mismo de
siempre (línea legible + bloque json), con el presupuesto subido: GitHub admite
65536 caracteres por comentario, así que el `body` del sobre pasa de 600 a 4000.
Eso resuelve el truncado que nos cortó respuestas a la mitad.

## 2. Los canales de chat pasan a ser notificadores opcionales

Discord y Telegram dejan de ser transporte. Sólo avisan al humano.

- No llevan sobres, llevan una línea legible.
- No se leen nunca: el bus es GitHub.
- Discord sólo necesita un **webhook entrante** (Configuración del canal →
  Integraciones → Webhooks → copiar URL). Sin bot, sin intents, sin OAuth.

```json
"notifiers": [{ "kind": "discord-webhook", "urlRef": "secrets:acme.discordWebhook" }]
```

La URL del webhook va a `secrets.json`, no a `.ai-comms.json`.

Si no hay notificadores, la notificación del sistema operativo sigue siendo el
aviso por defecto, como hasta ahora.

## 3. Transporte enchufable

Una interfaz, dos implementaciones. Nada fuera de `transports/` puede saber de
GitHub ni de Discord.

```ts
interface Transport {
  send(envelope: Envelope): Promise<{ id: string }>;
  fetchSince(cursor: string | null): Promise<{ envelopes: Envelope[]; cursor: string }>;
  whoami(): Promise<{ dev: string }>;   // identidad autenticada
  describe(): string;                    // para doctor
}
```

`kind: "discord"` se conserva funcionando tal como está en v0.4, para no romper
a quien ya lo tenga andando. En Discord `whoami()` devuelve la identidad
configurada y **advierte que no está autenticada**; `doctor` lo dice en claro.

## 4. Setup: un comando

`ai-comms setup`, corrido dentro de un repo, sin argumentos:

1. Lee el remoto de git → `owner/repo` y el nombre del repo. No pregunta.
2. `gh auth token` → tu login → **tu identidad**. No pregunta.
3. Busca un issue abierto con la etiqueta `ai-comms-bus` en el repo. Si no hay,
   ofrece crearlo (título `ai-comms bus`, cuerpo explicando qué es, cerrado a
   comentarios de nadie más no hace falta: el repo ya limita quién comenta).
4. Escribe `.ai-comms.json`, `.mcp.json` pinneado y el bloque de instrucciones.
5. Ofrece instalar el daemon al inicio del sistema (Windows: carpeta de inicio;
   macOS: launchd; Linux: systemd --user). Sin pedir que nadie escriba un `.vbs`.
6. Corre `doctor` y muestra el resultado.

Preguntas al usuario: **ninguna obligatoria**. Todo tiene un default derivado.

`ai-comms join` deja de existir: clonar el repo y correr `ai-comms setup` hace
lo mismo, y detecta que el `.ai-comms.json` ya existe.

## 5. El equipo sale del repo

`to` se valida contra los colaboradores del repo
(`GET /repos/{o}/{r}/collaborators`), cacheado 1 hora. Se acabó el `team` a mano
en `.ai-comms.json` — otro dato configurable que no debería serlo. El campo se
acepta si está, pero se ignora.

## 6. Migración

Una config v2 con `discord` sigue funcionando sin tocar nada. `doctor` informa
que el transporte no autentica identidad y sugiere `ai-comms setup` para migrar
a GitHub. No romper a nadie: v0.4 quedó publicada y en uso.

## 7. Auto-answer

Sin cambios de comportamiento, salvo que el presupuesto de respuesta sube de 500
a 3500 caracteres por el límite mayor de GitHub. Las denegaciones de rutas
secretas y el resto de los cortes quedan exactamente como están.

## 8. Tests

Sin red, con el cliente HTTP mockeado:

- Un comentario cuyo payload declara un `from.dev` distinto del autor de GitHub
  se lee con el autor real, y queda registrado el intento.
- Paginación de comentarios y avance de cursor.
- Un 304 no produce sobres ni mueve el cursor.
- Falta de `gh auth token` y de `GITHUB_TOKEN` da un error accionable.
- El notificador de Discord recibe una línea, nunca un sobre.
- Una config v2 de Discord sigue resolviendo contexto y enviando.

## 9. No hacer

- No agregar tipos de mensaje ni cambiar el schema del sobre.
- No guardar el token de GitHub en `secrets.json`: se pide a `gh` cada vez.
- No leer de los notificadores. Son de una sola dirección.
- No romper la configuración de Discord existente.
- No agregar dependencias: `fetch` nativo alcanza para GitHub.

## 10. Criterio de aceptación

1. `npm run build` y `npm test` verdes.
2. En un repo con `gh` autenticado, `ai-comms setup` sin argumentos y sin
   responder nada deja `doctor` en verde.
3. Un sobre con un `from.dev` falsificado en el JSON se lee con el login real.
4. Un usuario de v0.4 con Discord sigue funcionando sin tocar su config.
5. `grep -ri` no encuentra tokens en archivos versionados.
