/**
 * 品味规则（data-source-governance R3）：模块级缓存必须带 @data-owner 注解且条目真实
 *
 * 模块级可变缓存（new Map/Set/WeakMap、ref/shallowRef/reactive）是「数据多源」病灶的
 * 高发形态（影子状态/第二写方都从这里长出来，见 data-source-governance.md §2.2）。
 * 新增必须先登记 owner 再写代码（登记表 §5 维护规约第 5 条），本规则强制该顺序可机检：
 * 声明处缺 `@data-owner <登记表条目编号>` 注释，或引用的编号不在登记表内 → 报错。
 *
 * 登记表 SSOT：docs/architecture/data-source-registry.md。W24 起条目清单不再人工同步——
 * 运行时经 taste-lint/lib/parse-registry.mjs 从登记表 §1 主表解析（登记表删条目/改号后，
 * 引用旧编号的注解立即红：条目失真即护栏失真）。
 *
 * 范围裁定（W24 扩围）：`packages/renderer/src/**` + `packages/core/src/**` 全域（W4 首版
 * 仅 stores/，扩围随 W24 调用图收紧同批——plan W4 遗留裁决）。runtime/ 主进程不在 GUI
 * 数据层，不扫。模块级 = Program 顶层声明；defineStore setup 函数体内的 ref/new Map 是
 * store 实例状态（pinia 管理生命周期），不属本规则目标形态，函数作用域声明一律放行。
 *
 * 检测形态口径（W24 细化）：
 * - 容器构造（new Map/Set/WeakMap）仅空构造视为「运行时填充的可变缓存」；带初始化
 *   字面量参数（new Set(['a','b'])）= 模块级常量查表，放行——扩围后常量集合大量存在，
 *   一刀切报空容器外的形态会淹没真实缓存信号（字面量初始化后仍运行时写的罕见形态归 S1）；
 * - ref/shallowRef/reactive 无论初始值一律检测（响应式原语本质可变，初始值不代表常量性）。
 *
 * 豁免（plan W4 步骤 1 指定 + W24 扩围沿用）：
 * - 测试文件（.test.ts / .spec.ts / __tests__/）；
 * - useSessionScopedState 内部实现（ADR-0049 原语本体——session 隔离基础设施自身持有
 *   模块级 registry/partition Map，是范式源头而非违规，原语本体豁免登记于 EXEMPT_FILES）。
 *
 * 误报豁免闭环（对齐 check-domain-boundaries allowlist 先例）：规则拦到合法缓存时，
 * 豁免路径 = 先在 data-source-registry.md 补条目/例外，再加行内豁免注释
 * `taste:allow-no-data-owner`（禁止只加注释不登记——登记表是 S1/R2/R3 共同依据）。
 */
import { loadRegistryEntries } from '../lib/parse-registry.mjs'

/** ADR-0049 原语本体豁免（见文件头注释）：renderer 兼容 re-export 层 + core SSOT 实现 */
const EXEMPT_FILES = [
  // re-export 兼容层，不持有逻辑（core SSOT 的 renderer 壳）
  'composables/useSessionScopedState.ts',
  // 原语本体：sessionCleanupRegistry（模块级 Set）+ Map 分区范式的源头
  'foundation/use-session-scoped-state.ts',
]

/** R3 扫描范围（W24 扩围：renderer + core 全域；runtime/ 主进程不在 GUI 数据层） */
const SCOPE_RE = /(^|\/)(packages\/renderer\/src|packages\/core\/src)\//

/** 视为「模块级缓存声明」的初始化形态：可变容器构造 + Vue 可变响应式原语 */
const CONTAINER_CTORS = new Set(['Map', 'Set', 'WeakMap'])
const REACTIVE_FNS = new Set(['ref', 'shallowRef', 'reactive'])

