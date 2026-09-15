/**
 * sidecar-binding-sync 守卫测试——「入口回填断言」（设计文档 §3.3 决策 3 第 ① 类）。
 *
 * 两部分分工：
 * - Part 1：hydrateBindingMeta 纯函数契约。期望值全部硬编码自设计文档 §3.3 决策 1
 *   矩阵（外部事实）——禁止运行时读 BINDING_FIELDS 算期望，否则测试与实现共用同一
 *   表源，表语义定错时双向自证「空绿」。注册表键清单仅用作遍历骨架（coverage 从表
 *   读）：新增绑定字段漏更本测试 = 键集一致性断言红。
 * - Part 2：入口接线锁定（源码结构断言）。create/restore/fork 真实入口依赖 pi 子进程
 *   spawn + switch_session RPC（session-lifecycle-options.test.ts 前言已裁定 mock 成本
 *   过高），降级为 fs 读源码文本断言调用形态；handoff 承接通道走 sessionService.create
 *   派生调用（通道独立性由 CREATE_DERIVED_CALLERS 清单承诺），对 handoff-service 的
 *   create options 做同样静态断言。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/binding-registry-hydrate.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { hydrateBindingMeta, BINDING_FIELDS } from '../infra/pi/session-binding-fields.js'
import type { BindingFieldKey, BindingEntryKind } from '../infra/pi/session-binding-fields.js'
import type { ScannedSessionMeta } from '../infra/pi/session-file-utils.js'
import { extractCallWindows } from './helpers/bracket-call-window.js'

// ── 公共夹具 ─────────────────────────────────────────────────────────

/** 七字段样例值集合（值本身无语义，仅需非 undefined 且可区分键名）；类型对齐 hydrate 形参，spawnSource 字面量经上下文收窄进枚举 */
const SAMPLE_META: Partial<Pick<ScannedSessionMeta, BindingFieldKey>> = {
  launchPresetId: 'preset-x',
  projectId: 'proj-x',
  spawnSource: 'agent',
  parentAgentSessionId: 'pa-x',
  handedOffTo: 'next-x',
  modelId: 'model-x',
  thinkingLevel: 'high',
}

function freshSession(): Record<string, unknown> {
  return {}
}

// ── Part 1：hydrateBindingMeta 纯函数契约 ────────────────────────────

