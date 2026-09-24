import { taijiTestConfig, FS_GUARD_PATH, GLOBAL_SETUP_PATH } from '../../../test-guard/factory.ts'

// main 进程纯函数测试。
// main/ 不在 workspace 包内（非 renderer/runtime/shared），但 vitest 已 hoist 到根 node_modules，
// @taiji/shared 经 workspace symlink 解析。仅测无 electron 运行时依赖的纯函数。
//
// 防线（[HISTORICAL] 2026-09-02 会话丢失事故双层防线；2026-09-16 起上收仓库根 test-guard/
// factory 统一注入，main/test/ 下的自包含副本已删除）：globalSetup（root 级，对所有池生效）
// = TAIJI_AGENT_DATA_DIR 钉 tmp + 真实数据目录白名单 fail-fast；fs-guard 切面仅 guarded 池
// 显式挂载（projects 内 setupFiles 不继承 root 级，见 runtime/vitest.config.ts 同款注释）。
//
// 分池（形态对齐 packages/runtime/vitest.config.ts 的 projects 先例；vitest 4 调度契约：
// groups 之间严格串行，先主组后尾组）：
// - guarded：u5a 起的新增真实文件 IO 测试（logs/__tests__/），挂全套
//   fs-guard 防线（仓规测试红线：破坏性 fs 只落白名单 tmp，真实 ~/.taiji 无条件拒绝）。
// - legacy：存量 40+ 测试文件。**有意不挂 fs-guard**：挂载后暴露存量用例自身的设计缺陷
//   （如 update-self-healer.test.ts 在 vitest 环境经 getOldBackupPath 的
//   dirname×3(process.execPath) 推导出真实 ~/.nvm/versions/node.old 并 rmSync——guard
//   正确拦截但该用例需 mock execPath 才能修，文件在 u5a 领地外，缺陷已上报主 agent）。
//   存量池接入 guard 是独立单元的工作，不在本配置内打折处理；globalSetup 层（env 钉死 +
//   真实数据目录 fail-fast）对 legacy 池仍生效。
export default taijiTestConfig({
  test: {
    globalSetup: [GLOBAL_SETUP_PATH],
    projects: [
      {
        test: {
          name: 'guarded',
          // images/__tests__/：u7 图片缓存生命周期（真实文件 IO，同挂
          // fs-guard；cache/images 夹具全部 mkdtemp tmpdir 自建自删）
          // diagnostics/__tests__/：crash-forensics u3a 诊断包导出（真实 zip 落盘，同挂
          // fs-guard；夹具 mkdtemp tmpdir 自建自删）
          include: [
            'logs/__tests__/**/*.test.ts',
            'images/__tests__/**/*.test.ts',
            'diagnostics/__tests__/**/*.test.ts',
            // main-run-state：真实文件 IO（run-state marker/checkpoint 写盘）+ mock 驱动
            // main.ts 真实 import 链（app.isPackaged=true 会执行打包 pin 分支改写
            // TAIJI_AGENT_DATA_DIR）——写通路必须在 fs-guard 拦截面内
            // （[HISTORICAL] 2026-09-23 污染事故：legacy 池无拦截面，pin 改写 env 后
            // marker 落进真实 ~/.taiji）。
            'test/main-run-state.test.ts',
          ],
          setupFiles: [FS_GUARD_PATH],
        },
      },
      {
        test: {
          name: 'legacy',
          // update/__tests__/ 是存量 update 模块测试（原 include 第二个 glob 的匹配面），
          // 与 guarded 的 logs/__tests__ 前缀精确互斥，防同文件跨池重复收集。
          // ../scripts/__tests__：dev-instance-lib 纯函数层（MF-8，C-build-08 装配器可测层），
          // 同样无 electron 运行时依赖，随 main 纯函数测试一起跑（dev-0.9.19 合并并入）。
          include: [
            'test/**/*.test.ts',
            '!test/main-run-state.test.ts',
            'update/__tests__/**/*.test.ts',
            '../scripts/__tests__/**/*.test.mjs',
          ],
        },
      },
    ],
  },
})
