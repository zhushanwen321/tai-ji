/**
 * pi 环境探测与常量（equivalence 测试族共用底层，零测试逻辑）。
 *
 * 为什么独立成文件：pi-fixture.ts（faux 轨主模块）按需动态 import real-pi-gate.ts
 * （real 轨门控），而 real-pi-gate 又需要 PI_PATH / DEFAULT_MODEL——两者互相引用构成
 * 循环依赖（metrics-gate circular-dependency 门禁拦截）。把 binary 探测与模型常量下沉
 * 到本叶子模块后，依赖方向恒为 pi-fixture → 本模块 ← real-pi-gate，环消除。
 *
 * 探测语义与拆出前逐字节一致（来源 pi-fixture.ts 原实现）：
 * - PI_PATH = which/where pi 探测，命令形态与生产代码 src/infra/pi/process-manager.ts
 *   （isWindows ? 'where pi' : 'which pi'）完全一致；探测失败返回 null。
 * - DEFAULT_MODEL = 低成本测试模型（workspace AGENTS.md pi 实测流程同款，验收契约锁定）。
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 低成本测试模型（workspace AGENTS.md pi 实测流程同款，验收契约锁定）。导出供附着恢复用例做 CLI-model 对照断言。 */
export const DEFAULT_MODEL = 'xiaomi-token-plan-cn/mimo-v2.6-flash'

/** 探测 pi 可执行文件路径（命令形态与生产 process-manager.ts 一致；失败返回 null）。
 * 导出供按需重探测场景消费（PI_PATH 是模块加载期一次性快照）；
 * 拆出自 pi-fixture 属循环依赖解环的载体搬移，非新增能力。 */
export function detectPi(): string | null { // oe-exempt:20260929:wip:循环依赖解环保形搬移（pi-fixture ↔ real-pi-gate 环消除的叶子模块），导出与拆出前形态一致
  const isWindows = process.platform === 'win32'
  const whichCmd = isWindows ? 'where pi' : 'which pi'
  try {
    const which = execSync(whichCmd, { encoding: 'utf-8' }).trim()
    // Windows 'where' 可能返回多行，取第一条（与生产逻辑一致）
    const firstMatch = which.split('\n')[0]?.trim()
    if (firstMatch && existsSync(firstMatch)) return firstMatch
    return null
  } catch {
    // expected: pi not in PATH —— 进入 skip 语义
    return null
  }
}

/** 模块顶层探测结果（skip-if-no-pi 契约的唯一引用点；pi-fixture 的 FAUX 门控与 real-pi-gate 消费） */
export const PI_PATH: string | null = detectPi()
