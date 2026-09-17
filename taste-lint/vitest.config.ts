import { fileURLToPath } from 'node:url'
import { taijiTestConfig } from '../test-guard/factory.ts'

// taste-lint 规则用例专用 vitest 配置。根 vitest.config.ts 把 taste-lint/** 收进
// exclude（独立工具链，全仓跑测不误扫），因此根 cwd 直接 `vitest run taste-lint`
// 收集不到任何文件（CI 曾实发 "No test files found"）——本 config + 根 package.json
// 的 test:taste-lint script 是 taste-lint 用例的唯一执行入口（ci.yml lint job 引用），
// 目标非空由 scripts/check-ci-vitest-targets.mjs（G2）守卫。
//
// root 钉在本目录：include 以 config 所在目录为基准解析，无论从仓库根（--config
// 指入）还是从 taste-lint/ 目录直接跑，收集面一致，不依赖 cwd。规则用例经
// import.meta.url 自定位仓库根（不依赖 cwd），root 切换不影响其被测根解析。
export default taijiTestConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['rules/*.test.mjs', 'lib/*.test.mjs'],
  },
})
