import { PSession, PSessionCollection, PSessionStoreMethod, PSessionStoreFunctions, clearOldSessions } from './session'
import { PUtils, PLogger } from 'pols-utils'
import { validate, rules } from 'pols-validator'
import { PResponse, PFileInfo, PResponseBody } from './response'
import { PRequest } from './request'
import express from 'express'
import bodyParser from 'body-parser'
import expressFileupload from 'express-fileupload'
import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import socketIo from 'socket.io'
import { PLoggerLogParams, PLoggerParams } from 'pols-utils/dist/plogger'

export { PQuickResponse } from './quickResponse'
export { PResponse, PRequest }

export type PWebSocketClientEvents = Record<string, (params: { clientSocket: socketIo.Socket, session: PSession, data: unknown[] }) => void>

export type PWebServerLoggerParams = Omit<PLoggerParams, 'logPath' | 'showInConsole'> & {
	request?: PRequest
}

export type PWebServerParams = {
	instances: {
		http?: {
			port: number
		}
		https?: {
			port: number
			cert: string
			key: string
		}
		webSocket?: {
			urlPath?: string
			connectionEvent?: (clientSocket: socketIo.Socket, session: PSession) => void
			events?: PWebSocketClientEvents
		}
	}
	showErrorsOnClient?: boolean
	defaultRoute?: string
	oldFilesInUploadsFolder?: {
		minutesExpiration: number
	}
	sizeRequest?: number
	paths: {
		routes: string
		uploads: string
	}
	baseUrl?: string
	remap?: {
		from: string | RegExp
		to: string
	}[]
	public?: {
		path: string
		urlPath: string
	},
	sessions: {
		minutesExpiration: number
		sameSiteCookie?: 'strict' | 'lax' | 'none'
		secretKey: string
	} & ({
		storeMethod: PSessionStoreMethod.files
		path: string
		pretty?: boolean
	} | {
		storeMethod: PSessionStoreMethod.memory | PSessionStoreFunctions & {
			deleteOldBodies?: (minutesExpiration: number) => Promise<void>
		}
	})
	logger?: PLogger,
}

export class PRoute {
	readonly server: PWebServer
	readonly request: PRequest
	readonly session: PSession
	whiteList: string[] = []
	blackList: string[] = []
	declare finally: () => Promise<void>

	constructor(server: PWebServer, request: PRequest, session: PSession) {
		this.server = server
		this.request = request
		this.session = session
	}
}

/* Send body */
const responseToClient = (response: PResponse, res: express.Response) => {
	if (response.status) res.status(response.status)
	if (!response.cacheControl) {
		res.set('Cache-Control', 'no-store')
		// res.set('ETag', Math.random().toString())
	}
	if (response.headers) {
		for (const headerName in response.headers) {
			res.set(headerName, response.headers[headerName])
		}
	}
	if (response.cookies.length) {
		for (const cookie of response.cookies) {
			res.cookie(cookie.name, cookie.value, { httpOnly: cookie.httpOnly, sameSite: cookie.sameSite })
		}
	}

	const body = response.body

	if (typeof body == 'object' && 'on' in body && 'read' in body && 'pipe' in body) {
		const bytes = []
		body.on('data', (chunk) => {
			bytes.push(chunk)
		})
		body.on('end', () => {
			res.send(Buffer.concat(bytes))
		})
	} else {
		res.send(body ?? '')
	}
}

const socketConnectionEvent = (webServer: PWebServer, clientSocket: socketIo.Socket, events: PWebSocketClientEvents) => {
	webServer.logger.system({ label: 'WEB SOCKET', description: `Cliente conectado` })
	const config = webServer.config
	const request = new PRequest(clientSocket.request as any)
	const session = new PSession({
		ip: clientSocket.handshake.address,
		hs: request.cookies?.hs,
		hostname: request.headers.host,
		userAgent: request.headers['user-agent'] ?? '',
		minutesExpiration: config.sessions.minutesExpiration,
		sessions: webServer.sessions,
		storeMethod: config.sessions.storeMethod,
		pretty: 'pretty' in config.sessions ? config.sessions.pretty : null,
		storePath: config.sessions.storeMethod == PSessionStoreMethod.files ? config.sessions.path : undefined,
		secretKey: config.sessions.secretKey
	})
	webServer.config.instances.webSocket.connectionEvent?.(clientSocket, session)
	if (events) {
		for (const eventName in events) {
			clientSocket.on(eventName, (...args: unknown[]) => {
				events[eventName]({ clientSocket, session, data: args })
			})
		}
	}
}

