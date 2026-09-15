import { defineConfig } from 'vitest/config'

// main 进程纯函数测试。
// main/ 不在 workspace 包内（非 renderer/runtime/shared），但 vitest 已 hoist 到根 node_modules，
// @taiji/shared 经 workspace symlink 解析。仅测无 electron 运行时依赖的纯函数。
//
// 分池（形态对齐 packages/runtime/vitest.config.ts 的 projects 先例；vitest 4 调度契约：
// groups 之间严格串行，先主组后尾组）：
// - guarded：crash-resilience u5a 起的新增真实文件 IO 测试（logs/__tests__/），挂全套
//   fs-guard 防线（仓规测试红线：破坏性 fs 只落白名单 tmp，真实 ~/.taiji 无条件拒绝）。
//   guard 三件套自包含复制自 runtime/test/（main 非 workspace 包，跨包相对引用测试基建太脆）。
// - legacy：存量 40+ 测试文件。**有意不挂 fs-guard**：挂载后暴露存量用例自身的设计缺陷
//   （如 update-self-healer.test.ts 在 vitest 环境经 getOldBackupPath 的
//   dirname×3(process.execPath) 推导出真实 ~/.nvm/versions/node.old 并 rmSync——guard
//   正确拦截但该用例需 mock execPath 才能修，文件在 u5a 领地外，缺陷已上报主 agent）。
//   存量池接入 guard 是独立单元的工作，不在本配置内打折处理。
// globalSetup（root 级，对所有池生效）：TAIJI_AGENT_DATA_DIR 指向 tmp + 真实数据目录
// fail-fast（[HISTORICAL] 2026-09-02 会话丢失事故第一层防线，对齐 runtime 形态）。
export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    globalSetup: ['./test/global-setup.ts'],
    projects: [
      {
        test: {
          name: 'guarded',
          // images/__tests__/：crash-resilience u7 图片缓存生命周期（真实文件 IO，同挂
          // fs-guard；cache/images 夹具全部 mkdtemp tmpdir 自建自删）
          // diagnostics/__tests__/：crash-forensics u3a 诊断包导出（真实 zip 落盘，同挂
          // fs-guard；夹具 mkdtemp tmpdir 自建自删）
          include: [
            'logs/__tests__/**/*.test.ts',
            'images/__tests__/**/*.test.ts',
            'diagnostics/__tests__/**/*.test.ts',
          ],
          setupFiles: ['./test/fs-guard.ts'],
        },
      },
      {
        test: {
          name: 'legacy',
          // update/__tests__/ 是存量 update 模块测试（原 include 第二个 glob 的匹配面），
          // 与 guarded 的 logs/__tests__ 前缀精确互斥，防同文件跨池重复收集。
          // ../scripts/__tests__：dev-instance-lib 纯函数层（MF-8，C-build-08 装配器可测层），
          // 同样无 electron 运行时依赖，随 main 纯函数测试一起跑（dev-0.9.19 合并并入）。
          include: ['test/**/*.test.ts', 'update/__tests__/**/*.test.ts', '../scripts/__tests__/**/*.test.mjs'],
        },
      },
    ],
  },
})
