export const PDictionary = {
	errorBeforeExecute: "Ocurrió un error en la ejecución del manejador del evento 'beforeExecute'",
	errorRequestReceived: "Ocurrió un error al ejecutar en el manejador del evento 'onRequestReceived'",
	errorFinally: "Ocurrió un error en la ejecución del método 'finally'",
	errorBeforeResponse: "Ocurrió un error en la ejecución del manejador del evento 'onBeforeResponse'",
	errorUploadFolderCreation: "Ocurrió un error al intentar crear la carpeta de recepción de archivos '@uploadPath'",
	errorUploadFolderCreationClient: "Ocurrió un error al intentar crear la carpeta de recepción de archivos",
	errorServer: "Error en el servidor",
	errorJsonFormat: "Formato JSON incorrecto",
	errorRouteNotFound: "No se encontró la ruta",
	errorRequestLimit: "La petición supera el límite establecido",
	errorRouteFileNotExists: "No existe el archivo de ruta '@codePath'",
	errorRouteImport: "Error al intentar importar la ruta '@codePath'.\n@stack",
	errorRouteImportFromRelative: "Error al importar la ruta '@relativePath'",
	errorRouteInheritance: "La ruta '@codePath' debe entregar una clase heredada de 'Route'",
	errorRouteNotFoundLogger: "No se encontró la ruta '@pathToRoute'",
	errorFunctionNotFoundLogger: "No se encontró la función '@functionName' en '@pathToRoute'",
	errorMethodNotExists: "'@functionName' no existe como método de ruta",
	errorMethodInvalid: "'@functionName' no es una función válida de ruta",
	errorForbiddenIp: "Acceso prohibido al IP '@ip'",
	errorDeleteFile: "Error al intentar borrar el archivo \"@file\"",
	infoFileDeleted: "Archivo borrado: @file",
	systemListeningHttp: "Escuchando en el puerto @port con protocolo HTTP",
	systemListeningHttps: "Escuchando en el puerto @port con protocolo HTTPS",
	errorServiceInitialized: "El servicio ya ha sido inicializado",
	systemHttpStopped: "Servicio HTTP detenido",
	systemHttpsStopped: "Servicio HTTPS detenido",
	errorInstancesRequired: "Es requerido especificar la configuración de las instancias de servicio web en 'instances.http' o 'instances.https'",
	errorDefaultRouteSlashes: "La propiedad de configuración 'defaultRoute' no debe iniciar con '\\' o '/'",
	errorSessionPathRequired: "Se debe indicar una ruta válida para almacenar las sesiones en 'sessions.path' cuando 'sessions.store' es igual a 'files'",
	errorSessionExpirationNegative: "La propiedad 'sessions.minutesExpiration' debe ser mayor o igual a cero",
	errorPublicPathRequired: "Se debe indicar una ruta válida en 'public.filePath'",
	errorPublicUrlPathSlash: "La propiedad 'public.urlPath' no puede iniciar con '/'",
	systemWebSocketConnected: "WebSocket: Cliente conectado",
	systemRequestReceived: "REQUEST recibido",
	systemResponseSent: "RESPONSE enviado",
	errorNotFoundEvent: "Error al ejecutar el evento 'notFound'",
	errorFunctionExecution: "Ocurrió un error en la ejecución de la función '@functionName'"
}

export const prepareMessage = (text: string, params?: Record<string, string | number | undefined>): string => {
	if (!params) return text
	return text.replace(/\\@|@([a-zA-Z0-9_]+)/g, (match, p1) => {
		if (match === '\\@') return '@'
		return params[p1] !== undefined ? String(params[p1]) : match
	})
}