const DATA_OWNER_RE = /@data-owner\s+(\S+)/
const INLINE_ALLOW_RE = /taste:allow-no-data-owner/

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require @data-owner <registry entry> annotation on module-level cache declarations ' +
        '(data-source-governance R3, renderer+core full scope since W24)',
    },
    schema: [],
    messages: {
      missingOwner:
        '模块级缓存声明缺少 @data-owner 注解（data-source-governance R3）。' +
        '先在 docs/architecture/data-source-registry.md 登记条目（新增条目或并入既有条目），' +
        '再在声明处加注释 `@data-owner <登记表条目编号>`（如 `@data-owner #1`）；' +
        '非 GUI 数据的技术结构 / 已登记例外：行内豁免注释 taste:allow-no-data-owner（须登记表同步例外）。',
      unknownEntry:
        '@data-owner 注解引用的条目 {{entry}} 不在 docs/architecture/data-source-registry.md 登记表内。' +
        '改用真实条目编号，或先在登记表补该条目。' +
        '确属合法缓存且不适用既有条目：先登记表补条目/例外，再加行内豁免注释 taste:allow-no-data-owner。',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? ''

    if (!filename.endsWith('.ts')) return {}
    // W24 扩围范围：renderer + core 全域（见文件头「范围裁定」）
    if (!SCOPE_RE.test(filename)) return {}
    // 豁免：测试文件（测试构造数据的缓存非生产状态）
    if (
      filename.includes('.test.') ||
      filename.includes('.spec.') ||
      filename.includes('__tests__')
    ) {
      return {}
    }
    // 豁免：ADR-0049 原语本体（EXEMPT_FILES 按路径后缀匹配，仓库布局无关）
    if (EXEMPT_FILES.some((suffix) => filename.endsWith(suffix))) return {}

    const sourceCode = context.sourceCode ?? context.getSourceCode?.()
    const registryEntries = loadRegistryEntries()

    /**
     * 检查声明是否带有效 @data-owner 注解（相邻上方注释块或同行尾注释）。
     * 返回 { messageId, entry }（违规时）或 null（合规/已豁免）。
     *
     * W24 改用源码行回溯而非 getCommentsBefore/After：eslint 注释 attach 对
     * `export const`（注释挂到外层 ExportNamedDeclaration，内层 VariableDeclaration
     * 拿不到）等形态不稳定——同构声明有的拿到有的拿不到。按源码物理行回溯（声明行 +
     * 向上连续注释行，遇空行/代码行断）语义与 W4 完全一致，且对 docstring 块中部的
     * @data-owner 也能归属（块内部行以 * 开头参与回溯）。
     */
    function collectAttachedText(node) {
      const startLine = node.loc.start.line // 1-based
      const lines = sourceCode.lines
      const texts = [lines[startLine - 1] ?? ''] // 声明行（同行尾注释）
      for (let i = startLine - 2; i >= 0; i -= 1) {
        const t = (lines[i] ?? '').trim()
        if (t === '') break // 空行断——防止拿文件头/远处注释冒充注解
        if (
          t.startsWith('//') ||
          t.startsWith('/*') ||
          t.startsWith('*')
        ) {
          texts.push(t)
          continue
        }
        break // 代码行断
      }
      return texts.join('\n')
    }

    function checkAnnotation(node) {
      const attachedText = collectAttachedText(node)
      if (INLINE_ALLOW_RE.test(attachedText)) return null

      const match = DATA_OWNER_RE.exec(attachedText)
      if (!match) return { messageId: 'missingOwner' }
      const entry = match[1]
      if (!registryEntries.has(entry)) {
        return { messageId: 'unknownEntry', entry }
      }
      return null
    }

    function isCacheInit(init) {
      if (!init) return false
      if (init.type === 'NewExpression' && init.callee.type === 'Identifier') {
        if (!CONTAINER_CTORS.has(init.callee.name)) return false
        // 空构造 = 运行时填充的可变缓存；带字面量参数 = 常量查表（W24 口径，见 docstring）
        return init.arguments.length === 0
      }
      if (init.type === 'CallExpression' && init.callee.type === 'Identifier') {
        return REACTIVE_FNS.has(init.callee.name)
      }
      return false
    }

    return {
      VariableDeclaration(node) {
        // 模块级 = Program 直接子节点（export const 经 ExportNamedDeclaration 包裹一层）
        const parent = node.parent
        const isModuleLevel =
          parent.type === 'Program' ||
          (parent.type === 'ExportNamedDeclaration' &&
            parent.parent.type === 'Program')
        if (!isModuleLevel) return
        if (!node.declarations.some((d) => isCacheInit(d.init))) return

        const violation = checkAnnotation(node)
        if (violation) {
          context.report({
            node,
            messageId: violation.messageId,
            data: violation.entry !== undefined ? { entry: violation.entry } : {},
          })
        }
      },
    }
  },
}
