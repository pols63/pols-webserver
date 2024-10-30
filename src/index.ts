import { Session, SessionCollection, SessionBody, StoreMethod } from './session'
import { PUtils, PLogger } from 'pols-utils'
import { WebServerResponse, FileInfo, ResponseBody } from './response'
import { PRequest } from './request'
import express from 'express'
import bodyParser from 'body-parser'
import expressFileupload from 'express-fileupload'
import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import socketIo from 'socket.io'
import { PLoggerParams } from 'pols-utils/dist/plogger'

export type PWebServerEvents = {
	requestReceived?(request: PRequest, session: Session): Promise<WebServerResponse | void>
	notFound?(type: 'script' | 'function', request: PRequest, session: Session): Promise<WebServerResponse | void>
	beforeExecute?(route: PRoute, request: PRequest, session: Session): Promise<WebServerResponse | void>
}

export type PWebSocketClientEvents = Record<string, (params: { clientSocket: socketIo.Socket, session: Session, data: unknown[] }) => void>

type LoggerType = 'info' | 'success' | 'warning' | 'error' | 'debug' | 'system'

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
			connectionEvent?: (clientSocket: socketIo.Socket, session: Session) => void
			events?: PWebSocketClientEvents
		}
	}
	showErrorsOnClient?: boolean
	defaultRoute?: string
	events?: PWebServerEvents,
	oldFilesInUploadsFolder?: {
		minutesExpiration: number
	}
	sizeRequest: number
	paths: {
		routes: string
		logs: string
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
	} & ({
		storeMethod: StoreMethod.files
		path: string
		pretty?: boolean
	} | {
		storeMethod: StoreMethod.memory
	})
	logs?: {
		console?: {
			info?: boolean
			error?: boolean
			warning?: boolean
			success?: boolean
			debug?: boolean
			system?: boolean
		}
		file?: {
			info?: boolean
			error?: boolean
			warning?: boolean
			success?: boolean
			debug?: boolean
			system?: boolean
		}
	},
}

export class PRoute {
	readonly server: PWebServer
	readonly request: PRequest
	readonly session: Session
	whiteList: string[] = []
	blackList: string[] = []

	constructor(server: PWebServer, request: PRequest, session: Session) {
		this.server = server
		this.request = request
		this.session = session
	}

	async finally() { }
}

