import path from "node:path";
import { fileURLToPath } from "node:url";

import { taijiTestConfig } from "../../../test-guard/factory.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default taijiTestConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
		root: __dirname,
	},
	resolve: {
		alias: {
			// typebox 在测试环境用 mock（与 workflow extension 一致），真实类型由 Pi 运行时提供
			"typebox": path.resolve(__dirname, "mocks/typebox.ts"),
		},
	},
});
