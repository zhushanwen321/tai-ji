import { taijiTestConfig } from '../../test-guard/factory.ts'

// 防线经仓库根 test-guard/factory 统一注入（taijiTestConfig），[HISTORICAL]
// 2026-09-02 会话丢失事故双层防线 + 2026-09-16 prod 数据目录删除事故升级为仓库级强制。
export default taijiTestConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
