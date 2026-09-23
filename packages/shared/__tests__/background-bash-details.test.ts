/**
 * parseBackgroundBashDetails 单测（对话流系统通知渲染升级 D1/D2）。
 *
 * 覆盖：合法两形态（natural / timeout-exitCode-null）全字段解析 + 防御矩阵——
 * details 非对象形态、必需字段（taskId/command/durationMs/endReason）缺失/空串/类型异常、
 * endReason 非法值（killed / process-exit 等不可达值）、exitCode 类型异常、可空字段缺失归 null。
 *
 * 消费点：ui SystemNotice.vue 的 background-bash 分支（命中 → 结构化行；null → content 原文行，
 * 旧 session 逐字节回到现状渲染）。解析口径与 parseBgNotifyDetails 同款（shared 单点收敛）。
 *
 * 另含 SSOT + 机器守卫组：BackgroundBashDetails 字段镜像（扩展侧 notify.ts ↔ 宿主侧
 * message.ts）的行为断言，见文件尾 describe 注释。
 *
 * 运行：cd packages/shared && npx vitest run __tests__/background-bash-details.test.ts
 */
import { describe, it, expect } from 'vitest'
import { buildNotifyDetails } from '../../../extensions/universal/base-tool-enhance/src/background/notify'
import type { BackgroundTask } from '../../../extensions/universal/base-tool-enhance/src/background/types'
import { parseBackgroundBashDetails } from '../src/message'

/** natural 成功形态（exit 0）。 */
const naturalDetails: Record<string, unknown> = {
  taskId: 'bt-3',
  command: 'pnpm test --workspace extensions',
  durationMs: 192000,
  endReason: 'natural',
  exitCode: 0,
}

describe('parseBackgroundBashDetails 合法输入', () => {
  it('natural：五字段原样解析（exit 0 成功形态）', () => {
    expect(parseBackgroundBashDetails(naturalDetails)).toEqual({
      taskId: 'bt-3',
      command: 'pnpm test --workspace extensions',
      durationMs: 192000,
      endReason: 'natural',
      exitCode: 0,
    })
  })

  it('timeout：exitCode null 正常解析（超时杀进程无退出码）', () => {
    expect(
      parseBackgroundBashDetails({ ...naturalDetails, endReason: 'timeout', exitCode: null }),
    ).toEqual({
      taskId: 'bt-3',
      command: 'pnpm test --workspace extensions',
      durationMs: 192000,
      endReason: 'timeout',
      exitCode: null,
    })
  })

  it('非 0 exitCode 原样透传（成败判色由渲染层按值决定，解析层不改写）', () => {
    const parsed = parseBackgroundBashDetails({ ...naturalDetails, exitCode: 2 })
    expect(parsed?.exitCode).toBe(2)
    expect(parsed?.endReason).toBe('natural')
  })

  it('exitCode 缺失 → 归 null（可空字段缺失非整体拒绝，降级只显命令 + 耗时）', () => {
    const { exitCode: _drop, ...withoutExitCode } = naturalDetails
    const parsed = parseBackgroundBashDetails(withoutExitCode)
    expect(parsed).toEqual({
      taskId: 'bt-3',
      command: 'pnpm test --workspace extensions',
      durationMs: 192000,
      endReason: 'natural',
      exitCode: null,
    })
  })

  it('字段集锁定：只取契约内五字段，多余字段不泄漏', () => {
    const parsed = parseBackgroundBashDetails({
      ...naturalDetails,
      content: '[background-bash] bt-3 finished (exit 0, 3m12s)',
      extra: 'noise',
    })
    expect(Object.keys(parsed as object)).toEqual(['taskId', 'command', 'durationMs', 'endReason', 'exitCode'])
  })
})

describe('parseBackgroundBashDetails 防御矩阵：details 非对象形态 → null', () => {
  it('null / undefined → null', () => {
    expect(parseBackgroundBashDetails(null)).toBeNull()
    expect(parseBackgroundBashDetails(undefined)).toBeNull()
  })

  it('原始类型（string / number / boolean）→ null', () => {
    expect(parseBackgroundBashDetails('[background-bash] bt-3 finished')).toBeNull()
    expect(parseBackgroundBashDetails(42)).toBeNull()
    expect(parseBackgroundBashDetails(true)).toBeNull()
  })

  it('数组 → null（数组是 object，须显式排除）', () => {
    expect(parseBackgroundBashDetails([naturalDetails])).toBeNull()
  })
})

describe('parseBackgroundBashDetails 防御矩阵：必需字段缺失/空串/类型异常 → null', () => {
  it('逐个缺必需字段 → null', () => {
    const { taskId: _t, ...noTaskId } = naturalDetails
    const { command: _c, ...noCommand } = naturalDetails
    const { durationMs: _d, ...noDuration } = naturalDetails
    const { endReason: _e, ...noEndReason } = naturalDetails
    expect(parseBackgroundBashDetails(noTaskId)).toBeNull()
    expect(parseBackgroundBashDetails(noCommand)).toBeNull()
    expect(parseBackgroundBashDetails(noDuration)).toBeNull()
    expect(parseBackgroundBashDetails(noEndReason)).toBeNull()
  })

  it('必需字段类型异常 → null', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, taskId: 3 })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, command: null })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, durationMs: '192000' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: true })).toBeNull()
  })

  it('taskId / command 为空串 → null（空串视为缺失，与 parseBgNotifyDetails 同款语义）', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, taskId: '' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, command: '' })).toBeNull()
  })

  it('endReason 非法值 → null（killed / process-exit 不可达值不落 schema）', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: 'killed' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: 'process-exit' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: 'completed' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: null })).toBeNull()
  })
})