const loadRouteClass = async (webServer: PWebServer, ...filePath: string[]): Promise<typeof PRoute> => {
	const config = webServer.config
	const codePath = require.resolve(path.resolve(config.paths.routes, ...filePath))

	if (!fs.existsSync(codePath)) throw new Error(`No existe el archivo de ruta '${codePath}'`)

	let RouteClass: any
	try {
		RouteClass = require(codePath)
	} catch (err) {
		throw new Error(`Error al intentar importar la ruta '${codePath}'.\n${err.stack}`)
	}
	if (!(RouteClass?.default?.prototype instanceof PRoute)) throw new Error(`La ruta '${codePath}' debe entregar una clase heredada de 'Route'`)

	return RouteClass.default
}

const notFound = async (webServer: PWebServer, type: 'script' | 'function', pathToRoute: string, functionName: string, request: PRequest, session: PSession) => {
	const config = webServer.config
	const response = new PResponse({
		body: `No se encontró la ruta`,
		status: 404
	})
	let notFoundEventResponse: PResponse
	try {
		notFoundEventResponse = await webServer.onNotFound?.({ type: 'script', request, session }) as PResponse
		if (!notFoundEventResponse) {
			if (type == 'script') {
				webServer.log.error({ label: 'ERROR', description: `No se encontró la ruta '${pathToRoute}'` }, request)
			} else {
				webServer.log.error({ label: 'ERROR', description: `No se encontró la función '${functionName}' en '${pathToRoute}'` }, request)
			}
		}
	} catch (err) {
		const subtitle = `Error al ejecutar el evento 'notFound'`
		webServer.log.error({ label: 'ERROR', description: subtitle, body: err }, request)
		notFoundEventResponse = new PResponse({
			body: subtitle,
			status: 500
		})
	}
	return notFoundEventResponse ?? response
}

