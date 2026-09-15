// src/__tests__/spawn-args.test.ts
//
// pi argv 构造器参数化矩阵 + 快照等价锚定。
//
// 快照等价（U1 验收条款 5）：两组「典型参数集 → 完整 argv」的逐字节期望值抄录自
// 切换前实现的行为——主 agent 侧 = runtime rpc-client buildPiArgs（切换前实现，
// 行为由 test/rpc-client-start-args-anchor.test.ts 既有断言锚定）；subagent 侧 =
// pi-subagent-cli spawn-args.ts buildSpawnArgs（切换前实现，行为由其
// __tests__/spawn-args.test.ts 既有断言锚定）。本文件锚定公共层产出与两侧切换前
// 输出一致（迁移契约：行为等价提取，非重写）。

import { describe, expect, it, vi, afterEach } from 'vitest'

import {
  appendExtensionArgs,
  appendSkillArgs,
  appendToolArgs,
  buildPiMainAgentArgs,
  buildPiSubagentSpawnArgs,
  parseSpawnModelRef,
  toolOptionConflict,
  type PiSubagentSpawnParams,
} from '../spawn-args.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 主 agent 模板（runtime 消费面）
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPiMainAgentArgs（主 agent 模板）', () => {
  it('最小参数：基座 = --mode rpc --no-extensions --approve（B1 起无 --session-dir）', () => {
    expect(buildPiMainAgentArgs({}, undefined)).toEqual([
      '--mode', 'rpc', '--no-extensions', '--approve',
    ])
  })

  it('model 三态：显式 model 拼接 / undefined 不拼 / 空串不拼', () => {
    expect(buildPiMainAgentArgs({}, 'prov/mid')).toContain('--model')
    const withModel = buildPiMainAgentArgs({}, 'prov/mid')
    expect(withModel[withModel.indexOf('--model') + 1]).toBe('prov/mid')
    expect(buildPiMainAgentArgs({}, undefined)).not.toContain('--model')
    expect(buildPiMainAgentArgs({}, '')).not.toContain('--model')
  })

  it('systemPrompt：非空白拼 --system-prompt；空白/未传不拼', () => {
    const args = buildPiMainAgentArgs({ systemPrompt: '  sys prompt  ' }, undefined)
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('  sys prompt  ')
    expect(buildPiMainAgentArgs({ systemPrompt: '   ' }, undefined)).not.toContain('--system-prompt')
    expect(buildPiMainAgentArgs({}, undefined)).not.toContain('--system-prompt')
  })

  it('skillPaths/extensionPaths：每个路径独立 token、顺序保留', () => {
    const args = buildPiMainAgentArgs({ skillPaths: ['/s1', '/s2'], extensionPaths: ['/e1', '/e2'] }, undefined)
    expect(args).toEqual([
      '--mode', 'rpc', '--no-extensions', '--approve',
      '--skill', '/s1', '--skill', '/s2',
      '--extension', '/e1', '--extension', '/e2',
    ])
  })

  it('skill/extension 段在 tools 段之前（主 agent 编排顺序，与切换前一致）', () => {
    const args = buildPiMainAgentArgs({ skillPaths: ['/s'], tools: ['read'] }, undefined)
    expect(args.indexOf('--skill')).toBeLessThan(args.indexOf('--tools'))
  })

  it('tools 互斥三分支：noTools > tools > excludeTools，冲突 warn 精确文案', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const t1 = buildPiMainAgentArgs({ noTools: true, tools: ['read'] }, undefined)
      expect(t1).toContain('--no-tools')
      expect(t1).not.toContain('--tools')
      expect(warnSpy).toHaveBeenCalledWith(
        '[rpc] conflicting tool options detected, using priority: noTools > tools > excludeTools',
      )

      warnSpy.mockClear()
      const t2 = buildPiMainAgentArgs({ tools: ['read'], excludeTools: ['bash'] }, undefined)
      expect(t2).toContain('--tools')
      expect(t2).not.toContain('--exclude-tools')
      expect(warnSpy).toHaveBeenCalledTimes(1)

      // 单选项不 warn
      warnSpy.mockClear()
      buildPiMainAgentArgs({ tools: ['read'] }, undefined)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('excludeTools 单选项：--exclude-tools 逗号连接', () => {
    const args = buildPiMainAgentArgs({ excludeTools: ['bash', 'edit'] }, undefined)
    expect(args[args.indexOf('--exclude-tools') + 1]).toBe('bash,edit')
  })

  it('noSkills / noContextFiles / thinkingLevel flag（非 --thinking-level）', () => {
    const args = buildPiMainAgentArgs({ noSkills: true, noContextFiles: true, thinkingLevel: 'high' }, undefined)
    expect(args).toContain('--no-skills')
    expect(args).toContain('--no-context-files')
    expect(args[args.indexOf('--thinking') + 1]).toBe('high')
    expect(args).not.toContain('--thinking-level')
  })

  it('快照等价：典型全参数集 argv 与切换前（runtime buildPiArgs）逐字节一致', () => {
    const args = buildPiMainAgentArgs(
      {
        systemPrompt: 'sys',
        skillPaths: ['/s1', '/s2'],
        extensionPaths: ['/e1'],
        tools: ['read', 'grep'],
        noSkills: true,
        noContextFiles: true,
        thinkingLevel: 'high',
      },
      'prov/mid',
    )
    expect(args).toEqual([
      '--mode', 'rpc', '--no-extensions', '--approve',
      '--model', 'prov/mid',
      '--system-prompt', 'sys',
      '--skill', '/s1', '--skill', '/s2',
      '--extension', '/e1',
      '--tools', 'read,grep',
      '--no-skills',
      '--no-context-files',
      '--thinking', 'high',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// subagent 模板（pi-subagent-cli 消费面）
// ─────────────────────────────────────────────────────────────────────────────

/** subagent 侧基础参数（对齐 pi-subagent-cli spawn-args.test.ts 的 baseParams 形状）。 */
const baseParams: PiSubagentSpawnParams = {
  modelRef: { provider: 'openai', id: 'gpt-4o' },
  thinkingLevel: undefined,
  agentTools: undefined,
  appendSystemPromptPath: undefined,
  sessionDir: '/sessions/dir',
  forkSource: undefined,
  skillPaths: undefined,
}

describe('buildPiSubagentSpawnArgs（subagent 模板）', () => {
  it('基础参数：--mode rpc --session-dir <dir> --model provider/id，不含 -p / task', () => {
    expect(buildPiSubagentSpawnArgs(baseParams)).toEqual([
      '--mode', 'rpc', '--session-dir', '/sessions/dir', '--model', 'openai/gpt-4o',
    ])
  })

  it('session 定位参数化——dir 必选 + file 可选：--session 紧跟 --session-dir（--model 之前）', () => {
    const args = buildPiSubagentSpawnArgs({ ...baseParams, sessionFile: '/sessions/sub/abc.jsonl' })
    const idx = args.indexOf('--session')
    expect(args[idx + 1]).toBe('/sessions/sub/abc.jsonl')
    expect(idx).toBe(args.indexOf('--session-dir') + 2)
  })

  it('thinking 传递参数化——model 后缀 :level（与主 agent 的 --thinking flag 相对）', () => {
    const args = buildPiSubagentSpawnArgs({ ...baseParams, thinkingLevel: 'high' })
    expect(args[args.indexOf('--model') + 1]).toBe('openai/gpt-4o:high')
    expect(args).not.toContain('--thinking')
  })

  it('agentTools → --tools 逗号分隔；空数组不追加', () => {
    const args = buildPiSubagentSpawnArgs({ ...baseParams, agentTools: ['read', 'bash'] })
    expect(args[args.indexOf('--tools') + 1]).toBe('read,bash')
    expect(buildPiSubagentSpawnArgs({ ...baseParams, agentTools: [] })).not.toContain('--tools')
  })

  it('appendSystemPromptPath / forkSource / skillPaths 顺序：tools → append → fork → skill*', () => {
    const args = buildPiSubagentSpawnArgs({
      ...baseParams,
      agentTools: ['read'],
      appendSystemPromptPath: '/tmp/p.md',
      forkSource: '/parent.jsonl',
      skillPaths: ['/skills/x', '/skills/y'],
    })
    expect(args.indexOf('--tools')).toBeLessThan(args.indexOf('--append-system-prompt'))
    expect(args.indexOf('--append-system-prompt')).toBeLessThan(args.indexOf('--fork'))
    expect(args.indexOf('--fork')).toBeLessThan(args.indexOf('--skill'))
    expect(args[args.indexOf('--skill') + 1]).toBe('/skills/x')
  })

  it('mirror 规则：noExtensions/approve/noContextFiles/extensionPaths 段在末尾；全 false 不追加', () => {
    const args = buildPiSubagentSpawnArgs({
      ...baseParams,
      mirrorFlags: { noExtensions: true, approve: true, noContextFiles: true, extensionPaths: ['/e1', '/e2'] },
    })
    // mirror 段在最末（skill 之后）
    expect(args.lastIndexOf('--extension')).toBeGreaterThan(args.indexOf('--mode'))
    expect(args.filter(a => a === '--extension')).toHaveLength(2)
    expect(args).toContain('--no-extensions')
    expect(args).toContain('--approve')
    expect(args).toContain('--no-context-files')

    const none = buildPiSubagentSpawnArgs({
      ...baseParams,
      mirrorFlags: { noExtensions: false, approve: false, noContextFiles: false, extensionPaths: [] },
    })
    expect(none).toEqual(['--mode', 'rpc', '--session-dir', '/sessions/dir', '--model', 'openai/gpt-4o'])
  })

  it('mirrorFlags undefined → 行为等同旧版（无任何 mirror flag）', () => {
    expect(buildPiSubagentSpawnArgs(baseParams)).not.toContain('--no-extensions')
    expect(buildPiSubagentSpawnArgs(baseParams)).not.toContain('--approve')
  })

  it('快照等价：典型全参数集 argv 与切换前（pi-subagent-cli buildSpawnArgs）逐字节一致', () => {
    const args = buildPiSubagentSpawnArgs({
      modelRef: { provider: 'openai', id: 'gpt-4o' },
      thinkingLevel: 'low',
      agentTools: ['read'],
      appendSystemPromptPath: '/tmp/p.md',
      sessionDir: '/s',
      sessionFile: '/s/resume.jsonl',
      forkSource: '/parent.jsonl',
      skillPaths: ['/skills/x'],
      mirrorFlags: { noExtensions: true, approve: true, extensionPaths: ['/e1'], noContextFiles: true },
    })
    expect(args).toEqual([
      '--mode', 'rpc', '--session-dir', '/s', '--session', '/s/resume.jsonl',
      '--model', 'openai/gpt-4o:low',
      '--tools', 'read',
      '--append-system-prompt', '/tmp/p.md',
      '--fork', '/parent.jsonl',
      '--skill', '/skills/x',
      '--no-extensions', '--approve', '--no-context-files', '--extension', '/e1',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 共享原语与模型解析
// ─────────────────────────────────────────────────────────────────────────────

describe('共享分段原语', () => {
  it('appendSkillArgs / appendExtensionArgs：独立 token', () => {
    const args: string[] = []
    appendSkillArgs(args, ['/a'])
    appendExtensionArgs(args, ['/b'])
    expect(args).toEqual(['--skill', '/a', '--extension', '/b'])
    const empty: string[] = []
    appendSkillArgs(empty, undefined)
    appendExtensionArgs(empty, [])
    expect(empty).toEqual([])
  })

  it('toolOptionConflict：任两组同时出现即 true', () => {
    expect(toolOptionConflict(true, true, false)).toBe(true)
    expect(toolOptionConflict(true, false, true)).toBe(true)
    expect(toolOptionConflict(false, true, true)).toBe(true)
    expect(toolOptionConflict(true, false, false)).toBe(false)
    expect(toolOptionConflict(false, false, false)).toBe(false)
  })

  it('appendToolArgs 单选项各分支', () => {
    const a: string[] = []
    appendToolArgs(a, { tools: ['x', 'y'] })
    expect(a).toEqual(['--tools', 'x,y'])
    const b: string[] = []
    appendToolArgs(b, { noTools: true })
    expect(b).toEqual(['--no-tools'])
  })
})

describe('parseSpawnModelRef', () => {
  it('canonical "provider/id" → {provider, id}', () => {
    expect(parseSpawnModelRef('zai-coding-cn/GLM-5.3-Flash')).toEqual({
      provider: 'zai-coding-cn',
      id: 'GLM-5.3-Flash',
    })
  })
  it('畸形词形 → undefined（空 / 无斜杠 / 斜杠开头 / 斜杠结尾）', () => {
    expect(parseSpawnModelRef(undefined)).toBeUndefined()
    expect(parseSpawnModelRef('  ')).toBeUndefined()
    expect(parseSpawnModelRef('noprovider')).toBeUndefined()
    expect(parseSpawnModelRef('/id')).toBeUndefined()
    expect(parseSpawnModelRef('provider/')).toBeUndefined()
  })
})
