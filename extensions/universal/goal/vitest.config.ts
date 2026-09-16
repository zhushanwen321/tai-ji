import path from "node:path";

import { taijiTestConfig } from "../../../test-guard/factory.ts"

const piStub = path.resolve(__dirname, "src/__tests__/stubs/pi-sdk.ts");

export default taijiTestConfig({
	test: {
		reporters: ["default", "junit"],
		outputFile: { junit: "./test-results/vitest-junit.xml" },
		include: ["src/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"@earendil-works/pi-coding-agent": piStub,
			"@earendil-works/pi-ai": piStub,
			"@earendil-works/pi-tui": piStub,
		},
	},
});