describe('hydrateBindingMeta · 设计文档 §3.3 决策 1 矩阵（期望硬编码）', () => {
  it('A-1/A4: restore 入口五字段全量回填', () => {
    const s = freshSession()
    hydrateBindingMeta(
      s,
      {
        projectId: 'proj-a1',
        spawnSource: 'agent',
        parentAgentSessionId: 'pa-1',
        handedOffTo: 'next-1',
        launchPresetId: 'preset-r',
      },
      'restore',
    )
    expect(s.projectId).toBe('proj-a1')
    expect(s.spawnSource).toBe('agent')
    expect(s.parentAgentSessionId).toBe('pa-1')
    expect(s.handedOffTo).toBe('next-1')
    expect(s.launchPresetId).toBe('preset-r')
  })

  it('A-8: fork 选择性继承——launchPresetId/projectId 生效，spawnSource/parentAgentSessionId/handedOffTo 刻意不继承（多传也不落对象）', () => {
    const s = freshSession()
    // 同一次调用把 none 字段的值也喂进去——hydrate 必须按矩阵 fork 列排斥
    hydrateBindingMeta(
      s,
      {
        launchPresetId: 'pk',
        projectId: 'proj-a2',
        spawnSource: 'agent',
        parentAgentSessionId: 'leak-pa',
        handedOffTo: 'leak-next',
      },
      'fork',
    )
    // 生效的两字段（inherit-source）
    expect(s.launchPresetId).toBe('pk')
    expect(s.projectId).toBe('proj-a2')
    // 刻意不继承的三字段：键都不存在（in 检查而非 ===undefined，防「写了 undefined」假绿）
    expect(Object.hasOwn(s, 'spawnSource')).toBe(false)
    expect(Object.hasOwn(s, 'parentAgentSessionId')).toBe(false)
    expect(Object.hasOwn(s, 'handedOffTo')).toBe(false)
  })

  it('fork 无归属：projectId 不传或 undefined → 对象上无该键（现状等价语义，缺 A-2 内存量）', () => {
    const sNone = freshSession()
    hydrateBindingMeta(sNone, {}, 'fork')
    const sUndef = freshSession()
    hydrateBindingMeta(sUndef, { launchPresetId: 'pk-fallback', projectId: undefined }, 'fork')
    expect(Object.hasOwn(sNone, 'projectId')).toBe(false)
    expect(Object.hasOwn(sUndef, 'projectId')).toBe(false)
    // 对照组：fork 的另一字段正常生效，证明不是整体没跑
    expect(sUndef.launchPresetId).toBe('pk-fallback')
  })

  it('create 入口：六个 options 字段传入即生效；handedOffTo 为 create=none 不落对象', () => {
    const s = freshSession()
    hydrateBindingMeta(
      s,
      {
        launchPresetId: 'preset-c',
        projectId: 'proj-c',
        spawnSource: 'user',
        parentAgentSessionId: 'pa-c',
        handedOffTo: 'must-not-leak',
        modelId: 'model-c',
        thinkingLevel: 'high',
      },
      'create',
    )
    expect(s.launchPresetId).toBe('preset-c')
    expect(s.projectId).toBe('proj-c')
    expect(s.spawnSource).toBe('user')
    expect(s.parentAgentSessionId).toBe('pa-c')
    expect(s.modelId).toBe('model-c')
    expect(s.thinkingLevel).toBe('high')
    expect(Object.hasOwn(s, 'handedOffTo')).toBe(false)
  })

  it('handoff 承接通道说明性用例：实现上承接复用 entry=\'create\' 调用 hydrate（通道独立性由 CREATE_DERIVED_CALLERS 清单静态守卫承诺，见 Part 2 handoff-service 断言），故此处按 create 入口断言承接值注入生效', () => {
    const s = freshSession()
    hydrateBindingMeta(s, { projectId: 'src-p' }, 'create')
    expect(s.projectId).toBe('src-p')
  })

  it('undefined 值跳过语义：任何 entry 下 meta 值为 undefined 都不产生键', () => {
    const entries: BindingEntryKind[] = ['create', 'handoff', 'restore', 'fork']
    for (const entry of entries) {
      const s = freshSession()
      hydrateBindingMeta(
        s,
        {
          launchPresetId: undefined,
          projectId: undefined,
          spawnSource: undefined,
          parentAgentSessionId: undefined,
          handedOffTo: undefined,
          modelId: undefined,
          thinkingLevel: undefined,
        },
        entry,
      )
      for (const field of Object.keys(SAMPLE_META) as BindingFieldKey[]) {
        expect(Object.hasOwn(s, field), `${entry}/${field}: undefined 值不得产生键`).toBe(false)
      }
    }
  })

  it('遍历矩阵：注册表每键 × 四入口的 patch/skip 行为与硬编码矩阵一致（骨架从表读、期望不读表）', () => {
    /**
     * hydrate 行为投影矩阵——设计文档 §3.3 决策 1 的手工誊写：
     * patch = 该格语义为 options / inherit-source / meta / resolved-in-entry（hydrate 一律回填）
     * skip  = 该格语义为 'none'（刻意不回填）。
     * 本表是外部事实锚点；BINDING_FIELDS 改行而本表未跟 → 此处红，逼 review 表语义决策。
     */
    const EXPECTED_PATCH: Record<BindingFieldKey, Record<BindingEntryKind, boolean>> = {
      launchPresetId:       { create: true,  handoff: false, restore: true,  fork: true  },
      projectId:            { create: true,  handoff: true,  restore: true,  fork: true  },
      spawnSource:          { create: true,  handoff: false, restore: true,  fork: false },
      parentAgentSessionId: { create: true,  handoff: false, restore: true,  fork: false },
      handedOffTo:          { create: false, handoff: false, restore: true,  fork: false },
      modelId:              { create: true,  handoff: true,  restore: false, fork: true  },
      thinkingLevel:        { create: true,  handoff: true,  restore: false, fork: true  },
    }

    const entries: BindingEntryKind[] = ['create', 'handoff', 'restore', 'fork']
    for (const field of Object.keys(BINDING_FIELDS) as BindingFieldKey[]) {
      for (const entry of entries) {
        const s = freshSession()
        hydrateBindingMeta(s, SAMPLE_META, entry)
        if (EXPECTED_PATCH[field][entry]) {
          expect(
            s[field],
            `${entry}/${field}: 应回填为传入值`,
          ).toBe(SAMPLE_META[field])
        } else {
          expect(
            Object.hasOwn(s, field),
            `${entry}/${field}: none 格刻意不继承，不得出现该键`,
          ).toBe(false)
        }
      }
    }
  })

  it('骨架防护：本测试硬编码矩阵与 BINDING_FIELDS 注册表键集一致（新增绑定字段必须同步更新期望矩阵）', () => {
    const registryKeys = (Object.keys(BINDING_FIELDS) as BindingFieldKey[]).sort()
    const matrixKeys = (Object.keys({
      launchPresetId: true,
      projectId: true,
      spawnSource: true,
      parentAgentSessionId: true,
      handedOffTo: true,
      modelId: true,
      thinkingLevel: true,
    }) as BindingFieldKey[]).sort()
    expect(matrixKeys).toEqual(registryKeys)
  })
})

