import { taijiTestConfig } from "../../../test-guard/factory.ts"

export default taijiTestConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
	},
	build: {
		target: "es2022",
	},
	esbuild: {
		target: "es2022",
	},
});
