import { PWebServer } from '../src/index'
import { PSessionStoreMethod } from '../src/session'
import { PLogger } from 'pols-logger'
import { io } from 'socket.io-client'
import path from 'path'

const logger = new PLogger()

const server = new PWebServer({
	instances: {
		http: {
			port: 6002
		},
		webSocket: {
			urlPath: 'ws',
			events: {
				ping: ({ clientSocket, data }) => {
					logger.info({ label: 'SERVER_WS', description: `Servidor WebSocket: Evento 'ping' recibido con datos: ${JSON.stringify(data)}` })
					clientSocket.emit('pong', ...data)
				}
			}
		}
	},
	paths: {
		routes: path.join(__dirname, './routes'),
		uploads: path.join(__dirname, './uploads')
	},
	sessions: {
		minutesExpiration: 15,
		storeMethod: PSessionStoreMethod.memory,
		secretKey: 'websocket-test-key'
	},
	logger
})

logger.info({ label: 'TEST', description: 'Iniciando servidor de pruebas WebSocket...' })
server.start()

// Espera un momento y conecta el cliente
setTimeout(() => {
	logger.info({ label: 'TEST', description: 'Conectando cliente WebSocket...' })
	
	const socket = io('http://localhost:6002', {
		path: '/ws/'
	})

	socket.on('connect', () => {
		logger.info({ label: 'CLIENT_WS', description: 'Cliente WebSocket: Conectado exitosamente al servidor' })
		
		logger.info({ label: 'CLIENT_WS', description: "Cliente WebSocket: Emitiendo evento 'ping' con datos ['Hola', 'Mundo']" })
		socket.emit('ping', 'Hola', 'Mundo')
	})

	socket.on('pong', (...args: unknown[]) => {
		logger.info({ label: 'CLIENT_WS', description: `Cliente WebSocket: Evento 'pong' recibido con datos: ${JSON.stringify(args)}` })
		
		if (args[0] === 'Hola' && args[1] === 'Mundo') {
			logger.system({ label: 'TEST', description: 'VERIFICACIÓN EXITOSA: WebSocket funciona perfectamente!' })
		} else {
			logger.error({ label: 'TEST', description: 'VERIFICACIÓN FALLIDA: Datos incorrectos devueltos por el servidor' })
		}

		// Desconecta y detiene el servidor
		socket.disconnect()
		server.stop()
		process.exit(0)
	})

	socket.on('connect_error', (error) => {
		logger.error({ label: 'CLIENT_WS', description: 'Cliente WebSocket: Error de conexión', body: error })
		server.stop()
		process.exit(1)
	})
}, 1000)
