import express from 'express'
import { PRecord, PUtilsObject } from 'pols-utils'

export class PUrl {
	readonly protocol: string
	readonly host: string
	readonly path: string
	readonly query: string

	constructor(params: {
		protocol: string
		host: string
		path: string
		query: string
	}) {
		this.protocol = params.protocol
		this.host = params.host
		this.path = params.path
		this.query = params.query
	}

	toString(toShow?: {
		protocol?: boolean
		host?: boolean
		path?: boolean
		query?: boolean
	}) {
		let url = ''
		if (toShow?.protocol == null || toShow?.protocol == true) url += this.protocol
		if (toShow?.host == null || toShow?.host == true) {
			if (url) url += '://'
			url += this.host
		}
		if (toShow?.path == null || toShow?.path == true) {
			if (url) url += '/'
			url += this.path
		}
		if ((toShow?.query == null || toShow?.query == true) && this.query) {
			if (url) url += '?'
			url += this.query
		}
		return url
	}
}

export class PRequest {
	readonly url: PUrl
	readonly query: PRecord
	readonly ip: string
	readonly headers: Record<string, string>
	readonly cookies?: Record<string, string>
	readonly body?: PRecord
	readonly method: string
	readonly targetHost: string
	readonly referrer: string
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
		/* Construcción de los elementos de la URL */
		this.query = (req.query as any) ?? {}
		this.url = new PUrl({
			protocol: req.protocol,
			host: req.get('host'),
			path: req.path?.replace(/^\//, '') ?? '',
			query: PUtilsObject.toUrlParameters(this.query),
		})
		this.referrer = req.get?.('Referer')
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
				this.cookies[parts.shift().trim()] = decodeURIComponent(parts.join('='))
			}
		}
	}
}