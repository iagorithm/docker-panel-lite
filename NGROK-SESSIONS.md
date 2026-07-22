# Ngrok Sessions

`scripts/ngrok-sessions.sh` permite inspeccionar y limpiar los procesos ngrok
administrados por los workers de Docker Panel Lite.

El script nunca lee ni imprime los authtokens. Solo consulta los archivos de
estado locales y comprueba que cada PID corresponda realmente a un proceso
ngrok antes de intentar detenerlo.

## Dónde se ejecuta ngrok

El panel web no ejecuta los túneles. El worker seleccionado para un proyecto
inicia un proceso `ngrok http` por cada endpoint público.

- Los proyectos Dockerfile normalmente crean un proceso ngrok.
- Los proyectos Docker Compose pueden crear un proceso por servicio público.
- Cada proceso se autentica con el token configurado para el proyecto o, si no
  existe uno, con el token predeterminado del worker.
- Los archivos de seguimiento se guardan en `$APP_DATA_DIR/ngrok`, normalmente
  `/app/data/ngrok` dentro del contenedor.

## Consultar sesiones

Worker Python, utilizado de forma predeterminada:

```bash
./scripts/ngrok-sessions.sh
```

Worker Go:

```bash
./scripts/ngrok-sessions.sh --service worker-go
```

Ambos workers:

```bash
./scripts/ngrok-sessions.sh --all
```

La salida incluye:

- `STATE`: `live` si el PID existe y ejecuta ngrok; `stale` si solo queda el
  archivo de estado.
- `PID`: identificador del proceso dentro del contenedor del worker.
- `PROJECT / ENDPOINT`: proyecto y, para Compose, servicio asociado.
- `TARGET`: dirección interna a la que ngrok reenvía el tráfico.
- `URL`: URL pública publicada por ngrok.
- `Total`, `Active` y `Stale`: resumen de archivos y procesos encontrados.

Ejemplo:

```text
worker:
  STATE   PID     PROJECT / ENDPOINT                         TARGET
  live    145     microservices                              http://192.168.215.3:8080
          URL: https://example.ngrok-free.app
  stale   302     example-stack--api                         http://host.docker.internal:3000
  Total: 2 | Active: 1 | Stale: 1
```

Un estado `stale` no consume una sesión de ngrok: representa un archivo local
de un proceso que ya no está activo.

## Limpiar sesiones

La forma preferida de cerrar un túnel es usar **Close Public URL** desde el
panel. Esto detiene el proceso y también actualiza los valores guardados en la
base de datos.

Para detener todos los procesos ngrok registrados y eliminar todos sus
archivos `.json` y `.log` locales:

```bash
./scripts/ngrok-sessions.sh --clean
```

Para limpiar ambos workers:

```bash
./scripts/ngrok-sessions.sh --all --clean
```

La limpieza solicita escribir `CLEAN` antes de continuar. Para una ejecución
automatizada sin confirmación interactiva:

```bash
./scripts/ngrok-sessions.sh --all --clean --yes
```

Durante la limpieza, el script:

1. Lee los PID registrados en los archivos de estado.
2. Verifica `/proc/<pid>/cmdline` para evitar detener un proceso que no sea
   ngrok si el sistema reutilizó el PID.
3. Envía una terminación normal a los procesos ngrok activos.
4. Espera hasta cinco segundos.
5. Fuerza la terminación de los procesos que no respondieron.
6. Elimina todos los archivos `.json` y `.log`, incluidos los estados `stale`.
7. Vuelve a listar las sesiones para mostrar el resultado.

## Qué no limpia

La opción `--clean` solo actúa dentro de los contenedores de worker locales.
No elimina:

- Las URLs públicas guardadas en la base de datos del panel.
- Sesiones ngrok iniciadas desde otra computadora o worker.
- Agentes pertenecientes a otra instalación.

Después de una limpieza forzada, usa **Close Public URL** en el panel si todavía
aparecen URLs antiguas. Revisa también
[ngrok Agents](https://dashboard.ngrok.com/agents) para detener sesiones
ejecutadas fuera de estos workers.

## Variables y opciones

El script acepta las siguientes opciones:

| Opción | Descripción |
| --- | --- |
| `--service worker` | Consulta o limpia el worker Python. Es el valor predeterminado. |
| `--service worker-go` | Consulta o limpia el worker Go. |
| `--all` | Procesa ambos workers cuando están activos. |
| `--clean` | Detiene procesos ngrok y elimina archivos de estado y logs. |
| `--yes` | Omite la confirmación de `--clean`. |
| `--help` | Muestra la ayuda breve. |

También reconoce:

- `COMPOSE_FILE`: ruta de un archivo Compose alternativo.
- `ENV_FILE`: ruta del archivo de variables utilizado por Docker Compose.

Ejemplo:

```bash
COMPOSE_FILE=./docker-compose.yaml ENV_FILE=./.env \
  ./scripts/ngrok-sessions.sh --all
```

## Errores comunes

### El worker aparece como `not running`

Inicia el servicio correspondiente antes de consultar o limpiar:

```bash
docker compose up -d worker
```

### `ERR_NGROK_108`

La cuenta asociada al token alcanzó su límite de agentes simultáneos. Ejecuta
el script para encontrar procesos locales, cierra los que no necesites y revisa
también [ngrok Agents](https://dashboard.ngrok.com/agents).

Un token no es una sesión. El token autentica una cuenta; cada proceso ngrok
iniciado por el worker crea una sesión de agente y consume el límite de esa
cuenta.

### La limpieza termina pero el panel todavía muestra una URL

La URL continúa almacenada en la base de datos. Usa **Close Public URL** en el
proyecto para actualizar el estado persistido. La URL ya no funcionará si su
proceso ngrok fue detenido.

