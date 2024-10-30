import fs from 'fs'
import mimeTypes from 'mime-types'
import { PUtils } from 'pols-utils'
import stream from 'stream'

export const Status = {
	Ok: 200,
	Found: 302,
	Forbidden: 403,
	NotFound: 404,
	UnprocessableContent: 422,
	ServiceUnavailable: 503,
	InternalServerError: 500,
}

export class PFileInfo {
	fileName: string
	filePath?: string
	content?: string

	constructor(params: ({ fileName?: string, filePath: string } | { fileName: string, content: string })) {
		if ('filePath' in params) {
			this.filePath = params.filePath
			if (params.fileName) {
				this.fileName = params.fileName
			} else {
				const parts = params.filePath.split(/\/|\\/)
				this.fileName = parts[parts.length - 1]
			}
		} else {
			this.fileName = params.fileName
			this.content = params.content
		}
	}
}

export class PFileStream {
	stream: stream.Readable
	fileName: string
	contentType?: string
	contentLength?: number
	forceDownload?: boolean

	constructor(params: { stream: stream.Readable, fileName: string, contentType?: string, contentLength?: number, forceDownload?: boolean }) {
		this.stream = params.stream
		this.fileName = params.fileName
		this.contentType = params.contentType
		this.contentLength = params.contentLength
		this.forceDownload = params.forceDownload
	}
}

export type ResponseBody = string | number | boolean | object | PFileInfo | PFileStream | stream.Readable

export type PResponseParams = {
	body?: ResponseBody
	status?: number
	statusText?: string
	headers?: { [key: string]: string }
} | {
	redirect: string
}

export type Cookie = {
	name: string
	value: string | number
	httpOnly: boolean
	sameSite?: 'strict' | 'lax' | 'none'
}

export class PResponse {
	originalBody?: unknown
	body?: string | Buffer | stream.Readable
	status?: number
	statusText?: string
	headers: { [key: string]: string } = {}
	cookies: Cookie[] = []
	cacheControl = false

	constructor(params: PResponseParams) {
		if ('redirect' in params) {
			this.status = 302
			this.headers = {
				location: params.redirect
			}
		} else {
			this.originalBody = params.body
			if (params.body instanceof PFileInfo) {
				if (params.body.filePath) {
					if (!fs.existsSync(params.body.filePath)) {
						this.status = 404
						this.body = `No existe el archivo '${params.body.fileName ?? params.body.filePath}'`
						return
					}
					this.body = fs.createReadStream(params.body.filePath)
					this.headers['Content-Type'] = mimeTypes.lookup(params.body.fileName ?? params.body.filePath) || 'application/octet-stream'
				} else {
					this.body = params.body.content
					this.headers['Content-Type'] = mimeTypes.contentType(params.body.content) || 'application/text'
				}

				const fileName = encodeURIComponent(params.body.fileName)
				/* Asigna las cabeceras */
				this.headers['Content-disposition'] = `inline; ${fileName ? `filename="${fileName}"` : ''}`
				if (fileName) this.headers['file-name'] = fileName
			} else if (params.body instanceof PFileStream) {
				this.headers['Content-Type'] = params.body.contentType ?? (mimeTypes.lookup(params.body.fileName) || 'application/octet-stream')
				const contentDisposition: string[] = [params.body.forceDownload ? 'attachment' : 'inline']
				if (params.body?.fileName) contentDisposition.push(`filename="${encodeURIComponent(params.body.fileName)}"`)
				this.headers['Content-disposition'] = contentDisposition.join('; ')
				if (params.body.contentLength) this.headers['content-length'] = params.body.contentLength.toString()
				this.body = params.body.stream
			} else if ((typeof params.body == 'object' && params.body instanceof stream.Readable) || params.body instanceof Buffer) {
				this.body = params.body
			} else if (typeof params.body == 'number') {
				this.headers['Content-Type'] = 'text/plain'
				this.body = params.body.toString()
			} else if ((params.body !== undefined && typeof params.body != 'string') || (typeof params.body == 'boolean') || (typeof params.body == 'object')) {
				this.headers['Content-Type'] = 'application/json'
				this.body = PUtils.JSON.stringify(params.body)
			} else {
				this.headers['Content-Type'] = 'text/plain'
				this.body = params.body ?? ''
			}

			if (params.headers) {
				this.headers = {
					...this.headers,
					...params.headers
				}
			}

			this.status = params.status
			this.statusText = params.statusText
		}
	}
}
