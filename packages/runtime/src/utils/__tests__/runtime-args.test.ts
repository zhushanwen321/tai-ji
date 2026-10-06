/**
 * runtime 组合根 argv 解析单测（utils/runtime-args.ts，code-harden P2 自 index.ts 提取）：
 * 1. 双形态（空格 / `=`）：各 flag 两形态解析等价；
 * 2. `=` 形态**按首个 = 切分**：路径含 `=` 不截断（旧 split('=')[1] 写法的修复点）；
 * 3. 非法 --port 值 throw（组合根包装 console.error + exit(1)，退出决策不进本模块）；
 * 4. TAIJI_AGENT_PORT_OFFSET env 偏移与上界钳制；
 * 5. --remote-access 布尔 flag 出现即开（remote-access D9）；
 * 6. 未知 flag / 已知带值 flag 缺值 → warn 提示且解析结果不受影响（code-harden P2 兜底，
 *    忽略语义保持不 throw）。
 *
 * 运行：cd packages/runtime && npx vitest run src/utils/__tests__/runtime-args.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BASE_PORT, MAX_PORT } from '@taiji/shared'
import { parseRuntimeArgs } from '../runtime-args.js'

describe('parseRuntimeArgs（组合根 argv 解析）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('空 argv → 缺省：port = BASE_PORT（env 无偏移），其余字段缺省，remoteAccess=false', () => {
    expect(parseRuntimeArgs([])).toEqual({
      port: BASE_PORT,
      projectRoot: undefined,
      builtinPluginsDir: undefined,
      remoteAccess: false,
      mobileDist: undefined,
    })
  })

  it('空格形态：--port / --project-root / --builtin-plugins-dir / --mobile-dist / --remote-access', () => {
    const args = parseRuntimeArgs([
      '--port', '4000',
      '--project-root', '/tmp/proj',
      '--builtin-plugins-dir', '/tmp/plugins',
      '--remote-access',
      '--mobile-dist', '/tmp/mobile',
    ])
    expect(args).toEqual({
      port: 4000,
      projectRoot: '/tmp/proj',
      builtinPluginsDir: '/tmp/plugins',
      remoteAccess: true,
      mobileDist: '/tmp/mobile',
    })
  })

  it('等号形态：各 --flag=value 解析与空格形态等价', () => {
    const args = parseRuntimeArgs([
      '--port=4001',
      '--project-root=/tmp/proj',
      '--builtin-plugins-dir=/tmp/plugins',
      '--mobile-dist=/tmp/mobile',
      '--remote-access',
    ])
    expect(args).toEqual({
      port: 4001,
      projectRoot: '/tmp/proj',
      builtinPluginsDir: '/tmp/plugins',
      remoteAccess: true,
      mobileDist: '/tmp/mobile',
    })
  })

  it('路径含 = 按首个 = 切分不截断（code-harden P2 修复点）：--mobile-dist=', () => {
    expect(parseRuntimeArgs(['--mobile-dist=/tmp/a=b/dist']).mobileDist).toBe('/tmp/a=b/dist')
  })

  it('路径含 = 同款：--project-root= / --builtin-plugins-dir=', () => {
    expect(parseRuntimeArgs(['--project-root=/tmp/x=y']).projectRoot).toBe('/tmp/x=y')
    expect(parseRuntimeArgs(['--builtin-plugins-dir=/tmp/p=q']).builtinPluginsDir).toBe('/tmp/p=q')
  })

  it.each(['abc', '', '   '])('非法 --port 值（"%s"）→ throw，消息含原值（组合根包装 exit(1)）', (bad) => {
    expect(() => parseRuntimeArgs(['--port', bad])).toThrow(`invalid --port value: ${bad}`)
    expect(() => parseRuntimeArgs([`--port=${bad}`])).toThrow(`invalid --port value: ${bad}`)
  })

  it('末位悬空 flag（--port 无后续值）→ warn 缺值 + 按缺省处理（code-harden P2：不再静默）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseRuntimeArgs(['--port']).port).toBe(BASE_PORT)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('--port 缺值')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('未知 flag（--remote-acces 拼错）→ warn 核对拼写指引 + 解析结果不受影响（不 throw，忽略语义保持）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const args = parseRuntimeArgs(['--remote-acces', '--port', '4003'])
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('--remote-acces')
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('remote-access')
      expect(args.remoteAccess).toBe(false)
      expect(args.port).toBe(4003)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('TAIJI_AGENT_PORT_OFFSET env 正偏移 port', () => {
    vi.stubEnv('TAIJI_AGENT_PORT_OFFSET', '100')
    expect(parseRuntimeArgs([]).port).toBe(BASE_PORT + 100)
  })

  it('TAIJI_AGENT_PORT_OFFSET 负值钳到 0、超上界钳到 MAX_PORT - BASE_PORT', () => {
    vi.stubEnv('TAIJI_AGENT_PORT_OFFSET', '-5')
    expect(parseRuntimeArgs([]).port).toBe(BASE_PORT)
    vi.stubEnv('TAIJI_AGENT_PORT_OFFSET', String(MAX_PORT))
    expect(parseRuntimeArgs([]).port).toBe(MAX_PORT)
  })

  it('--remote-access 不出现 → remoteAccess=false（argv 判据，无 env 通道）', () => {
    expect(parseRuntimeArgs(['--port', '4002']).remoteAccess).toBe(false)
  })
})
