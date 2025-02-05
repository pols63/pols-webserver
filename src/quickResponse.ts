import { PResponse, PResponseBody } from "./response"

export enum PStatusCollection {
	Ok = 200,
	Found = 302,
	Forbidden = 403,
	NotFound = 404,
	UnprocessableContent = 422,
	ServiceUnavailable = 503,
	InternalServerError = 500,
}

type PQuickResponse = Record<keyof typeof PStatusCollection, (body?: PResponseBody) => PResponse> & {
	Redirect: (url: string) => PResponse
}

export const PQuickResponse: PQuickResponse = (() => {
	const result: Partial<PQuickResponse> = {}

	result.Redirect = (url: string) => new PResponse({ redirect: url })

	for (const key in PStatusCollection) {
		result[key] = (body?: PResponseBody) => new PResponse({
			status: Number(PStatusCollection[key]),
			body
		})
	}
	return result as PQuickResponse
})()