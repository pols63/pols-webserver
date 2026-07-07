import { PSession, PSessionCollection, PSessionStoreMethod, PSessionStoreFunctions, clearOldSessions } from './session'
import { rules } from 'pols-validator'
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
import { PLogger, PLoggerLogParams, PLoggerParams } from 'pols-logger'
import { PUtilsFS } from 'pols-utils'
import { PDictionary, prepareMessage } from './dictionary'

export { PQuickResponse } from './quickResponse'
export { PResponse, PRequest }
export { PLogger, PLoggerLogParams, PLoggerParams } from 'pols-logger'

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
	hotReloading?: boolean
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
		cacheControl?: boolean
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
	logger: PLogger,
}

export class PRoute {
	readonly server: PWebServer
	readonly request: PRequest
	readonly session: PSession
	whiteList: string[] = []
	blackList: string[] = []
	onFinally?(): Promise<void>

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
		body.on('error', (err) => {
			if (!res.headersSent) {
				res.status(500).send('Error reading stream')
			}
		})
		body.pipe(res)
	} else {
		res.send(body ?? '')
	}
}

const socketConnectionEvent = async (webServer: PWebServer, clientSocket: socketIo.Socket, events: PWebSocketClientEvents) => {
	webServer.logger.system({ description: PDictionary.systemWebSocketConnected })
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
	await session.start()
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

	if (!fs.existsSync(codePath)) throw new Error(prepareMessage(PDictionary.errorRouteFileNotExists, { codePath }))

	if (config.hotReloading) {
		delete require.cache[codePath]
	}

	let RouteClass: any
	try {
		RouteClass = require(codePath)
	} catch (err) {
		throw new Error(prepareMessage(PDictionary.errorRouteImport, { codePath, stack: err.stack }))
	}
	const TargetClass = RouteClass?.default || RouteClass
	if (!(TargetClass?.prototype instanceof PRoute)) throw new Error(prepareMessage(PDictionary.errorRouteInheritance, { codePath }))

	return TargetClass
}

