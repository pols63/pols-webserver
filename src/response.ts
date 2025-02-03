import fs from 'fs'
import mimeTypes from 'mime-types'
import { PUtils } from 'pols-utils'
import stream from 'stream'

export const PStatusCollection = {
	Ok: 200,
	Found: 302,
	Forbidden: 403,
	NotFound: 404,
	UnprocessableContent: 422,
	ServiceUnavailable: 503,
	InternalServerError: 500,
}

export type PFileInfoContent = string | Buffer | ArrayBuffer | stream.Readable

export type PFileInfoParams = {
	contentType?: string
	contentLength?: number
	forceDownload?: boolean
} & ({
	fileName?: string
	filePath: string
} | {
	fileName: string
	content: PFileInfoContent
})

export class PFileInfo {
	fileName: string
	filePath?: string
	content?: PFileInfoContent
	contentType?: string
	contentLength?: number
	forceDownload?: boolean

	constructor(params: PFileInfoParams) {
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
		this.contentType = params.contentType
		this.contentLength = params.contentLength
		this.forceDownload = params.forceDownload
	}
}

export type PResponseBody = string | number | boolean | object | PFileInfo | stream.Readable

export type PResponseParams = {
	body?: PResponseBody
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
					const content = params.body.content
					this.body = content instanceof ArrayBuffer ? Buffer.from(content) : content
					if (!params.body.contentType) {
						if (typeof content == 'string') {
							this.headers['Content-Type'] = mimeTypes.contentType(content) || 'application/text'
						} else {
							this.headers['Content-Type'] = mimeTypes.lookup(params.body.fileName ?? params.body.filePath) || 'application/octet-stream'
						}
					} else {
						this.headers['Content-Type'] = params.body.contentType
					}
				}

				const contentDisposition: string[] = [params.body.forceDownload ? 'attachment' : 'inline']
				if (params.body?.fileName) contentDisposition.push(`filename="${encodeURIComponent(params.body.fileName)}"`)
				this.headers['Content-disposition'] = contentDisposition.join('; ')
				if (params.body.contentLength) this.headers['content-length'] = params.body.contentLength.toString()
			} else if (PUtils.ReadableStream.isReadableSream(params.body) || Buffer.isBuffer(params.body)) {
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
