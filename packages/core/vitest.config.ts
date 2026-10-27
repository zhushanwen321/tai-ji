import { defaultExclude } from 'vitest/config'
import { taijiTestConfig, guardProjectSetup } from '../../test-guard/factory.ts'
import { loadZeroMockPool } from '../../test-guard/zero-mock-pool.ts'

// core 是平台无关内核（headless），真零 DOM（ADR-0058：composer/input DOM 逻辑已迁 @taiji/dom-core）。
// 测试用 node 环境跑纯逻辑编排（bootstrap 时序/ES1 中断）。
// 无 vue plugin、无 happy-dom、无 coverage threshold（P0 骨架阶段，覆盖率随 P3 域迁移滚动校准）。
//
// 双池维护契约（shared 零特征共享池 + isolated 隔离池，完整契约见 packages/subagent-core/
// vitest.config.ts 文件头同款）：shared = 静态零特征文件 isolate:false（实证 1.55x，
// .tmp/round6/process-reuse-reeval.md §3.4；清单唯一来源 = docs/testing/zero-mock-pool.json，
// 检查 = scripts/check-zero-mock-pool.mjs）；isolated = 特征/门控/出场文件，每文件新进程。
// core 特有的动态出场实例：settings-store.test.ts（共享池实跑唯一红例——前序零特征文件
// 经正常 API 调用注入模块级单例 transport，静态扫描原理性漏判，见登记表 dynamicExclusions）。
const shared = loadZeroMockPool(__dirname, 'core')

export default taijiTestConfig({
  test: {
    projects: [
      {
        // 零特征共享池：模块图/进程跨文件复用；清单来自登记表（禁手抄）
        test: guardProjectSetup({
          name: 'shared',
          include: shared,
          isolate: false,
          environment: 'node',
        }),
      },
      {
        // 隔离池：特征/门控/出场文件，每文件新进程（分池前行为）；不声明 include =
        // 沿用 vitest 默认收集范围（分池前同款），仅排除共享池成员
        test: guardProjectSetup({
          name: 'isolated',
          exclude: [...defaultExclude, ...shared],
          environment: 'node',
          sequence: { groupOrder: 1 },
        }),
      },
    ],
  },
})
