import { defaultExclude } from 'vitest/config'
import { taijiTestConfig, FS_GUARD_PATH } from '../../test-guard/factory.ts'

/**
 * [HISTORICAL] 2026-08-20 PR #185 pre-merge 三连 FAIL 根因与分池方案：
 * 真实 pi equivalence 用例（spawn 真实 `pi --mode rpc` 子进程 + 真实 LLM API 轮次）在
 * 305 文件满并行 vitest 下被饿死——单跑 15.8s 的用例满并行下 301s 顶满超时（19 倍差距，
 * 事件流证明 LLM 轮次在推进、非死锁），连续三次放宽 timeout 无效，改为分池结构性隔离。
 *
 * vitest 4.1.9 调度契约（权威源 node_modules/vitest/dist/chunks/cli-api.24X8XwN1.js groupSpecs()）：
 * - `fileParallelism: false` 在配置解析层强制 `maxWorkers = 1`；`maxWorkers === 1` + 默认
 *   isolate/groupOrder 的文件进入 sequential 尾组（groups.push(sequential) 排在最后）。
 * - task groups 之间 `for...of` + `await Promise.allSettled` 严格串行：主组（main）满并行
 *   **完整结束、worker 全部释放后**，real-pi 文件才逐个以单 worker 执行——零时间重叠。
 * - `poolOptions.forks.singleFork`（vitest 2/3 形态）在 vitest 4 已移除，勿再使用。
 *
 * 入口命令不变（`npx vitest run` / scripts/pr-pre-merge.sh 不改）；分组只影响调度，不影响
 * 跑哪些用例；TAIJI_SKIP_REAL_PI=1 口径不变——real-pi 组内 describe.skipIf 照常跳过。
 *
 * 维护契约：新增「真实 pi + 真实 LLM turn」的 equivalence 测试时，文件路径必须同步加入
 * REAL_PI_TESTS（漏加会落回 main 满并行组，复发饿死超时）；纯 mock / fixture 重放用例不加。
 * faux LLM 轨用例（spawnPiFixture 传 fauxResponses：真 pi 进程 + 真 extension 加载 + 假 LLM，
 * 门控 FAUX_PI_READY）属 main 满并行组，**勿加入本池**——本池的存在理由是真实 LLM 轮次的
 * 长等待窗口在 CPU 饱和下饿死（19 倍差距），faux 轮次是毫秒级本地计算、零网络，该模式结构
 * 性不存在（首批实测：thinking-level 294ms / live-reload 793ms / chaos 306ms）。
 * L2.5 首批（chaos / live-reload / thinking-level-effective-e2e）与二批（attach-lifecycle /
 * broadcast-getstate / completion-backflow / pi-protocol-contract / send-queue-e2e /
 * session-manager-full-e2e / tool-call-index / usage-queue-commands-invalidation /
 * pi-semantics-skill-expansion-golden / idle-pi-reclaim-integration）均已翻轨回 main 组。
 *
 * 防线（globalSetup env 钉死 + fs-guard 切面）经 test-guard/factory 顶层注入；
 * projects 内 setupFiles **不**继承 root 级（vitest projects 语义，实测 setup 0ms 不执行），
 * 故各 project 显式挂 FS_GUARD_PATH（globalSetup 无此问题，root 级对所有 project 生效）。
 */
const REAL_PI_TESTS = [
  // L2.5 二批（2026-09-15）后当前为空：全部「真实 pi + 真实 LLM turn」equivalence 用例已
  // 翻轨 faux（见上方维护契约）。数组保留为注册位——新增真实 LLM 轨文件必须登记于此
  // （守卫 session-manager-e2e-fixture-unit.test.ts 双向 diff；scalar-state-invalidation
  // 的真实轨 describe 已于 2026-09 测试舰队审查删除，纯 mock 文件的过期登记已清）。
] as const

export default taijiTestConfig({
  test: {
    // cw 验收标记行 reporter：e2e-mock 型验收（如 trace-runtime A31）要求 stdout 含
    // `<验收id> PASS|FAIL` 标记行；--reporter=json 时自静默（vitest 型验收 stdout 须纯 JSON）。
    // root 级 reporters 对 projects 分池（main/real-pi 两组）的所有测试输出生效。
    reporters: ['default', './test/cw-acceptance-markers-reporter.ts', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    projects: [
      {
        // 主组：除真实 pi 用例外的全部测试，保持默认满并行（与分池前行为一致）
        test: {
          name: 'main',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [...defaultExclude, ...REAL_PI_TESTS],
          setupFiles: [FS_GUARD_PATH],
        },
      },
      {
        // 真实 pi 组：文件间串行（maxWorkers 解析为 1），且在主组完整结束后才开跑（见文件头调度契约）
        test: {
          name: 'real-pi',
          include: [...REAL_PI_TESTS],
          fileParallelism: false,
          setupFiles: [FS_GUARD_PATH],
        },
      },
    ],
  },
})
