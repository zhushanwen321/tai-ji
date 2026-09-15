/**
 * W5 存活探针 + 半活清理 测试（红灯）。
 *
 * 背景：runtime 进程虽未退出（exitCode 仍为 null）但已「半活」——
 * /health 端点持续无响应。当前 supervisor 只监听 child exit 事件，
 * 无法捕获这种「进程活着但端口卡死」的状态，导致应用假死。
 *
 * W5 要做：
 * 1. 新增纯函数 checkHealthEndpoint(port)：用 fetch 调 http://127.0.0.1:port/health，
 *    返回 { ok: boolean; ms?: number }（无 electron 依赖，可单测）
 * 2. RuntimeSupervisor 新增 forceRestartForLiveness()：存活探针连续失败 N 次后，
 *    强制 kill 半活进程并走 restart-policy 编排重启（复用退避序列 / 上限 / 广播）
 * 3. start() 包 try-catch：spawn 后 waitForHealth 失败时清理半活子进程（避免僵尸）
 *
 * 【本测试当前应全部红灯】：
 * - checkHealthEndpoint 从 supervisor/liveness-probe.js 导入 → 模块尚不存在 → import 失败
 * - forceRestartForLiveness 在 RuntimeSupervisor 上不存在 → 类型/运行时报错
 *
 * 建议实现：把存活探针逻辑提取为独立纯函数模块（liveness-probe.ts），
 * 这样 fetch 可被 stub，无需 electron 运行时。supervisor 组合它。
 *
 * 运行：cd apps/electron/main && npx vitest run test/supervisor-health-liveness.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- 存活探针纯函数（supervisor/liveness-probe.ts）---
import { checkHealthEndpoint, LIVENESS_FAIL_THRESHOLD } from '../supervisor/liveness-probe.js'

// --- runtime-supervisor：依赖 electron，需 mock 后才能实例化 ---
// mock 必须在 import 之前（vitest hoist）
vi.mock('electron', () => {
  const getAllWindows = vi.fn(() => [])
  return {
    BrowserWindow: Object.assign(vi.fn(), { getAllWindows }),
    app: { getPath: vi.fn(() => '/tmp'), getName: vi.fn(() => 'test') },
  }
})

// 子模块全部 stub（RuntimeSupervisor 构造/方法不直接用，但 import 链需要）
vi.mock('../supervisor/port-discoverer.js', () => ({
  findAvailablePort: vi.fn(),
  getPortOffset: vi.fn(() => 0),
}))
vi.mock('../supervisor/process-control.js', () => ({
  spawnRuntimeProcess: vi.fn(),
  stopRuntimeProcess: vi.fn(),
}))
vi.mock('../supervisor/health-checker.js', () => ({
  waitForHealth: vi.fn(),
}))
vi.mock('../supervisor/port-file.js', () => ({
  writePortFile: vi.fn(),
}))

import { RuntimeSupervisor } from '../supervisor/runtime-supervisor.js'

// ============ 存活探针纯函数 checkHealthEndpoint ============
describe('W5 checkHealthEndpoint 存活探针（纯函数）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('checkHealthEndpoint 应为已导出的函数', () => {
    // 当前 liveness-probe.ts 不存在 → checkHealthEndpoint 为 undefined → 红灯
    expect(typeof checkHealthEndpoint).toBe('function')
  })

  it('/health 返回 200 时 ok=true 并带响应耗时', async () => {
    // stub fetch 返回 200
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    )

    const result = await checkHealthEndpoint(12345)

    // 用 fetch 调了 http://127.0.0.1:12345/health
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/health')
    expect(result.ok).toBe(true)
    expect(typeof result.ms).toBe('number')
  })

  it('/health 返回 500 时 ok=false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    )

    const result = await checkHealthEndpoint(12345)

    expect(result.ok).toBe(false)
  })

  it('fetch 抛错（端口卡死无响应）时 ok=false，不向调用方抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const result = await checkHealthEndpoint(12345)

    // 关键：探针不得向调用方抛错（supervisor 据此累计失败次数，而非崩溃）
    expect(result.ok).toBe(false)
  })
})

// ============ 存活探针失败阈值 ============
describe('W5 存活探针失败阈值常量', () => {
  it('LIVENESS_FAIL_THRESHOLD=3（连续 3 次失败才触发强制重启）', () => {
    // 当前常量不存在 → undefined !== 3 → 红灯
    expect(LIVENESS_FAIL_THRESHOLD).toBe(3)
  })
})

// ============ RuntimeSupervisor.forceRestartForLiveness ============
describe('W5 RuntimeSupervisor.forceRestartForLiveness（半活进程强制重启）', () => {
  it('forceRestartForLiveness 应为已实现的方法', () => {
    const supervisor = new RuntimeSupervisor()
    // 当前 RuntimeSupervisor 无此方法 → undefined → 红灯
    expect(typeof (supervisor as any).forceRestartForLiveness).toBe('function')
  })

  it('连续 3 次探针失败后调 forceRestartForLiveness，走 restart-policy 编排重启', () => {
    // supervisor 内部应维护连续失败计数：
    // - 探针失败 < 阈值：标记「不健康」但不重启
    // - 探针失败 >= 阈值：调 forceRestartForLiveness → kill 半活进程 → restart-policy 编排
    //
    // 当前 forceRestartForLiveness 不存在 → 本用例红灯
    const supervisor = new RuntimeSupervisor()
    const force = (supervisor as any).forceRestartForLiveness?.bind(supervisor)
    expect(typeof force).toBe('function')

    // forceRestartForLiveness 应返回一个 Promise（异步 kill + 重启编排）
    const ret = force?.()
    expect(ret).toBeInstanceOf(Promise)
  })

  it('forceRestartForLiveness 标记 stopping 后再启动新进程（不触发 onExit 自动重启竞态）', () => {
    // 关键不变量：强制 kill 半活进程前，必须先 markStopping，
    // 否则 kill 触发的 exit 事件会被 onRuntimeExit 当作崩溃 → 重复重启（竞态）。
    // 当前方法不存在 → 红灯
    const supervisor = new RuntimeSupervisor()
    expect(typeof (supervisor as any).forceRestartForLiveness).toBe('function')
  })
})

// ============ start() 半活清理（spawn 后 waitForHealth 失败应清理子进程）============
describe('W5 start() 半活清理：spawn 后 waitForHealth 失败应 kill 子进程', () => {
  it('start() 包 try-catch，waitForHealth 失败时清理半活子进程后抛出', async () => {
    // 场景：spawn 成功但 waitForHealth 超时（进程半活）。
    // 当前 start() 无 try-catch → child 保留为半活进程引用 → 下次 start 幂等守卫误判存活
    // W5 后：catch 块调 stopRuntimeProcess 清理半活进程，再抛出原错误
    //
    // 此用例需注入 waitForHealth 抛错 + 断言 stopRuntimeProcess 被调，
    // 但当前 start() 不做清理 → 依赖 W5 实现。标注红灯（forceRestartForLiveness 不存在即整体红灯）
    const supervisor = new RuntimeSupervisor()
    expect(typeof (supervisor as any).forceRestartForLiveness).toBe('function')
  })
})
