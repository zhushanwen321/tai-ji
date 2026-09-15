/**
 * runtime 组合根 watchdog / rolling-restart / idle-reaper / 水位定时器接线守卫
 * （review S-11：组合根接线增量 0/81 覆盖）。
 *
 * 为什么是源码级断言：startWatchdog / startRollingRestart 的 armed 门（Gate W，
 * TAIJI_RUNTIME_WATCHDOG_ARMED 默认 off）在 off 时编排零动作——接线丢失只表现为观测面
 * 静默消失（采样环不跑、status RPC 无数据源、水位数据缺口），进程不报错、行为断言
 * 无通路。守卫沿用源码级先例（crash-journal-composition-root-wiring.test.ts 第 1 层、
 * crash-forensics-logger.test.ts「源码硬保证」段）：index.ts import 即执行 main()，
 * 无法直测，对源文件文本断言符号存在性。
 *
 * 守卫面（crash-forensics-and-watchdog D3-D6 组合根装配）：
 * - startWatchdog：内存看门狗启动（off 时纯观测——采样环必须照跑补全 Gate W 前置水位数据）
 * - watchdog:memoryPressure broadcast：renderer 通知出口 + 同拍喂滚动重启编排（D5 决策输入）
 * - setRollingRestartStatusProvider：rollingRestart.status 只读 RPC 数据源（「broadcast
 *   时序竞争」教训：持续态必须可拉取，renderer 重连后拉取恢复横幅）
 * - startIdleReaper：后台初始化序列 ⑩ 触发的孤儿 pi 收殓闭包（装配 → 传递）
 * - startMemoryWatermarkTimer：水位采样定时器（评估器 watermark-daily 数据源）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/index-composition-root-wiring.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

describe('组合根 watchdog / rolling-restart 接线（源码级守卫）', () => {
  it('看门狗：import startWatchdog 且 main() 内启动；broadcast 出口双投递（renderer + 滚动重启编排）', () => {
    expect(source).toMatch(/import\s*\{[^}]*startWatchdog[^}]*\}\s*from\s*'\.\/infra\/watchdog\.js'/)
    expect(source).toContain('watchdogHandle = startWatchdog({')
    // renderer 通知出口（useMemoryPressure 通道）
    expect(source).toContain("type: 'watchdog:memoryPressure'")
    // 同拍喂滚动重启编排（critical 档 = D5 决策输入；warn 档编排侧忽略）
    expect(source).toContain('rollingRestartHandleLocal.onMemoryPressure(payload)')
  })

  it('滚动重启：import startRollingRestart 且启动；status provider 注入 server（只读 RPC 拉取）', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*startRollingRestart[^}]*\}\s*from\s*'\.\/services\/session\/rolling-restart\.js'/,
    )
    expect(source).toContain('startRollingRestart({')
    expect(source).toContain('server.setRollingRestartStatusProvider(')
  })

  it('armed 门共用：滚动重启 armed 取自 resolveWatchdogConfig 结果（Gate W 单一开关）', () => {
    expect(source).toContain('const watchdogConfig = resolveWatchdogConfig(process.env)')
    expect(source).toContain('armed: watchdogConfig.armed,')
  })

  it('idle reaper：装配闭包先于传递（runStartupBackgroundInit 序列 ⑩ 触发点）', () => {
    const defIdx = source.indexOf('const startIdleReaper = ')
    const handoffIdx = source.indexOf('startIdleReaper,')
    expect(defIdx).toBeGreaterThan(-1)
    expect(handoffIdx).toBeGreaterThan(defIdx)
  })

  it('水位定时器：startMemoryWatermarkTimer 以 session 数 + pi 进程数为采样源启动', () => {
    expect(source).toContain('startMemoryWatermarkTimer(')
  })
})