describe('parseBackgroundBashDetails 防御矩阵：exitCode 类型异常 → 整体拒绝', () => {
  it('exitCode 非 number/null → null（可空字段同样不静默吞类型异常）', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: '0' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: false })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: { code: 0 } })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: [0] })).toBeNull()
  })
})

// ── SSOT + 机器守卫：BackgroundBashDetails 字段镜像（扩展侧 notify.ts ↔ 宿主侧 message.ts）──
//
// 镜像两端（注释级手工镜像，两侧注释均声明「改动须同步另一侧」，本组用例把该纪律机器化）：
// - 扩展侧权威（生产方）：extensions/universal/base-tool-enhance/src/background/notify.ts
//   · BackgroundBashDetails 接口 + buildNotifyDetails（details 载荷唯一产出点）
// - 宿主侧镜像（消费方）：packages/shared/src/message.ts
//   · BackgroundBashEndReason 别名 + BackgroundBashDetails 接口 + parseBackgroundBashDetails
//
// 守卫形态 = 行为断言（不再做源码文本正则解析）：测试进程直接 import 生产端
// buildNotifyDetails，把真实产出喂给宿主解析器，逐项断言 D1 声明的三处对齐面
// 「字段名、可空性、枚举值」。生产端一旦改产出（字段增删/改名/换枚举）本组即红——
// 「生产端接口未漂移」由此锁定；对实现形态（多行化、类型别名、return 对象写法）零耦合，
// 不会再因排版变化误报。跨包 import 只发生在测试进程：生产代码两端仍物理独立
// （extensions 是独立 npm 包，不依赖 @taiji/shared，反向亦不可 import）。

/** D1 契约字段序列（生产端产出序 = 宿主解析产出序）。 */
const MIRROR_FIELD_SEQUENCE = ['taskId', 'command', 'durationMs', 'endReason', 'exitCode'] as const

/** 生产端入参（BackgroundTask）夹具：本镜像面只用到的字段，其余补足必填占位。 */
function buildTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: 'bt-3',
    pid: 4242,
    command: 'pnpm test --workspace extensions',
    outputFile: '/tmp/bt-3.log',
    registryPath: '/tmp/base-tool-enhance/s-1/registry.json',
    startedAt: 0,
    state: 'exited',
    ownerPiPid: 4241,
    sessionId: 's-1',
    durationMs: 192000,
    exitCode: 0,
    reason: 'natural',
    ...overrides,
  }
}

describe('BackgroundBashDetails 字段镜像守卫（notify.ts ↔ message.ts，SSOT + 机器守卫）', () => {
  it('字段名序列逐项相等：生产端产出 ↔ 宿主侧解析产出 ↔ D1 契约序', () => {
    const produced = buildNotifyDetails(buildTask())
    expect(Object.keys(produced)).toEqual([...MIRROR_FIELD_SEQUENCE])

    const parsed = parseBackgroundBashDetails({ ...produced })
    expect(parsed).not.toBeNull()
    expect(Object.keys(parsed as object)).toEqual([...MIRROR_FIELD_SEQUENCE])
  })

  it('枚举值对齐：生产端只产 natural | timeout，宿主解析器逐值接受', () => {
    const produced = [
      buildNotifyDetails(buildTask({ reason: 'natural', exitCode: 0 })),
      buildNotifyDetails(buildTask({ reason: 'timeout', exitCode: null })),
    ]
    expect(produced.map((d) => d.endReason)).toEqual(['natural', 'timeout'])
    for (const details of produced) {
      expect(parseBackgroundBashDetails({ ...details })?.endReason).toBe(details.endReason)
    }
  })

  it('枚举收敛锁定：契约不可达值 killed / process-exit 逐值拒绝（双端注释声明一致）', () => {
    const produced = buildNotifyDetails(buildTask())
    for (const unreachable of ['killed', 'process-exit']) {
      expect(parseBackgroundBashDetails({ ...produced, endReason: unreachable })).toBeNull()
    }
  })

  it('exitCode 可空性两侧对齐：自然退出产 number、timeout 产 null，宿主解析往返一致', () => {
    const natural = buildNotifyDetails(buildTask({ reason: 'natural', exitCode: 0 }))
    const timeout = buildNotifyDetails(buildTask({ reason: 'timeout', exitCode: null }))
    expect(natural.exitCode).toBe(0)
    expect(timeout.exitCode).toBeNull()
    expect(parseBackgroundBashDetails({ ...natural })?.exitCode).toBe(0)
    expect(parseBackgroundBashDetails({ ...timeout })?.exitCode).toBeNull()
  })

  it('产出完整性：生产端产出经宿主解析后字段集无增无减（漏字段即红）', () => {
    const natural = buildNotifyDetails(buildTask())
    expect(parseBackgroundBashDetails({ ...natural })).toEqual({ ...natural })
  })
})