const detectRoute = async (webServer: PWebServer, req: express.Request): Promise<PResponse> => {
	const config = webServer.config
	const request = new PRequest(req)
	const session = new PSession({
		ip: request.ip,
		hs: request.cookies?.hs,
		hostname: request.hostname,
		userAgent: request.headers['user-agent'] ?? '',
		minutesExpiration: config.sessions.minutesExpiration,
		sessions: webServer.sessions,
		storeMethod: config.sessions.storeMethod,
		pretty: 'pretty' in config.sessions ? config.sessions.pretty : null,
		storePath: config.sessions.storeMethod == PSessionStoreMethod.files ? config.sessions.path : undefined,
		secretKey: config.sessions.secretKey
	})
	await session.start()

	/* Detiene la llamada en caso el protocolo sea diferente */
	const httpsWebServerPort = config.instances.https?.port
	if (request.protocol == 'http' && httpsWebServerPort) {
		return new PResponse({ redirect: `https://${request.hostname}:${httpsWebServerPort}/${request.pathUrl}${request.queryUrl}` })
	}

	webServer.log.system({ label: '>>> REQUEST' }, request)

	/* Ejecuta el evento, el cual puede responder con un objeto Response y con ello detener el proceso */
	if (webServer.onRequestReceived) {
		let response: PResponse | void
		try {
			response = await webServer.onRequestReceived({ request, session })
		} catch (err) {
			const message = `Ocurrió un error al ejecutar el evento 'requestReceived'`
			webServer.log.error({ label: 'EVENTS', description: message, body: err }, request)
			return new PResponse({
				body: message,
				status: 503
			})
		}
		if (response) return response
	}

	const response: PResponse = await (async (): Promise<PResponse> => {
		const parameters = []

		/* Se extrae el path, en caso no lo tenga, se utiliza el path por defecto establecido en la configuración */
		let requestPathUrl = webServer.config.baseUrl ? request.pathUrl.replace(new RegExp('^' + webServer.config.baseUrl + '(\\/|$)'), '') : request.pathUrl
		if (config.remap && requestPathUrl) {
			for (const r of config.remap) {
				const requestPathUrlResult = requestPathUrl.replace(r.from, r.to)
				if (requestPathUrl != requestPathUrlResult) {
					requestPathUrl = requestPathUrlResult
					request.remap = requestPathUrlResult
					break
				}
			}
		}
		const pathUrl = requestPathUrl || (config.defaultRoute ?? '')

		/* Se valida si el pathUrl apunta a un archivo en public */
		if (config.public) {
			let pathUrlCopy = pathUrl
			if (config.public.urlPath && request.pathUrl.match(new RegExp('^' + config.public.urlPath))) {
				pathUrlCopy = request.pathUrl.replace(new RegExp('^' + config.public.urlPath), '')
			}
			const publicFilePath = path.join(config.public.path, pathUrlCopy)
			if (PUtils.Files.existsFile(publicFilePath)) {
				return new PResponse({
					body: new PFileInfo({ filePath: publicFilePath }),
					status: 200
				})
			}
		}

		/* Se descompone el path */
		const pathParts = pathUrl.split('/').filter(part => !['.', '..'].includes(part))

		/* Se obtiene la ruta solicitada por el usuario y se descompone para ubicar la función a ejecutar. */
		const pathToRouteArray = [config.paths.routes]
		const relativePathToRouteArray: string[] = []

		/* Recorre en cada parte de la ruta y busca el objeto de la ruta. De no encontrarlo, responderá con un 404 */
		let i = 0
		let routeObject: PRoute
		let part = pathParts[i]
		let pathToRoute = ''
		while (!routeObject) {
			pathToRoute = path.join(...pathToRouteArray, part)

			const elementExists = fs.existsSync(pathToRoute)
			if (elementExists) {
				/* Si el elemento existe, se evalúa si se trata de un directorio, si no lo es, se responde con error 404 */
				const statsInfo = fs.statSync(pathToRoute)
				if (statsInfo.isDirectory) {
					pathToRouteArray.push(part)
					relativePathToRouteArray.push(part)
					i++
					part = pathParts[i]
					if (part == null) part = 'index'
					continue
				} else {
					return await notFound(this, 'script', pathToRoute, '', request, session)
				}
			} else {
				/* Si el elemento no existe, se evalúa si existe como archivo aagregándole las extensiones correspondientes */
				const javascriptFileExists = fs.existsSync(`${pathToRoute}.js`)
				const typescriptFileExists = fs.existsSync(`${pathToRoute}.ts`)
				let ext = ''
				if (javascriptFileExists) {
					ext = '.js'
				} else if (typescriptFileExists) {
					ext = '.ts'
				}

				if (ext) {
					pathToRoute += ext
					pathToRouteArray.push(part + ext)
					relativePathToRouteArray.push(part + ext)
					i++
				} else {
					if (part != 'index') {
						i--
						part = 'index'
						continue
					} else {
						return await notFound(this, 'script', pathToRoute, '', request, session)
					}
				}
			}

			try {
				const routeClass = await loadRouteClass(this, pathToRoute)
				routeObject = new routeClass(this, request, session)
			} catch (err) {
				const description = `Error al importar la ruta '${relativePathToRouteArray.join(' / ')}'`
				webServer.log.error({ label: 'ERROR', description, body: err }, request)
				return new PResponse({
					body: config.showErrorsOnClient ? `${description}${err ? `\n\n${err.message}\n${err.stack}` : ''}` : 'Error en el servidor',
					status: 500
				})
			}
		}

		/* Busca el nombre de la función */
		let functionName = ''
		while (!functionName) {
			const part = pathParts[i]
			if (typeof routeObject[request.method + '$' + part] == 'function') {
				functionName = request.method + '$' + part
				i++
			} else if (typeof routeObject['$' + part] == 'function') {
				functionName = '$' + part
				i++
			} else if (typeof routeObject['$index'] == 'function') {
				/* Si no se ha encontrado la función indicada en la URL, se buscará la función $index, de existir, se invocará automáticamente a ésta, dejando a 'part' con el rol de parámetro */
				functionName = '$index'
			} else {
				return await notFound(this, 'function', pathToRoute, functionName, request, session)
			}
		}

		/* Busca los parámetros */
		while (i < pathParts.length) {
			const part = pathParts[i]
			parameters.push(decodeURIComponent(part).trim())
			i++
		}

		const toExecute = routeObject[functionName]

		if (toExecute == null) return new PResponse({
			body: `'${functionName}' no existe como método de ruta`,
			status: 404
		})

		if (typeof toExecute != 'function' || toExecute.constructor.name != 'AsyncFunction') return new PResponse({
			body: `'${functionName}' no es una función válida de ruta`,
			status: 500
		})

		/* Verifica si la librería tiene definida una lista blanca de IPs */
		if (routeObject.whiteList.length && !routeObject.whiteList.includes(request.ip)) return new PResponse({
			body: `Acceso prohibido al IP '${request.ip}'`,
			status: 401
		})

		/* Verifica si la librería tiene definida una lista blanca de IPs */
		if (routeObject.blackList.length && routeObject.blackList.includes(request.ip)) return new PResponse({
			body: `Acceso prohibido al IP '${request.ip}'`,
			status: 401
		})

		/* Ejecuta el evento antes de llamar a la función */
		try {
			const response = await webServer.onBeforeExecute?.({ route: routeObject, request, session })
			if (response) return response
		} catch (err) {
			const subtitle = `Ocurrió un error en la ejecución del evento 'beforeExecute'`
			webServer.log.error({ label: 'ERROR', description: subtitle, body: err }, request)
			return new PResponse({
				body: subtitle,
				status: 500
			})
		}

		let result: unknown
		try {
			result = await toExecute.apply(routeObject, parameters)
		} catch (err) {
			const description = `Ocurrió un error en la ejecución de la función '${functionName}'`
			webServer.log.error({ label: 'ERROR', description, body: err }, request)
			result = new PResponse({
				body: config.showErrorsOnClient ? `${description}${err ? `\n\n${err.message}\n${err.stack}` : ''}` : 'Error en el servidor',
				status: 500
			})
		} finally {
			/* Ejecuta el método finally de la ruta */
			try {
				await routeObject.finally?.()
			} catch (err) {
				const subtitle = `Ocurrió un error en la ejecución del método 'finally'`
				webServer.log.error({ label: 'ERROR', description: subtitle, body: err }, request)
				result = new PResponse({
					body: subtitle,
					status: 500
				})
			}
		}

		/* Devuelve la respuesta de la función */
		if (result instanceof PResponse) {
			return result
		} else {
			return new PResponse({
				body: result as PResponseBody,
				status: 200
			})
		}
	})()

	webServer.log.system({ label: 'RESPONSE >>>' }, request)
	response.cookies.push({
		name: 'hs',
		value: session.encriptedId,
		httpOnly: true,
		sameSite: config.sessions?.sameSiteCookie,
	})
	return response
}

