import { taijiTestConfig } from "../../../test-guard/factory.ts"

export default taijiTestConfig({
  test: {
    reporters: ["default", "junit"],
    outputFile: { junit: "./test-results/vitest-junit.xml" },
    // A11/A12 验收测试（fullName 含验收 id，cw verify 按 id 匹配）
    include: ["src/__tests__/**/*.test.ts"],
  },
});
