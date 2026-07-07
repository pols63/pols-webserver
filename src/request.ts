import express from 'express'
import http from 'http'
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

	constructor(req: express.Request | http.IncomingMessage) {
		/* Construcción de los elementos de la URL */
		let query: Record<string, any> = {}
		if ('query' in req && req.query) {
			query = req.query as any
		} else if (req.url) {
			const urlParts = req.url.split('?')
			if (urlParts[1]) {
				const urlParams = new URLSearchParams(urlParts[1])
				for (const [key, value] of urlParams.entries()) {
					query[key] = value
				}
			}
		}
		this.query = query

		const protocol = ('protocol' in req ? (req as any).protocol : null) || (req.socket && 'encrypted' in req.socket ? 'https' : 'http') || 'http'
		const host = (typeof (req as any).get === 'function' ? (req as any).get('host') : (req.headers['host'] as string)) || ''
		const pathVal = ('path' in req ? (req as any).path : null) || (req.url ? req.url.split('?')[0] : '') || ''

		this.url = new PUrl({
			protocol,
			host,
			path: pathVal.replace(/^\//, '') ?? '',
			query: PUtilsObject.toUrlParameters(this.query),
		})

		this.referrer = (typeof (req as any).get === 'function' ? (req as any).get('Referer') : (req.headers['referer'] as string)) || ''
		this.ip = ('ip' in req ? (req as any).ip : null) || req.socket?.remoteAddress || ''
		this.headers = {}
		for (const key in req.headers) {
			const value = req.headers[key]
			this.headers[key] = value instanceof Array ? value.join(', ') : (value || '')
		}
		this.body = 'body' in req ? (req as any).body : undefined
		if ('files' in req && (req as any).files) {
			const files = (req as any).files
			this.files = {}
			for (const file in files) {
				let reference = files[file]
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
		this.method = req.method?.toLowerCase() || 'get'
		this.targetHost = (req.headers['host'] as string) || ''
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