// ── Part 2：入口接线锁定（源码结构断言） ─────────────────────────────

/**
 * 提取源码中 callee( 开始到圆括号平衡结束的完整调用块文本（T11 收敛：
 * 括号平衡 + 字符串感知语义在共享 helper bracket-call-window.ts，此处仅绑定锚点取 text）。
 */
function extractCallBlocks(source: string, callee: RegExp): string[] {
  return extractCallWindows(source, callee).map((w) => w.text)
}

/** 测试文件位于 src/__tests__/，../ 即 src/ 根 */
const lifecycleSrc = readFileSync(new URL('../services/session/session-lifecycle.ts', import.meta.url), 'utf8')
const handoffSrc = readFileSync(new URL('../services/handoff-service.ts', import.meta.url), 'utf8')

describe('入口接线锁定 · session-lifecycle.ts 三处 hydrateBindingMeta 调用', () => {
  const callBlocks = extractCallBlocks(lifecycleSrc, /hydrateBindingMeta\s*\(/g)

  it('恰好 3 处调用（import/注释提及不含 "(" 形态不计入），尾参依序 create → restore → fork', () => {
    expect(callBlocks.length).toBe(3)
    const endings = callBlocks.map((b) => {
      const m = b.match(/,\s*'(\w+)'\s*\)\s*$/)
      expect(m, `调用块缺少 ', 'entry')' 尾参形态:\n${b}`).not.toBeNull()
      return m![1]
    })
    expect(endings).toEqual(['create', 'restore', 'fork'])
  })

  it("restore 调用块全量接线：projectId/spawnSource/parentAgentSessionId/handedOffTo 四字段均取自 target.*（缺陷 A-1 锁定）", () => {
    const block = callBlocks.find((b) => /,\s*'restore'\s*\)\s*$/.test(b))
    expect(block).toBeDefined()
    expect(block!).toMatch(/\bprojectId\s*:\s*target\./)
    expect(block!).toMatch(/\bspawnSource\s*:\s*target\./)
    expect(block!).toMatch(/\bparentAgentSessionId\s*:\s*target\./)
    expect(block!).toMatch(/\bhandedOffTo\s*:\s*target\./)
  })

  it('fork 调用块选择性继承：含 launchPresetId/projectId 接线，且块内无 spawnSource/handedOffTo 字样（A-8「刻意不继承」接线级锁定）', () => {
    const block = callBlocks.find((b) => /,\s*'fork'\s*\)\s*$/.test(b))
    expect(block).toBeDefined()
    expect(block!).toMatch(/\blaunchPresetId\s*:/)
    expect(block!).toMatch(/\bprojectId\s*:/)
    expect(block!).not.toMatch(/spawnSource/)
    expect(block!).not.toMatch(/handedOffTo/)
  })

  it('create 调用块接线四 options 字段（handoff 承接通道复用此入口）', () => {
    const block = callBlocks.find((b) => /,\s*'create'\s*\)\s*$/.test(b))
    expect(block).toBeDefined()
    expect(block!).toMatch(/\blaunchPresetId\s*:/)
    expect(block!).toMatch(/\bprojectId\s*:/)
    expect(block!).toMatch(/\bspawnSource\s*:/)
    expect(block!).toMatch(/\bparentAgentSessionId\s*:/)
  })
})

describe('入口接线锁定 · handoff-service.ts 承接通道（CREATE_DERIVED_CALLERS 承诺核对）', () => {
  it('sessionService.create options 含 projectId:（缺陷 C 继承源归属），且不含 spawnSource（防顺手继承漂移）', () => {
    const blocks = extractCallBlocks(handoffSrc, /sessionService\.create\s*\(/g)
    expect(blocks.length).toBe(1)
    expect(blocks[0]).toMatch(/\bprojectId\s*:/)
    expect(blocks[0]).not.toMatch(/spawnSource/)
    expect(blocks[0]).not.toMatch(/parentAgentSessionId/)
  })
})