const notFound = async (webServer: PWebServer, type: 'script' | 'function', pathToRoute: string, functionName: string, request: PRequest, session: PSession) => {
	const response = new PResponse({
		body: PDictionary.errorRouteNotFound,
		status: 404
	})
	let notFoundEventResponse: PResponse
	try {
		notFoundEventResponse = await webServer.onNotFound?.({ type, request, session }) as PResponse
		if (!notFoundEventResponse) {
			if (type == 'script') {
				webServer.logger.error({ description: prepareMessage(PDictionary.errorRouteNotFoundLogger, { pathToRoute }) }, request)
			} else {
				webServer.logger.error({ description: prepareMessage(PDictionary.errorFunctionNotFoundLogger, { functionName, pathToRoute }) }, request)
			}
		}
	} catch (err) {
		const subtitle = PDictionary.errorNotFoundEvent
		webServer.logger.error({ description: subtitle, body: err }, request)
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
		hostname: request.url.host,
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
	if (request.url.protocol == 'http' && httpsWebServerPort) {
		return new PResponse({ redirect: `https://${request.url.toString({ protocol: false })}` })
	}

	webServer.logger.system({ description: PDictionary.systemRequestReceived }, request)

	/* Ejecuta el evento, el cual puede responder con un objeto Response y con ello detener el proceso */
	if (webServer.onRequestReceived) {
		let response: PResponse | void
		try {
			response = await webServer.onRequestReceived({ request, session })
		} catch (err) {
			const message = PDictionary.errorRequestReceived
			webServer.logger.error({ description: message, body: err }, request)
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
		let requestPathUrl = webServer.config.baseUrl ? request.url.path.replace(new RegExp('^' + webServer.config.baseUrl + '(\\/|$)'), '') : request.url.path
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
			if (config.public.urlPath && request.url.path.match(new RegExp('^' + config.public.urlPath))) {
				pathUrlCopy = request.url.path.replace(new RegExp('^' + config.public.urlPath), '')
			}
			const publicFilePath = path.join(config.public.path, pathUrlCopy)
			if (PUtilsFS.existsFile(publicFilePath)) {
				return new PResponse({
					body: new PFileInfo({ filePath: publicFilePath }),
					status: 200,
					cacheControl: config.public?.cacheControl ?? true
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
				if (statsInfo.isDirectory()) {
					pathToRouteArray.push(part)
					relativePathToRouteArray.push(part)
					i++
					part = pathParts[i]
					if (part == null) part = 'index'
					continue
				} else {
					return await notFound(webServer, 'script', pathToRoute, '', request, session)
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
						return await notFound(webServer, 'script', pathToRoute, '', request, session)
					}
				}
			}

			try {
				const routeClass = await loadRouteClass(webServer, pathToRoute)
				routeObject = new routeClass(webServer, request, session)
			} catch (err) {
				const description = prepareMessage(PDictionary.errorRouteImportFromRelative, { relativePath: relativePathToRouteArray.join(' / ') })
				webServer.logger.error({ description, body: err }, request)
				return new PResponse({
					body: config.showErrorsOnClient ? `${description}${err ? `\n\n${err.message}\n${err.stack}` : ''}` : PDictionary.errorServer,
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
				const attemptedName = part ? `${request.method}$${part} o $${part}` : '$index'
				return await notFound(webServer, 'function', pathToRoute, attemptedName, request, session)
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
			body: prepareMessage(PDictionary.errorMethodNotExists, { functionName }),
			status: 404
		})

		if (typeof toExecute != 'function') return new PResponse({
			body: prepareMessage(PDictionary.errorMethodInvalid, { functionName }),
			status: 500
		})

		/* Verifica si la librería tiene definida una lista blanca de IPs */
		if (routeObject.whiteList.length && !routeObject.whiteList.includes(request.ip)) return new PResponse({
			body: prepareMessage(PDictionary.errorForbiddenIp, { ip: request.ip }),
			status: 401
		})

		/* Verifica si la librería tiene definida una lista blanca de IPs */
		if (routeObject.blackList.length && routeObject.blackList.includes(request.ip)) return new PResponse({
			body: prepareMessage(PDictionary.errorForbiddenIp, { ip: request.ip }),
			status: 401
		})

		/* Ejecuta el evento antes de llamar a la función */
		try {
			const response = await webServer.onBeforeExecute?.({ route: routeObject, request, session })
			if (response) return response
		} catch (err) {
			const subtitle = PDictionary.errorBeforeExecute
			webServer.logger.error({ description: subtitle, body: err }, request)
			return new PResponse({
				body: subtitle,
				status: 500
			})
		}

		let result: unknown
		try {
			result = await toExecute.apply(routeObject, parameters)
		} catch (err) {
			const description = prepareMessage(PDictionary.errorFunctionExecution, { functionName })
			webServer.logger.error({ description, body: err }, request)
			result = new PResponse({
				body: config.showErrorsOnClient ? `${description}${err ? `\n\n${err.message}\n${err.stack}` : ''}` : PDictionary.errorServer,
				status: 500
			})
		} finally {
			/* Ejecuta el método finally de la ruta */
			try {
				await routeObject.onFinally?.()
			} catch (err) {
				const subtitle = PDictionary.errorFinally
				webServer.logger.error({ description: subtitle, body: err }, request)
				result = new PResponse({
					body: subtitle,
					status: 500
				})
			}
		}

		/* Evento antes de dar respuesta */
		try {
			const result2 = await webServer.onBeforeResponse?.({ route: routeObject, request, session, callbackResult: result })
			if (result2) result = result2
		} catch (err) {
			const subtitle = PDictionary.errorBeforeResponse
			webServer.logger.error({ description: subtitle, body: err }, request)
			result = new PResponse({
				body: subtitle,
				status: 500
			})
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

	webServer.logger.system({ description: PDictionary.systemResponseSent }, request)
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
	if (config.oldFilesInUploadsFolder?.minutesExpiration && PUtilsFS.existsDirectory(webServer.paths.uploads)) {
		const files = fs.readdirSync(webServer.paths.uploads)
		const expirationTime = new Date
		expirationTime.setMinutes(expirationTime.getMinutes() - config.oldFilesInUploadsFolder.minutesExpiration)
		for (const file of files) {
			if (['.', '..'].includes(file)) continue
			const filePath = path.join(webServer.paths.uploads, file)
			const stats = fs.statSync(filePath)
			if (!stats.isFile()) continue
			if (stats.ctime < expirationTime) {
				try {
					fs.unlinkSync(filePath)
					webServer.logger.info({ description: prepareMessage(PDictionary.infoFileDeleted, { file }) })
				} catch (err) {
					webServer.logger.error({ description: prepareMessage(PDictionary.errorDeleteFile, { file }), body: err })
				}
			}
		}
	}
}

const logger = (params: PLoggerLogParams, pLogger?: PLogger, methodName?: string, request?: PRequest) => {
	if (!pLogger) return
	const tags = [...(params.tags ?? [])]
	if (request) tags.push(request.ip, request.url.path)
	pLogger?.[methodName]?.({
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
	declare onBeforeResponse: ({ route, request, session }: { route: PRoute, request: PRequest, session: PSession, callbackResult: unknown }) => Promise<PResponse | void>

	get logger() {
		return {
			info: (params: Omit<PLoggerLogParams, 'label'>, request?: PRequest) => logger({ ...params, label: 'WEB SERVER' }, this.config.logger, 'info', request),
			warning: (params: Omit<PLoggerLogParams, 'label'>, request?: PRequest) => logger({ ...params, label: 'WEB SERVER' }, this.config.logger, 'warning', request),
			error: (params: Omit<PLoggerLogParams, 'label'>, request?: PRequest) => logger({ ...params, label: 'WEB SERVER' }, this.config.logger, 'error', request),
			debug: (params: Omit<PLoggerLogParams, 'label'>, request?: PRequest) => logger({ ...params, label: 'WEB SERVER' }, this.config.logger, 'debug', request),
			system: (params: Omit<PLoggerLogParams, 'label'>, request?: PRequest) => logger({ ...params, label: 'WEB SERVER' }, this.config.logger, 'system', request),
			fatal: (params: Omit<PLoggerLogParams, 'label'>, request?: PRequest) => logger({ ...params, label: 'WEB SERVER' }, this.config.logger, 'fatal', request),
		}
	}

	constructor(config: PWebServerParams) {
		/* Valida los parámetros de la configuración */
		const v = rules({ label: 'config', required: true }).isObject({
			paths: rules({ required: true }).isObject({
				logs: rules({ default: './' }).isAlphanumeric(),
				routes: rules({ required: true }).isAlphanumeric(),
				uploads: rules({ default: './' }).isAlphanumeric()
			}),
			sizeRequest: rules({ default: 50 }).isNumber().isGt(0),
			hotReloading: rules({ default: false }).isBoolean()
		}).validate<PWebServerParams>(config)
		if (v.error == true) throw new Error(v.messages[0])
		config.paths = v.sanitized.paths
		config.sizeRequest = v.sanitized.sizeRequest
		config.hotReloading = v.sanitized.hotReloading

		/* Valida la existencia de definición de una instancia */
		if (!config.instances.http && !config.instances.https) {
			throw new Error(PDictionary.errorInstancesRequired)
		}

		/* Valida el contenido de la ruta por defecto */
		if (config.defaultRoute && config.defaultRoute.match(/^(\/|\\)/)) throw new Error(PDictionary.errorDefaultRouteSlashes)

		/* Valida la configuración de las sesiones */
		if (config.sessions.storeMethod == PSessionStoreMethod.files) {
			if (!config.sessions.path) throw new Error(PDictionary.errorSessionPathRequired)
		}
		if (config.sessions.minutesExpiration < 0) throw new Error(PDictionary.errorSessionExpirationNegative)

		/* Valida las propiedades para public */
		if (config.public) {
			if (!config.public.path.trim()) throw new Error(PDictionary.errorPublicPathRequired)
			if (config.public.urlPath.match(/^\//)) throw new Error(PDictionary.errorPublicUrlPathSlash)
		}

		this.config = config
		this.paths = {
			routes: config.paths.routes,
			sessions: config.sessions.storeMethod == PSessionStoreMethod.files ? config.sessions.path : undefined,
			uploads: config.paths.uploads,
			public: config.public?.path,
		}

		try {
			if (!fs.existsSync(config.paths.uploads)) fs.mkdirSync(config.paths.uploads, { recursive: true })
		} catch (err) {
			this.logger.error({ description: prepareMessage(PDictionary.errorUploadFolderCreation, { uploadPath: config.paths.uploads }), body: err })
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
					body: PDictionary.errorRouteNotFound
				}), res)
			}
		})

		/* Body-parser */
		app.use((req, res, next) => {
			bodyParser.json({ limit: config.sizeRequest + 'mb' })(req, res, error => {
				if (error instanceof SyntaxError) {
					responseToClient(new PResponse({
						status: 400,
						body: PDictionary.errorJsonFormat
					}), res)
				} else {
					next(error)
				}
			})
		})
		app.use(bodyParser.raw({ limit: config.sizeRequest + 'mb' }))
		app.use(bodyParser.text({ limit: config.sizeRequest + 'mb' }))
		app.use(bodyParser.urlencoded({ limit: config.sizeRequest + 'mb', extended: true }))



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
					body: PDictionary.errorRequestLimit,
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
				this.logger.error({ description: PDictionary.errorBeforeExecute, body: error })
				response = new PResponse({
					body: PDictionary.errorServer,
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
		if (this.server?.listening || this.serverTls?.listening) throw new Error(PDictionary.errorServiceInitialized)
		const config = this.config

		if (config.instances.http) {
			this.server.listen(config.instances.http.port, () => {
				this.logger.system({ description: prepareMessage(PDictionary.systemListeningHttp, { port: config.instances.http.port }) })
			})
		}

		if (config.instances.https) {
			this.serverTls.listen(config.instances.https.port, () => {
				this.logger.system({ description: prepareMessage(PDictionary.systemListeningHttps, { port: config.instances.https.port }) })
			})
		}

		this.oldFilesDeleterInterval = setInterval(() => deleteOldFiles(this), 2000 * 60)
		deleteOldFiles(this)
	}

	stop() {
		clearInterval(this.oldFilesDeleterInterval)
		this.server?.close(() => {
			this.logger.system({ description: PDictionary.systemHttpStopped })
		})
		this.serverTls?.close(() => {
			this.logger.system({ description: PDictionary.systemHttpsStopped })
		})
	}
}