const deleteOldFiles = async (webServer: PWebServer) => {
	/* Elimina sesiones antiguas */
	const config = webServer.config
	await clearOldSessions({
		storeMethod: config.sessions.storeMethod,
		minutesExpiration: config.sessions.minutesExpiration,
		storePath: (config.sessions.storeMethod == PSessionStoreMethod.files && 'path' in config.sessions) ? config.sessions.path : null,
		sessionCollection: webServer.sessions,
		deleteOldBodies: (typeof config.sessions.storeMethod == 'object' && 'deleteOldBodies' in config.sessions.storeMethod) ? config.sessions.storeMethod.deleteOldBodies : null,
	})

	/* Elimina archivos subidos antiguos */
	if (config.oldFilesInUploadsFolder?.minutesExpiration && PUtils.Files.existsDirectory(webServer.paths.uploads)) {
		const files = fs.readdirSync(webServer.paths.uploads)
		const expirationTime = new Date
		expirationTime.setMinutes(expirationTime.getMinutes() - config.oldFilesInUploadsFolder.minutesExpiration)
		for (const file of files) {
			if (['.', '..'].includes(file)) continue
			const filePath = path.join(webServer.paths.uploads, file)
			const stats = fs.statSync(filePath)
			if (!stats.isFile()) continue
			if (stats.ctime < expirationTime && stats.size > 0) {
				try {
					fs.unlinkSync(filePath)
					webServer.logger.info({ label: 'FILE DELETED', description: file })
				} catch (err) {
					webServer.logger.error({ label: 'ERROR', description: `Error al intentar borrar el archivo "${file}"`, body: err })
				}
			}
		}
	}
}

