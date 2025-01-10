import { PUtils } from 'pols-utils'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'

export enum PSessionStoreMethod {
	files = 'files',
	memory = 'memory',
}

export type PSessionStoreFunctions = {
	get: (id: string) => Promise<PSessionBody | null | undefined>
	save: (id: string, data: PSessionBody) => Promise<void>
	delete: (id: string) => Promise<void>
}

export type PSessionBody = {
	ip: string
	lastCheck: Date
	userAgent: string
	hostname: string
	data: {
		[key: string]: string | number | object
	}
}

export type PSessionCollection = {
	[id: string]: PSessionBody
}

export type PSessionParams = {
	hs?: string
	hostname: string
	ip: string
	userAgent: string
	minutesExpiration: number
	sessions: PSessionCollection
} & ({
	storeMethod: PSessionStoreMethod.memory
} | {
	storeMethod: PSessionStoreMethod.files
	storePath: string
	pretty?: boolean
} | {
	storeMethod: PSessionStoreFunctions
})

export class PSession {
	private _id: string
	private hostname: string
	private ip: string
	private userAgent: string
	private body?: PSessionBody
	private sessions: PSessionCollection
	private storeMethod: PSessionStoreMethod | PSessionStoreFunctions
	private storePath?: string
	private pretty?: boolean
	private minutesExpiration: number

	public get id() {
		return this._id
	}

	public get lastCheck() {
		return this.body?.lastCheck
	}

	constructor(params: PSessionParams) {
		/* Obtiene el ID de la sesión */
		this._id = params.hs ?? ''
		this.hostname = params.hostname
		this.userAgent = params.userAgent
		this.ip = params.ip
		this.sessions = params.sessions
		this.storeMethod = params.storeMethod
		switch (params.storeMethod) {
			case PSessionStoreMethod.files:
				this.storePath = params.storePath
				this.pretty = params.pretty
				break
		}
		this.minutesExpiration = params.minutesExpiration
	}

	private checkPath() {
		/* Valida la existencia del directorio de sesiones e intenta crearlo si es necesario */
		if (this.storeMethod == PSessionStoreMethod.files) {
			if (!PUtils.Files.existsDirectory(this.storePath)) {
				try {
					fs.mkdirSync(this.storePath)
				} catch (err) {
					throw new Error(`Ocurrió un error al intentar crear el directorio para las sesiones '${this.storePath}': ${err.stack}`)
				}
			}
		}
	}

	private checkValidBody(now: Date, expirationTime: Date): boolean {
		if (
			!this.body
			|| !this.body.lastCheck
			|| new Date(this.body.lastCheck) < expirationTime
			|| this.body.userAgent != this.userAgent
			|| this.body?.hostname != this.hostname
		) {
			this.body = undefined
			this.generateID()
			return false
		} else {
			this.body.lastCheck = now
		}
		return true
	}

	async start() {
		this.checkPath()

		/* Se comprueba la identidad del ID */
		if (
			!this._id
			|| !this._id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
		) {
			/* Si ya venía de parte del cliente un ID, pero ésta no existe en memoria, se regenera por seguridad */
			switch (this.storeMethod) {
				case PSessionStoreMethod.files: {
					const bodyFilePath = path.join(this.storePath, `${this._id}.json`)
					if (!PUtils.Files.existsFile(bodyFilePath)) this.generateID()
					break
				}
				case PSessionStoreMethod.memory:
					if (!this.sessions[this._id]) this.generateID()
					break
				default:
					if (!this.storeMethod.get(this._id)) this.generateID()
					break
			}
		}

		const now = new Date
		const expirationTime = new Date
		expirationTime.setMinutes(expirationTime.getMinutes() - this.minutesExpiration)

		/* Si el ID de inicio de sesión está vacío, crea una nueva sesión */
		const newBody: PSessionBody = {
			ip: this.ip,
			lastCheck: now,
			userAgent: this.userAgent,
			hostname: this.hostname,
			data: {}
		}

		while (!this.body) {
			switch (this.storeMethod) {
				case PSessionStoreMethod.files: {
					const bodyFilePath = path.join(this.storePath, `${this._id}.json`)
					if (PUtils.Files.existsFile(bodyFilePath)) {
						try {
							this.body = JSON.parse(fs.readFileSync(bodyFilePath, { encoding: 'utf-8' }))
							if (!this.checkValidBody(now, expirationTime)) continue
						} catch {
							fs.unlinkSync(bodyFilePath)
							this.body = newBody
						}
					} else {
						this.body = newBody
					}
					this.save()
					break
				}
				case PSessionStoreMethod.memory:
					if (this.sessions[this._id]) {
						this.body = this.sessions[this._id]
						if (!this.checkValidBody(now, expirationTime)) continue
					} else {
						this.body = newBody
					}
					this.save()
					break
				default: {
					try {
						this.body = await this.storeMethod.get(this._id)
						if (!this.checkValidBody(now, expirationTime)) continue
					} catch {
						await this.storeMethod.delete(this._id)
						this.body = newBody
					}
					await this.storeMethod.save(this._id, this.body)
					break
				}
			}
		}
	}

	generateID() {
		let generated = false
		while (!generated) {
			this._id = crypto.randomUUID()
			switch (this.storeMethod) {
				case PSessionStoreMethod.files: {
					const bodyFilePath = path.join(this.storePath, `${this._id}.json`)
					if (!PUtils.Files.existsFile(bodyFilePath)) generated = true
					break
				}
				case PSessionStoreMethod.memory: {
					if (!this.sessions[this._id]) generated = true
					break
				}
			}
		}
	}

	get<T = string | number | object>(name: string) {
		return (this.body?.data[name] as T) ?? null
	}

	set(name: string, value: string | number | object) {
		if (this.body?.data) this.body.data[name] = value
	}

	async save() {
		switch (this.storeMethod) {
			case PSessionStoreMethod.files: {
				const bodyFilePath = path.join(this.storePath, `${this._id}.json`)
				fs.writeFileSync(bodyFilePath, PUtils.JSON.stringify(this.body, this.pretty ? '\t' : undefined), { encoding: 'utf-8' })
				break
			}
			case PSessionStoreMethod.memory:
				if (this.body) this.sessions[this._id] = this.body
				break
			default:
				await this.storeMethod.save(this._id, this.body)
				break
		}
	}

	async destroy() {
		switch (this.storeMethod) {
			case PSessionStoreMethod.files: {
				const bodyFilePath = path.join(this.storePath, `${this._id}.json`)
				if (PUtils.Files.existsFile(bodyFilePath)) fs.unlinkSync(bodyFilePath)
				break
			}
			case PSessionStoreMethod.memory: {
				delete this.sessions[this._id]
				break
			}
			default: {
				await this.storeMethod.delete(this._id)
			}
		}
	}
}