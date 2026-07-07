# pols-webserver

Un wrapper de **Express** para Node.js y TypeScript que proporciona enrutamiento automático basado en el sistema de archivos (Filesystem-based Routing). Diseñado para evitar el registro manual de rutas y estructurar tu API de forma limpia e intuitiva mediante clases de ruta.

---

## Características Principales

* 🚀 **Enrutamiento Automático**: No necesitas registrar rutas manualmente. Las carpetas y archivos en tu directorio de rutas definen tus endpoints de forma dinámica.
* 📦 **Clases de Ruta (`PRoute`)**: Estructura cada endpoint mediante clases orientadas a objetos, con soporte para métodos HTTP específicos (`get$`, `post$`, `put$`, `delete$`, etc.).
* 🔄 **Hot-Reloading integrado**: Permite la recarga en caliente de tus rutas en desarrollo sin reiniciar el proceso de Node.js.
* 🛡️ **Sesiones Flexibles**: Soporte nativo para sesiones persistentes en archivos, memoria o mediante funciones de almacenamiento personalizadas.
* 📂 **Subida de Archivos Integrada**: Configuración directa de límites y almacenamiento temporal de archivos.
* 🪵 **Logger Centralizado (`PLogger`)**: Registro y formateo de logs del sistema de forma nativa.

---

## Instalación

```bash
npm install pols-webserver
```

Asegúrate de tener instaladas las dependencias del ecosistema `pols` (como `pols-logger` y `pols-utils`) que tu proyecto requiera.

---

## Inicio Rápido

### 1. Inicialización del Servidor (`app.ts` o `index.ts`)

Configura e inicia el servidor web:

```typescript
import { PWebServer, PLogger } from 'pols-webserver'
import { PSessionStoreMethod } from 'pols-webserver/session'
import path from 'path'

const server = new PWebServer({
	instances: {
		http: {
			port: 6001
		}
	},
	hotReloading: process.env.NODE_ENV !== 'production', // Recarga de rutas automática en desarrollo
	paths: {
		routes: path.join(__dirname, './routes'),
		uploads: path.join(__dirname, './uploads')
	},
	sessions: {
		minutesExpiration: 15,
		storeMethod: PSessionStoreMethod.files,
		path: path.join(__dirname, './sessions'),
		pretty: true,
		secretKey: 'tu_clave_secreta'
	},
	logger: new PLogger()
})

server.start()
```

### 2. Creación de una Ruta (`routes/usuarios.ts`)

Crea un archivo dentro de la carpeta especificada en `paths.routes`. Cada archivo debe exportar por defecto una clase que herede de `PRoute`:

```typescript
import { PRoute, PResponse } from 'pols-webserver'

export default class extends PRoute {
	// Mapea a: GET /usuarios
	async $index() {
		return 'Lista de usuarios'
	}

	// Mapea a: GET /usuarios/detalle
	async get$detalle() {
		return { id: 1, nombre: 'Jean Paul' }
	}

	// Mapea a: POST /usuarios/guardar
	async post$guardar() {
		const datos = this.request.body
		// Guardar en base de datos...
		return new PResponse({
			status: 201,
			body: { mensaje: 'Usuario creado exitosamente' }
		})
	}
}
```

---

## Convenciones de Enrutamiento

El wrapper escanea el directorio de rutas y mapea las peticiones de la siguiente manera:

1. **Rutas basadas en Archivos**: 
   * La URL `/usuarios` buscará el archivo `routes/usuarios.ts` o `routes/usuarios/index.ts`.
2. **Métodos y Verbos HTTP**:
   * Las funciones dentro de la clase de ruta que inicien con un verbo HTTP y el signo `$` (ej: `get$detalle`, `post$guardar`) responderán únicamente a ese método HTTP.
   * Las funciones que inicien directamente con `$` (ej: `$index` o `$info`) son genéricas y responderán a cualquier método HTTP (GET, POST, etc.).
3. **Parámetros de URL Dinámicos**:
   * Cualquier parte extra de la URL que no coincida con un archivo o método se pasará automáticamente como parámetro a la función de enrutamiento.
   * Ejemplo: `/usuarios/detalle/42` llamará a la función `get$detalle('42')` en el archivo `routes/usuarios.ts`.

---

## Opciones de Configuración

El constructor de `PWebServer` recibe un objeto de tipo `PWebServerParams`:

| Propiedad | Tipo | Descripción |
| :--- | :--- | :--- |
| `instances` | `object` | Configuración de protocolos HTTP, HTTPS (con `cert` y `key`) y WebSocket. |
| `paths` | `object` | Rutas físicas del sistema para `routes` (controladores) y `uploads` (archivos temporales). |
| `sessions` | `object` | Configuración de expiración, claves y método de almacenamiento (`memory`, `files` o funciones custom). |
| `logger` | `PLogger` | Instancia del logger para registrar eventos del servidor. |
| `hotReloading` | `boolean` | (Opcional, default: `false`) Borra la caché de `require` en desarrollo para recargar controladores en caliente. |
| `sizeRequest` | `number` | (Opcional, default: `50`) Límite en Megabytes (MB) para el tamaño de las peticiones. |
| `baseUrl` | `string` | (Opcional) Prefijo base para todas las rutas de la aplicación. |
| `public` | `object` | (Opcional) Sirve archivos estáticos especificando la ruta local (`path`) y el prefijo de URL (`urlPath`). |
| `defaultRoute` | `string` | (Opcional) Ruta por defecto a la que redirigir si no se especifica ninguna en la URL base. |
| `showErrorsOnClient` | `boolean` | (Opcional) Si es `true`, envía el stack trace del error de ejecución de ruta al cliente. |

---

## Acceso Directo a la Instancia de Express

La propiedad `expressInstance` de la clase `PWebServer` es pública y permite acceder de forma directa a la instancia interna de Express. Esto es útil si necesitas registrar middlewares de terceros (como `cors` o `helmet`) o declarar rutas manuales específicas:

```typescript
const server = new PWebServer({ ... })

// Acceso directo a la instancia de Express
server.expressInstance.use(cors())
server.expressInstance.get('/ruta-manual', (req, res) => {
	res.send('Respuesta directa sin enrutamiento automático')
})

server.start()
```

---

## Uso de PLogger

El paquete exporta `PLogger` para que puedas configurar el sistema de logs sin necesidad de instalar dependencias adicionales de registro:

```typescript
import { PLogger } from 'pols-webserver'

const logger = new PLogger({
	// Opciones de configuración del logger
})
```

---

## Licencia

Este proyecto está bajo la licencia [ISC](LICENSE).