const logger = (params: PLoggerLogParams, method?: (params: PLoggerLogParams) => void, request?: PRequest) => {
	const tags = [...(params.tags ?? [])]
	if (request) tags.push(request.ip, request.pathUrl)
	method?.({
		...params,
		tags
	})
}

export class PWebServer {
	config: Readonly<PWebServerParams>
	private oldFilesDeleterInterval?: ReturnType<typeof setInterval>
	public sessions: PSessionCollection = {}
	readonly paths: {
		readonly routes: string
		readonly sessions?: string
		readonly uploads?: string
		readonly public?: string
	}
	private app?: express.Express
	private server?: http.Server
	public webSocket?: socketIo.Server
	private serverTls?: https.Server

	declare onRequestReceived: ({ request, session }: { request: PRequest, session: PSession }) => Promise<PResponse | void>
	declare onNotFound: ({ type, request, session }: { type: 'script' | 'function', request: PRequest, session: PSession }) => Promise<PResponse | void>
	declare onBeforeExecute: ({ route, request, session }: { route: PRoute, request: PRequest, session: PSession }) => Promise<PResponse | void>

	get logger() {
		return this.config.logger
	}

	get log() {
		return {
			info: (params: PLoggerLogParams, request: PRequest) => logger(params, this.logger?.info, request),
			warning: (params: PLoggerLogParams, request: PRequest) => logger(params, this.logger?.warning, request),
			error: (params: PLoggerLogParams, request: PRequest) => logger(params, this.logger?.info, request),
			debug: (params: PLoggerLogParams, request: PRequest) => logger(params, this.logger?.info, request),
			system: (params: PLoggerLogParams, request: PRequest) => logger(params, this.logger?.info, request),
		}
	}

