import express from 'express'
import { PRecord, PUtilsObject } from 'pols-utils'

export class PRequest {
	readonly protocol: string
	readonly hostname: string
	readonly pathUrl: string
	readonly queryUrl: string
	readonly query: PRecord
	readonly ip: string
	readonly headers: Record<string, string>
	readonly cookies?: Record<string, string>
	readonly body?: PRecord
	readonly method: string
	readonly targetHost: string
	readonly files?: {
		[fieldName: string]: {
			fileName: string
			tempPath: string
			mimeType: string
			encoding: string
			size: number
		}[]
	}
	public remap?: string

	constructor(req: express.Request) {
		this.protocol = req.protocol
		this.hostname = req.hostname
		this.pathUrl = req.path?.replace(/^\//, '') ?? ''
		this.query = (req.query as any) ?? {}
		this.queryUrl = PUtilsObject.toUrlParameters(this.query)
		this.ip = req.ip
		this.headers = {}
		for (const key in req.headers) {
			const value = req.headers[key]
			this.headers[key] = value instanceof Array ? value.join(', ') : value
		}
		this.body = req.body
		if (req.files) {
			this.files = {}
			for (const file in req.files) {
				let reference = req.files[file]
				if (!(reference instanceof Array)) {
					reference = [reference]
				}
				this.files[file] = []
				for (const uploadedFile of reference) {
					this.files[file].push({
						fileName: decodeURIComponent(uploadedFile.name),
						tempPath: uploadedFile.tempFilePath,
						mimeType: uploadedFile.mimetype,
						encoding: uploadedFile.encoding,
						size: uploadedFile.size
					})
				}
			}
		}
		this.method = req.method.toLowerCase()
		this.targetHost = req.headers['host']
		const cookiesHeader = req.headers.cookie
		if (cookiesHeader) {
			const cookiesParts = cookiesHeader.split(';')
			this.cookies = {}
			for (const cookiesPart of cookiesParts) {
				const parts = cookiesPart.split('=')
				this.cookies[parts.shift().trim()] = decodeURI(parts.join('='))
			}
		}
	}
}