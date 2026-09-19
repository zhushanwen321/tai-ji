/**
 * create 派生调用方登记完整性与传参承诺守卫测试（静态扫描）。
 *
 * 锁定行为（sidecar-binding-sync 设计文档 §3.3 决策 1b / G2 / A5 变异 4）：所有
 * `sessionService.create(` 的派生调用点必须在
 * `infra/pi/session-binding-fields.ts` 的 CREATE_DERIVED_CALLERS 登记，且每个登记项的
 * 实际传参与 passedBindingFields 承诺一致——新增派生调用方漏登记（= 漏传/顺手多传绑定
 * 参数不设防）与登记后调用点消失均被本测试拦截（G2 承诺：「create 派生调用方漏传/
 * 顺手多传绑定参数也会被入口清单测试拦截」）。
 *
 * 断言边界（设计文档 §3.1 能力边界）：拦「漏登记 / 调用点消失 / 传参漂移」，
 * 不拦「调用方语义定错」（该不该传某字段属 review 职责）。静态扫描是文本级命中，
 * 注释中出现调用形态文本也会计入——这是刻意的保守取向，宁可误红逼人显式处理。
 *
 * 白名单（决策 1b 排除集）：sessionService.create 的定义（services/session/
 * session-service.ts）与生命周期直连主流程（services/session/session-lifecycle.ts）
 * 不算「派生调用方」，扫描排除。
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sep } from 'node:path'
import { CREATE_DERIVED_CALLERS, type BindingFieldKey } from '../infra/pi/session-binding-fields.js'
import { extractCallWindows } from './helpers/bracket-call-window.js'

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
  // 承诺 + handler 的 params 信任边界守卫），列入禁传会与本通道实际传参自相矛盾。
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

describe('CREATE_DERIVED_CALLERS 入口清单守卫（sidecar-binding-sync §3.3 决策 1b）', () => {
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
      '新调用点的绑定字段传参必须受守卫约束——请到 infra/pi/session-binding-fields.ts 的',
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
