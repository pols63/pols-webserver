import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
	{
		files: ["**/*.{ts}"],
	},
	{ languageOptions: { globals: globals.node } },
	pluginJs.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			"@typescript-eslint/no-unused-vars": "warn",
			"@typescript-eslint/no-explicit-any": false,
			"no-use-before-define": "off"
		}
	}
];