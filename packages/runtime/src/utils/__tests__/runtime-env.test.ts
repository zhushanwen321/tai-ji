/**
 * runtime-env 契约函数测试：spawnDataDirContractViolation（缺省反转护栏）。
 *
 * 契约语义：TAIJI_AGENT_PACKAGED=1（打包态 runtime）必带 TAIJI_AGENT_DATA_DIR
 * （main 经 process-control 成对注入）；违反 = spawn 契约破损 → 组合根 fail-fast。
 * 纯函数直测（只喂 env、断言返回值），组合根接线（打印 + exit）在 index.ts，
 * 由「断言块位于 initLogger 之前」的时序语义保证（见 index.ts 注释）。
 *
 * 运行：cd packages/runtime && npx vitest run src/utils/__tests__/runtime-env.test.ts
 */
import { describe, expect, it } from 'vitest'
import { spawnDataDirContractViolation } from '../runtime-env.js'

describe('spawnDataDirContractViolation（spawn 数据目录契约校验）', () => {
  it('打包态 + 缺 DATA_DIR → 违规（含 cause 与 recovery 行，错误可操作）', () => {
    const violation = spawnDataDirContractViolation({ TAIJI_AGENT_PACKAGED: '1' })
    expect(violation).not.toBeNull()
    const text = violation!.join('\n')
    expect(text).toContain('TAIJI_AGENT_PACKAGED=1')
    expect(text).toContain('resolvePackagedDataDir')
    expect(text).toContain('process-control.ts')
  })

  it('打包态 + 空 DATA_DIR → 同样违规（空串非有效注入）', () => {
    expect(spawnDataDirContractViolation({ TAIJI_AGENT_PACKAGED: '1', TAIJI_AGENT_DATA_DIR: '' })).not.toBeNull()
  })

  it('打包态 + 显式 DATA_DIR → 合规（正常 prod 形态）', () => {
    expect(
      spawnDataDirContractViolation({ TAIJI_AGENT_PACKAGED: '1', TAIJI_AGENT_DATA_DIR: '/home/u/.taiji' }),
    ).toBeNull()
  })

  it('非打包态（裸跑/验证脚本，无 PACKAGED 标志）→ 合规：走缺省落 dev 树不适用本契约', () => {
    expect(spawnDataDirContractViolation({})).toBeNull()
  })

  it('PACKAGED 非 "1" 值（0/true）→ 非打包态，合规', () => {
    expect(spawnDataDirContractViolation({ TAIJI_AGENT_PACKAGED: '0' })).toBeNull()
    expect(spawnDataDirContractViolation({ TAIJI_AGENT_PACKAGED: 'true' })).toBeNull()
  })
})
