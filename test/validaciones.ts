import { PWebServer } from '../src/index'
import { StoreMethod } from '../src/session'
import path from 'path'

const server = new PWebServer({
	instances: {
		http: {
			port: 6001
		}
	},
	paths: {
		routes: path.join(__dirname, './routes'),
		uploads: path.join(__dirname, './uploads')
	},
	sessions: {
		minutesExpiration: 15,
		storeMethod: StoreMethod.files,
		path: path.join(__dirname, './sessions'),
		pretty: true,
	}
})
server.start()