/* Send body */
const responseToClient = (response: WebServerResponse, res: express.Response) => {
	if (response.status) res.status(response.status)
	if (!response.cacheControl) {
		res.set('Cache-Control', 'no-cache')
		res.set('ETag', Math.random().toString())
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
	const session = new Session({
		ip: clientSocket.handshake.address,
		hs: request.cookies?.hs,
		hostname: request.headers.host,
		userAgent: request.headers['user-agent'] ?? '',
		minutesExpiration: config.sessions.minutesExpiration,
		sessions: webServer.sessions,
		storeMethod: config.sessions.storeMethod,
		pretty: 'pretty' in config.sessions ? config.sessions.pretty : null,
		storePath: config.sessions.storeMethod == StoreMethod.files ? config.sessions.path : undefined
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

const logger = (method: LoggerType, config: PWebServerParams, { label, description, body, request, exit = false }: PWebServerLoggerParams) => {
	/* Determina si el mensaje se mostrará en consola */
	const showInConsole =
		(config?.logs?.console?.success && method == 'success')
		|| (config?.logs?.console?.info && method == 'info')
		|| (config?.logs?.console?.system && method == 'system')
		|| (config?.logs?.console?.warning && method == 'warning')
		|| (config?.logs?.console?.error && method == 'error')
		|| (config?.logs?.console?.debug && method == 'debug')

	/* Determina si el mensaje se mostrará en archivo */
	const showInLogFile =
		(config?.logs?.file?.success && method == 'success')
		|| (config?.logs?.file?.info && method == 'info')
		|| (config?.logs?.file?.system && method == 'system')
		|| (config?.logs?.file?.warning && method == 'warning')
		|| (config?.logs?.file?.error && method == 'error')
		|| (config?.logs?.file?.debug && method == 'debug')

	/* Esta variable pintará etiquestas antes de las declaradas en 'tags' */
	const descriptions = []
	if (description) descriptions.push(description)
	if (request?.ip) descriptions.push(request.ip)
	if (request?.pathUrl) descriptions.push(request.pathUrl)

	PLogger[method]({ label, description: descriptions.join(' :: '), body, exit, showInConsole, logPath: showInLogFile ? config.paths.logs : undefined })
}

export class PWebServer {
	config: Readonly<PWebServerParams>
	private oldFilesDeleterInterval?: ReturnType<typeof setInterval>
	public sessions: SessionCollection = {}
	readonly paths: {
		readonly logs: string
		readonly routes: string
		readonly sessions?: string
		readonly uploads?: string
		readonly public?: string
	}
	private app?: express.Express
	private server?: http.Server
	public webSocket?: socketIo.Server
	private serverTls?: https.Server
	// public socketServerTls?: socketIo.Server

	constructor(config: PWebServerParams) {
		/* Valida la existencia de definición de una instancia */
		if (!config.instances.http && !config.instances.https) {
			throw new Error(`Es requerido especificar la configuración de las instancias de servicio web en 'instances.http' o 'instances.https'`)
		}

		/* Valida el contenido de la ruta por defecto */
		if (config.defaultRoute && config.defaultRoute.match(/^(\/|\\)/)) throw new Error(`La propiedad de configuración 'defaultRoute' no debe iniciar con '\\' o '/'`)

		/* Valida que los paths no se estén enviando vacíos */
		if (!config.paths.logs.trim()) throw new Error(`Es requerido especificar la ruta para los archivos de log en 'paths.logs'`)
		if (!config.paths.routes.trim()) throw new Error(`Es requerido especificar la ruta para los archivos de rutas en 'paths.routes'`)
		if (!config.paths.uploads.trim()) throw new Error(`La ruta especificada en 'paths.uploads' no tiene un valor válido`)

		/* Valida la configuración de las sesiones */
		if (config.sessions.storeMethod == StoreMethod.files) {
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
			logs: config.paths.logs,
			routes: config.paths.routes,
			sessions: config.sessions.storeMethod == StoreMethod.files ? config.sessions.path : undefined,
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
				responseToClient(new WebServerResponse({
					status: 404,
					body: 'No se encontró la ruta'
				}), res)
			}
		})

		/* Body-parser */
		app.use((req, res, next) => {
			bodyParser.json({ limit: config.sizeRequest + 'mb' })(req, res, error => {
				if (error instanceof SyntaxError) {
					responseToClient(new WebServerResponse({
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
				responseToClient(new WebServerResponse({
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
				responseToClient(new WebServerResponse({
					body: 'La petición supera el límite establecido',
					status: 500
				}), res)
			} else {
				next()
			}
		})

		/* Carga de la ruta dinámica */
		app.use(async (req: express.Request, res: express.Response) => {
			const response = await this.detectRoute(req)
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

		this.oldFilesDeleterInterval = setInterval(this.deleteOldFiles.bind(this), 1000 * 60)
		this.deleteOldFiles()
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

	private async deleteOldFiles() {
		/* Elimina sesiones antiguas */
		const config = this.config
		const expirationTime = new Date
		expirationTime.setMinutes(expirationTime.getMinutes() - config.sessions.minutesExpiration)
		switch (config.sessions.storeMethod) {
			case StoreMethod.files: {
				if (!PUtils.Files.existsDirectory(config.sessions.path)) break
				const files = fs.readdirSync(config.sessions.path)
				for (const file of files) {
					if (['.', '..'].includes(file)) continue
					const filePath = path.join(config.sessions.path, file)
					const stats = fs.statSync(filePath)
					if (!stats.isFile()) continue
					try {
						const sessionBody: SessionBody = JSON.parse(fs.readFileSync(filePath, { encoding: 'utf-8' }))
						if (new Date(sessionBody.lastCheck) < expirationTime) {
							fs.unlinkSync(filePath)
						}
					} catch {
						fs.unlinkSync(filePath)
					}
				}
				break
			}
			case StoreMethod.memory: {
				for (const id in this.sessions) {
					if (new Date(this.sessions[id].lastCheck) < expirationTime) {
						delete this.sessions[id]
					}
				}
				break
			}
		}
		/* Elimina archivos subidos antiguos */
		if (config.oldFilesInUploadsFolder?.minutesExpiration && PUtils.Files.existsDirectory(this.paths.uploads)) {
			const files = fs.readdirSync(this.paths.uploads)
			const expirationTime = new Date
			expirationTime.setMinutes(expirationTime.getMinutes() - config.oldFilesInUploadsFolder.minutesExpiration)
			for (const file of files) {
				if (['.', '..'].includes(file)) continue
				const filePath = path.join(this.paths.uploads, file)
				const stats = fs.statSync(filePath)
				if (!stats.isFile()) continue
				if (stats.ctime < expirationTime && stats.size > 0) {
					try {
						fs.unlinkSync(filePath)
						this.logger.info({ label: 'FILE DELETED', description: file })
					} catch (err) {
						this.logger.error({ label: 'ERROR', description: `Error al intentar borrar el archivo "${file}"`, body: err })
					}
				}
			}
		}
	}

	logger = {
		info: (params: PWebServerLoggerParams) => logger('info', this.config, params),
		success: (params: PWebServerLoggerParams) => logger('success', this.config, params),
		debug: (params: PWebServerLoggerParams) => logger('debug', this.config, params),
		error: (params: PWebServerLoggerParams) => logger('error', this.config, params),
		system: (params: PWebServerLoggerParams) => logger('system', this.config, params),
		warning: (params: PWebServerLoggerParams) => logger('warning', this.config, params),
	}

	private async notFound(type: 'script' | 'function', pathToRoute: string, functionName: string, request: PRequest, session: Session) {
		const config = this.config
		const response = new WebServerResponse({
			body: `No se encontró la ruta`,
			status: 404
		})
		let notFoundEventResponse: WebServerResponse
		try {
			notFoundEventResponse = await config.events?.notFound?.('script', request, session) as WebServerResponse
			if (!notFoundEventResponse) {
				if (type == 'script') {
					this.logger.error({ label: 'ERROR', description: `No se encontró la ruta '${pathToRoute}'`, request })
				} else {
					this.logger.error({ label: 'ERROR', description: `No se encontró la función '${functionName}' en '${pathToRoute}'`, request })
				}
			}
		} catch (err) {
			const subtitle = `Error al ejecutar el evento 'notFound'`
			this.logger.error({ label: 'ERROR', description: subtitle, body: err, request })
			notFoundEventResponse = new WebServerResponse({
				body: subtitle,
				status: 500
			})
		}
		return notFoundEventResponse ?? response
	}

	private async detectRoute(req): Promise<WebServerResponse> {
		const config = this.config
		const request = new PRequest(req)
		const session = new Session({
			ip: request.ip,
			hs: request.cookies?.hs,
			hostname: request.hostname,
			userAgent: request.headers['user-agent'] ?? '',
			minutesExpiration: config.sessions.minutesExpiration,
			sessions: this.sessions,
			storeMethod: config.sessions.storeMethod,
			pretty: 'pretty' in config.sessions ? config.sessions.pretty : null,
			storePath: config.sessions.storeMethod == StoreMethod.files ? config.sessions.path : undefined
		})

		/* Detiene la llamada en caso el protocolo sea diferente */
		const httpsWebServerPort = config.instances.https?.port
		if (request.protocol == 'http' && httpsWebServerPort) {
			return new WebServerResponse({ redirect: `https://${request.hostname}:${httpsWebServerPort}/${request.pathUrl}${request.queryUrl}` })
		}

		this.logger.system({ label: '>>> REQUEST', request })

		/* Ejecuta el evento, el cual puede responder con un objeto Response y con ello detener el proceso */
		if (config.events?.requestReceived) {
			let response: WebServerResponse | void
			try {
				response = await config.events.requestReceived(request, session)
			} catch (err) {
				const message = `Ocurrió un error al ejecutar el evento 'requestReceived'`
				this.logger.error({ label: 'EVENTS', description: message, body: err, request })
				return new WebServerResponse({
					body: message,
					status: 503
				})
			}
			if (response) return response
		}

		const response: WebServerResponse = await (async (): Promise<WebServerResponse> => {
			const parameters = []

			/* Se extrae el path, en caso no lo tenga, se utiliza el path por defecto establecido en la configuración */
			let requestPathUrl = this.config.baseUrl ? request.pathUrl.replace(new RegExp('^' + this.config.baseUrl + '(\\/|$)'), '') : request.pathUrl
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
					return new WebServerResponse({
						body: new FileInfo({ filePath: publicFilePath }),
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
						return await this.notFound('script', pathToRoute, '', request, session)
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
							return await this.notFound('script', pathToRoute, '', request, session)
						}
					}
				}

				try {
					const routeClass = await this.loadRouteClass(pathToRoute)
					routeObject = new routeClass(this, request, session)
				} catch (err) {
					const description = `Error al importar la ruta '${relativePathToRouteArray.join(' / ')}'`
					this.logger.error({ label: 'ERROR', description, body: err, request })
					return new WebServerResponse({
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
					return await this.notFound('function', pathToRoute, functionName, request, session)
				}
			}

			/* Busca los parámetros */
			while (i < pathParts.length) {
				const part = pathParts[i]
				parameters.push(decodeURIComponent(part).trim())
				i++
			}

			const toExecute = routeObject[functionName]

			if (toExecute == null) return new WebServerResponse({
				body: `'${functionName}' no existe como método de ruta`,
				status: 404
			})

			if (typeof toExecute != 'function' || toExecute.constructor.name != 'AsyncFunction') return new WebServerResponse({
				body: `'${functionName}' no es una función válida de ruta`,
				status: 500
			})

			/* Verifica si la librería tiene definida una lista blanca de IPs */
			if (routeObject.whiteList.length && !routeObject.whiteList.includes(request.ip)) return new WebServerResponse({
				body: `Acceso prohibido al IP '${request.ip}'`,
				status: 401
			})

			/* Verifica si la librería tiene definida una lista blanca de IPs */
			if (routeObject.blackList.length && routeObject.blackList.includes(request.ip)) return new WebServerResponse({
				body: `Acceso prohibido al IP '${request.ip}'`,
				status: 401
			})

			/* Ejecuta el evento antes de llamar a la función */
			try {
				const response = await config.events?.beforeExecute?.(routeObject, request, session)
				if (response) return response
			} catch (err) {
				const subtitle = `Ocurrió un error en la ejecución del evento 'beforeExecute'`
				this.logger.error({ label: 'ERROR', description: subtitle, body: err, request })
				return new WebServerResponse({
					body: subtitle,
					status: 500
				})
			}

			let result: unknown
			try {
				result = await toExecute.apply(routeObject, parameters)
			} catch (err) {
				const description = `Ocurrió un error en la ejecución de la función '${functionName}'`
				await this.logger.error({ label: 'ERROR', description, body: err, request })
				result = new WebServerResponse({
					body: config.showErrorsOnClient ? `${description}${err ? `\n\n${err.message}\n${err.stack}` : ''}` : 'Error en el servidor',
					status: 500
				})
			} finally {
				/* Ejecuta el método finally de la ruta */
				try {
					await routeObject.finally()
				} catch (err) {
					const subtitle = `Ocurrió un error en la ejecución del método 'finally'`
					this.logger.error({ label: 'ERROR', description: subtitle, body: err, request })
					result = new WebServerResponse({
						body: subtitle,
						status: 500
					})
				}
			}

			/* Devuelve la respuesta de la función */
			if (result instanceof WebServerResponse) {
				return result
			} else {
				return new WebServerResponse({
					body: result as ResponseBody,
					status: 200
				})
			}
		})()

		this.logger.system({ label: 'RESPONSE >>>', request })
		response.cookies.push({
			name: 'hs',
			value: session.id,
			httpOnly: true,
			sameSite: config.sessions?.sameSiteCookie
		})
		return response
	}

	async loadRouteClass(...filePath: string[]): Promise<typeof PRoute> {
		const config = this.config
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
}