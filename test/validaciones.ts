import { PWebServer } from '../src/index'
import { StoreMethod } from '../src/session'

const server = new PWebServer({
	instances: {
		http: {
			port: 6001
		}
	},
	paths: {
		routes: './routes',
		uploads: './'
	},
	sessions: {
		minutesExpiration: 15,
		storeMethod: StoreMethod.files,
		path: './',
		pretty: true,
	}
})
server.start()