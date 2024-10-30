import { rules, validate } from '../src/index'

const original = {
	uno: 'hola',
	dos: 1,
	tres: '67',
	cuatro: {
		aaa: '2024-10-28 23:56:00',
		bbb: 'fgh'
	}
}

const resultados = validate(original, rules({ label: 'Mi número' }).isObject({
	uno: rules({ label: 'Uno', required: true }),
	dos: rules().isBoolean(),
	tres: rules({ required: true }).isNaturalNoZero(),
	cuatro: rules({ label: 'Cuatro', default: {} }).isObject({
		aaa: rules().isDateTime()
	})
}, `Mi número >`))

console.log(original, resultados)