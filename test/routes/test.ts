import { PRoute } from "../../src"

export default class extends PRoute {
	async $index() {
		return 'holi!'
	}
}