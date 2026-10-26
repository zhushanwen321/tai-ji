import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { hydrateBindingMeta, BINDING_FIELDS, CREATE_DERIVED_CALLERS, type BindingFieldKey, type BindingEntryKind } from '../infra/pi/session-binding-fields.js'
import type { ScannedSessionMeta } from '../services/ports/session.js'
import { extractCallWindows } from './helpers/bracket-call-window.js'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// 本文件另为 session-binding-fields 合并载体（create-derived-callers 折叠为分节）。
/**
 * sidecar-binding-sync 检查测试——「入口回填断言」（设计文档 §3.3 决策 3 第 ① 类）。
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

  it('handoff 承接通道说明性用例：实现上承接复用 entry=\'create\' 调用 hydrate（通道独立性由 CREATE_DERIVED_CALLERS 清单静态检查承诺，见 Part 2 handoff-service 断言），故此处按 create 入口断言承接值注入生效', () => {
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
     * hydrate 行为派生视图矩阵——设计文档 §3.3 决策 1 的手工誊写：
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

// ════════════════ 来源: create-derived-callers.test.ts ════════════════

describe('create-derived-callers', () => {
  /** 本测试文件位于 <src>/__tests__/，上两级即扫描根 packages/runtime/src */
  const SRC_DIR = resolve(fileURLToPath(import.meta.url), '..', '..')

  /** 决策 1b 主流程排除集：create 定义处 + 生命周期直连处（posix 相对路径） */
  const SCAN_EXCLUDED_FILES = new Set([
    'services/session/session-service.ts',
    'services/session/session-lifecycle.ts',
  ])

  /**
   * 绑定字段名 → create options 实参形参名的别名表。
   *
   * launchPresetId 绑定字段经 session-lifecycle.create 的 options.presetId 形参传入
   *（见该文件 create 签名 docstring「Launch preset id」，内部落盘为 launchPresetId），
   * 文本断言需接受两种拼写；其余字段实参名与字段名一致，无需别名。
   */
  const FIELD_ALIASES: Partial<Record<BindingFieldKey, readonly string[]>> = {
    launchPresetId: ['presetId'],
  }

  /** 字段名 + 别名的全部可接受文本拼写（别名字符串天然不同于长名，无子串吞噬问题） */
  function acceptedNames(field: BindingFieldKey): readonly string[] {
    return [field, ...(FIELD_ALIASES[field] ?? [])]
  }

  /** 按 semantic 通道的禁传绑定字段（防顺手继承漂移；handoff 刻意全 none 的字段在此落地） */
  const FORBIDDEN_FIELDS_BY_SEMANTIC: Record<CreateDerivedCaller['semantic'], readonly BindingFieldKey[]> = {
    'user-facing': ['spawnSource', 'parentAgentSessionId'],
    // agent-managed（D8，2026-09 裁决）：projectId 已从禁传清单移除——该通道经服务端
    // 从父会话 summary 派生 projectId（不读 params.projectId，见 session-binding-fields.ts
    // 的登记注释与 session-manager-handler 单测的伪造参数断言）。
    // 本通道其余写入字段（spawnSource / parentAgentSessionId）不属本清单：它们由服务端
    // 从路由上下文注入、同样不读请求参数，属「允许透传的绑定字段」（登记 passedBindingFields
    // 承诺 + handler 的 params 信任边界检查），列入禁传会与本通道实际传参自相矛盾。
    // 「不得由请求参数携带」的精神由 handler 侧单测（伪造 spawnSource/parentAgentSessionId
    // 被忽略）与登记注释共同保全。
    'agent-managed': [],
    handoff: ['spawnSource', 'parentAgentSessionId', 'launchPresetId'],
  }

  type CreateDerivedCaller = (typeof CREATE_DERIVED_CALLERS)[number]

  const LEGAL_SEMANTICS: readonly CreateDerivedCaller['semantic'][] = ['user-facing', 'agent-managed', 'handoff']

  /** 递归收集 src 下全部 .ts 文件绝对路径（跳过 __tests__ 目录） */
  function listSourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') out.push(...listSourceFiles(fullPath))
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        out.push(fullPath)
      }
    }
    return out
  }

  /** 提取每处 sessionService.create( 调用窗（括号平衡 + 字符串感知语义在共享 helper，T11 收敛）。 */
  function extractSessionCreateWindows(content: string) {
    return extractCallWindows(content, /sessionService\.create\(/g)
  }

  describe('CREATE_DERIVED_CALLERS 入口清单检查（sidecar-binding-sync §3.3 决策 1b）', () => {
    it('静态扫描 sessionService.create( 命中文件集合与登记清单完全相等（双向：漏登记红 / 失效登记红）', () => {
      const hitFiles = new Set<string>()
      for (const absPath of listSourceFiles(SRC_DIR)) {
        const relPosix = relative(SRC_DIR, absPath).split(sep).join('/')
        if (SCAN_EXCLUDED_FILES.has(relPosix)) continue
        if (/sessionService\.create\(/.test(readFileSync(absPath, 'utf8'))) hitFiles.add(relPosix)
      }
      const registeredFiles = new Set(CREATE_DERIVED_CALLERS.map((caller) => caller.file))

      const unregistered = [...hitFiles].filter((f) => !registeredFiles.has(f)).sort()
      const stale = [...registeredFiles].filter((f) => !hitFiles.has(f)).sort()

      expect(unregistered, [
        '发现未登记的 sessionService.create 派生调用点：',
        ...unregistered.map((f) => `  - ${f}`),
        '新调用点的绑定字段传参必须受检查约束——请到 infra/pi/session-binding-fields.ts 的',
        'CREATE_DERIVED_CALLERS 登记该文件（file / semantic / passedBindingFields），见设计文档 §3.3 决策 1b 与 G2。',
      ].join('\n')).toEqual([])

      expect(stale, [
        '以下登记项对应的 sessionService.create 调用点已从源码消失（登记失效）：',
        ...stale.map((f) => `  - ${f}`),
        '请从 infra/pi/session-binding-fields.ts 的 CREATE_DERIVED_CALLERS 移除失效条目，保持清单即事实。',
      ].join('\n')).toEqual([])
    })

    it('每个登记项的 file 相对路径都指向实际存在的源码文件', () => {
      for (const caller of CREATE_DERIVED_CALLERS) {
        expect(existsSync(resolve(SRC_DIR, caller.file)), `登记项文件不存在：${caller.file}`).toBe(true)
      }
    })

    it('每个登记项的实际传参窗口包含其 passedBindingFields 全部字段（锚定传参承诺，防漏传）', () => {
      for (const caller of CREATE_DERIVED_CALLERS) {
        const content = readFileSync(resolve(SRC_DIR, caller.file), 'utf8')
        const windows = extractSessionCreateWindows(content)
        expect(windows.length, `${caller.file} 中提取到 0 处 sessionService.create 调用窗口，无法校验传参承诺`).toBeGreaterThan(0)

        for (const window of windows) {
          for (const field of caller.passedBindingFields) {
            const names = acceptedNames(field)
            expect(
              names.some((name) => window.text.includes(name)),
              `${caller.file}:${window.line} 的 create 调用登记承诺透传绑定字段 "${field}"，` +
              `但调用窗口内未出现任何可接受拼写（${names.join(' | ')}）——漏传承诺字段，违反决策 1b。\n` +
              `窗口文本：\n${window.text}`,
            ).toBe(true)
          }
        }
      }
    })

    it('各 semantic 通道的实际传参窗口不含禁传绑定字段（防顺手继承漂移）', () => {
      for (const caller of CREATE_DERIVED_CALLERS) {
        const content = readFileSync(resolve(SRC_DIR, caller.file), 'utf8')
        for (const window of extractSessionCreateWindows(content)) {
          for (const field of FORBIDDEN_FIELDS_BY_SEMANTIC[caller.semantic]) {
            const names = acceptedNames(field)
            expect(
              names.some((name) => window.text.includes(name)),
              `${caller.file}:${window.line}（${caller.semantic} 通道）的 create 调用出现了禁传绑定字段 "${field}"` +
              `（注册表矩阵该通道列为 none，防顺手继承漂移）——请删除该传参或修订通道语义。\n` +
              `窗口文本：\n${window.text}`,
            ).toBe(false)
          }
        }
      }
    })

    it('登记项 semantic 取值合法（user-facing | agent-managed | handoff）', () => {
      for (const caller of CREATE_DERIVED_CALLERS) {
        expect(
          LEGAL_SEMANTICS,
          `${caller.file} 的 semantic "${String(caller.semantic)}" 不合法，合法值：${LEGAL_SEMANTICS.join(' | ')}`,
        ).toContain(caller.semantic)
      }
    })
  })
})