	constructor(config: PWebServerParams) {
		/* Valida los parámetros de la configuración */
		const v = validate<PWebServerParams>(config, rules({ required: true }).isObject({
			paths: rules({ required: true }).isObject({
				logs: rules({ default: './' }).isAlphanumeric(),
				routes: rules({ required: true }).isAlphanumeric(),
				uploads: rules({ default: './' }).isAlphanumeric()
			}, 'paths >'),
			sizeRequest: rules({ default: 50 }).isNumber().gt(0)
		}))
		if (v.error == true) throw new Error(v.messages[0])
		config.paths = v.result.paths

		/* Valida la existencia de definición de una instancia */
		if (!config.instances.http && !config.instances.https) {
			throw new Error(`Es requerido especificar la configuración de las instancias de servicio web en 'instances.http' o 'instances.https'`)
		}

		/* Valida el contenido de la ruta por defecto */
		if (config.defaultRoute && config.defaultRoute.match(/^(\/|\\)/)) throw new Error(`La propiedad de configuración 'defaultRoute' no debe iniciar con '\\' o '/'`)

		/* Valida la configuración de las sesiones */
		if (config.sessions.storeMethod == PSessionStoreMethod.files) {
			if (!config.sessions.path) throw new Error(`Se debe indicar una ruta válida para almacenar las sesiones en 'sessions.path' cuando 'sessions.store' es igual a 'files'`)
		}
		if (config.sessions.minutesExpiration < 0) throw new Error(`La propiedad 'sessions.minutesExpiration' debe ser mayor o igual a cero`)

		/* Valida las propiedades para public */
		if (config.public) {
			if (!config.public.path.trim()) throw new Error(`Se debe indicar una ruta válida en 'public.filePath'`)
			if (config.public.urlPath.match(/^\//)) throw new Error(`La propiedad 'public.urlPath' no puede iniciar con '/'`)
		}

		this.config = config
		this.paths = {
			routes: config.paths.routes,
			sessions: config.sessions.storeMethod == PSessionStoreMethod.files ? config.sessions.path : undefined,
			uploads: config.paths.uploads,
			public: config.public?.path,
		}

		/* Define el comportamiento de la APP, según la configuración entregada */
		this.app = express()
		const app = this.app

		app.disable('x-powered-by')

		app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
			if (!this.config.baseUrl) return next()
			if (req.path.match(new RegExp('^\\/' + this.config.baseUrl + '(\\/|$)'))) {
				next()
			} else {
				responseToClient(new PResponse({
					status: 404,
					body: 'No se encontró la ruta'
				}), res)
			}
		})

		/* Body-parser */
		app.use((req, res, next) => {
			bodyParser.json({ limit: config.sizeRequest + 'mb' })(req, res, error => {
				if (error instanceof SyntaxError) {
					responseToClient(new PResponse({
						status: 400,
						body: 'Formato JSON incorrecto'
					}), res)
				} else {
					next(error)
				}
			})
		})
		app.use(bodyParser.raw({ limit: config.sizeRequest + 'mb' }))
		app.use(bodyParser.text({ limit: config.sizeRequest + 'mb' }))
		app.use(bodyParser.urlencoded({ limit: config.sizeRequest + 'mb', extended: true }))

		app.use(async (req: express.Request, res: express.Response, next: () => void) => {
			try {
				if (!fs.existsSync(config.paths.uploads)) fs.mkdirSync(config.paths.uploads)
				next()
			} catch (err) {
				this.logger.error({ label: 'WEB SERVER', description: `Ocurrió un error al intentar crear la carpeta de recepción de archivos '${config.paths.uploads}'`, body: err })
				responseToClient(new PResponse({
					body: 'Ocurrió un error al intentar crear la carpeta de recepción de archivos',
					status: 500
				}), res)
			}
		})

		/* express-fileupload */
		app.use(expressFileupload({
			limits: {
				fileSize: config.sizeRequest * 1024 * 1024,
				fieldSize: config.sizeRequest * 1024 * 1024,
			},
			useTempFiles: true,
			tempFileDir: config.paths.uploads
		}))

		app.use((req, res, next) => {
			const contentLength = parseInt(req.headers['content-length'], 10)

			if (contentLength > config.sizeRequest * 1024 * 1024) {
				responseToClient(new PResponse({
					body: 'La petición supera el límite establecido',
					status: 500
				}), res)
			} else {
				next()
			}
		})

		/* Carga de la ruta dinámica */
		app.use(async (req: express.Request, res: express.Response) => {
			let response: PResponse
			try {
				response = await detectRoute(this, req)
			} catch (error) {
				this.logger.error({ label: 'ERROR', description: `Ocurrió un error en la ejecución del evento 'beforeExecute'`, body: error })
				response = new PResponse({
					body: 'Error en el servidor',
					status: 500
				})
			}
			responseToClient(response, res)
		})

		if (config.instances.http) {
			this.server = http.createServer(this.app)
		}
		if (config.instances.https) {
			this.serverTls = https.createServer({
				cert: config.instances.https.cert,
				key: config.instances.https.key,
			}, this.app)
		}

		if (config.instances.webSocket) {
			const serverInstance = this.serverTls ?? this.server
			const webSocketConfig = config.instances.webSocket
			this.webSocket = new socketIo.Server(serverInstance, {
				path: webSocketConfig.urlPath ? `/${webSocketConfig.urlPath.replace(/^\/|\/$/g, '')}/` : undefined
			})
			this.webSocket.on('connection', (client: socketIo.Socket) => {
				socketConnectionEvent(this, client, webSocketConfig.events)
			})
		}
	}

	start() {
		if (this.server?.listening || this.serverTls?.listening) throw new Error(`El servicio ya ha sido inicializado`)
		const config = this.config

		if (config.instances.http) {
			this.server.listen(config.instances.http.port, () => {
				this.logger.system({ label: 'WEB SERVER', description: `Escuchando en el puerto ${config.instances.http.port} con protocolo HTTP` })
			})
		}

		if (config.instances.https) {
			this.serverTls.listen(config.instances.https.port, () => {
				this.logger.system({ label: 'WEB SERVER', description: `Escuchando en el puerto ${config.instances.https.port} con protocolo HTTPS` })
			})
		}

		this.oldFilesDeleterInterval = setInterval(() => deleteOldFiles(this), 2000 * 60)
		deleteOldFiles(this)
	}

	stop() {
		clearInterval(this.oldFilesDeleterInterval)
		this.server?.close(() => {
			this.logger.system({ label: 'WEB SERVER', description: `Servicio HTTP detenido` })
		})
		this.serverTls?.close(() => {
			this.logger.system({ label: 'WEB SERVER', description: `Servicio HTTP detenido` })
		})
	}
}