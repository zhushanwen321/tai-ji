import { taijiTestConfig } from "../../../test-guard/factory.ts"

export default taijiTestConfig({
  test: {
    // A11/A12 验收测试（fullName 含验收 id，cw verify 按 id 匹配）
    include: ["src/__tests__/**/*.test.ts"],
  },
});
