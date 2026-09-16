import path from "node:path";
import { fileURLToPath } from "node:url";

import { taijiTestConfig } from "../../../test-guard/factory.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default taijiTestConfig({
  test: {
    reporters: ["default", "junit"],
    outputFile: { junit: "./test-results/vitest-junit.xml" },
    include: ["src/__tests__/**/*.test.ts"],
    root: __dirname,
  },
});
