/**
 * 品味规则（renderer-deepening D6③ / 验收 A8）：组件只碰 chat store 的 readers 面
 *
 * chat store 公共面约 60 项混装（状态 refs + 读方法 + 写操作 + LRU + 订阅类），
 * D6 按「组件渲染需要 vs 编排动作」切成两个 facet 类型（packages/core/src/domain/chat/store.ts）：
 * - ChatStoreReaders：状态 refs + 纯读查询（组件渲染可碰面）；
 * - ChatStoreOps：写操作 + LRU + 订阅类 + testInternals（编排/composable 专用面）。
 *
 * 本规则把 ops 面在组件层的可见性变成 lint 红灯：src/components/** 的 .vue 内对
 * chat store 实例的 ops 字段访问（读/写/调用一律拦——编排动作在组件内联是被拦形态，
 * 正确路径是下沉 composable，参照 useSubagentTabData.ts 先例）。
 *
 * 检测形态（对齐 no-non-owner-store-mutation 的工厂识别口径）：
 * - `const chat = useChatStore()` 后 `chat.<opsField>`（script 与 template 表达式同拦）；
 * - `useChatStore().<opsField>()` 直调；
 * - 本文件工厂包装（`function getChat() { return useChatStore() }` 后 `getChat().<opsField>`）。
 *
 * 候选统一在 Program:exit 裁决（no-non-owner-store-mutation 同款）：工厂包装函数的
 * 绑定可能声明晚于使用点（const 箭头 + hoisted function 的组合形态），单遍词法序
 * 会漏检；收集与裁决分相位消解。
 *
 * 已知不追踪（与 no-non-owner-store-mutation 的检出边界声明同精神，S1 review 兜底）：
 * - storeToRefs 解构后字段脱离接收者（`const { evictIfNeeded } = storeToRefs(chat)`）——
 *   pinia 对 action 的 storeToRefs 解构会丢失 this 绑定，运行即坏，不为此扩规则复杂度；
 * - 跨文件转发（ops 引用经 props 传入组件）：props 形态的类型约束由 facet 类型承担。
 *
 * OPS_FIELDS 清单 SSOT = ChatStoreOps（packages/core/src/domain/chat/store.ts，
 * ChatStoreOps 与 ChatStoreReaders 的差集）；store.ts 内有编译期完备性/互斥断言
 * （_FacetCoversAllKeys / _FacetsDisjoint），return 面增删字段时两处同步改。
 *
 * 误报豁免：无行内豁免通道（facet 边界是类型级事实不是裁量判断——字段该在哪个
 * 面由 store.ts 的编译期断言锚定，豁免诉求应改为修 facet 划分或下沉 composable）。
 */

/** chat store ops 面字段清单（= ChatStoreOps 键集，与 ChatStoreReaders 互斥不重叠） */
const OPS_FIELDS = new Set([
  // 写操作
  'setChangeSetStatus', 'markChangeSetsSuperseded', 'markHistoryFailed',
  'clearHistoryError', 'hydrate', 'setMessages', 'reconcileHistory',
  'prependHistory', 'applySubagentStreamDelta', 'finalizeSubagentStream',
  'applySubagentEntries', 'appendUser', 'pushPending', 'drainN',
  'reconcilePending', 'abortPending', 'applyMessageEvent', 'finalizeSession',
  'finalizeAllStreaming', 'resetTransientStates', 'addPendingSend',
  'clearPendingSend', 'markSessionError', 'setCompacting', 'setHandingOff',
  'appendSystemNotice', 'appendSubagentDirective', 'truncateFrom',
  'applyFileChanges', 'disposeSession', 'markStreamingBashError',
  // LRU（组 5a sessionEntry 端口吸收后的显式驱逐/触达动作）
  'touchLru', 'evictIfNeeded', 'evictSessionWithVirtual', 'evictVirtualKey',
  // inflight 投递确认计数（steer-bubble u0/D2，main 合并带入）
  'incrementInflight', 'decrementInflight', 'clearInflight',
  // 测试逃生舱（生产零消费是其存在前提）
  'testInternals',
])

/** chat store 工厂的 import 识别：绑定名 + import source 形态（renderer 壳 / core 包出口 / core 深路径） */
const FACTORY_NAMES = new Set(['useChatStore', 'createChatStore'])
const STORE_SOURCE_RE =
  /(^|\/)stores\/chat(\.ts)?$|^@taiji\/core$|\/domain\/chat(\/(store|index))?(\.ts)?$/

/** 函数节点类型（ReturnStatement 向上找最近包含函数的终止条件） */
const FUNCTION_TYPES = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']

/** 规则域 gate：仅组件目录下的 .vue 受限（composables/stores/effects/tests 文件不受限）；
 *  组件目录内嵌的测试壳（__tests__ / *.spec.vue / *.test.vue）属测试基建，一并放行 */
function shouldSkipFile(filename) {
  if (!filename.endsWith('.vue')) return true
  if (!/\/src\/components\//.test(filename)) return true
  return filename.includes('.test.') || filename.includes('.spec.') || filename.includes('__tests__')
}

/** 从 return 语句向上找最近包含函数并解析其绑定名（函数声明名 / const 赋值名 / 对象方法名），
 *  无名形态返回 null */
function resolveEnclosingFnName(node) {
  let fn = node.parent
  while (fn && !FUNCTION_TYPES.includes(fn.type)) {
    fn = fn.parent
  }
  if (!fn) return null
  if (fn.type === 'FunctionDeclaration' && fn.id) return fn.id.name
  if (fn.parent?.type === 'VariableDeclarator' && fn.parent.id.type === 'Identifier') {
    return fn.parent.id.name
  }
  if (fn.parent?.type === 'Property' && fn.parent.key.type === 'Identifier') return fn.parent.key.name
  return null
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow accessing chat store ops-face fields from components — components may only ' +
        'consume the ChatStoreReaders facet (renderer-deepening D6/A8)',
    },
    schema: [],
    messages: {
      chatOpsInComponent:
        'chat store 的 ops 面字段 {{field}} 不能在组件内访问（chat store facet 约束，renderer-deepening D6）。\n' +
        '组件只面对 readers 面（ChatStoreReaders：状态 refs + 纯读方法）；编排动作请下沉 composable ' +
        '（参照 packages/renderer/src/composables/panel/useSubagentTabData.ts）。\n' +
        'facet 划分与字段清单 SSOT：packages/core/src/domain/chat/store.ts（ChatStoreReaders / ChatStoreOps）。',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? ''
    if (shouldSkipFile(filename)) return {}
    const sourceCode = context.sourceCode ?? context.getSourceCode?.()

    // import 边收集的工厂绑定名
    const factoryBindings = new Set()
    // store 实例变量名（const chat = useChatStore() / const chat = getChat()——文件级宽松集合）
    const instanceBindings = new Set()
    // 返回 store 表达式的本文件函数名（工厂包装形态）
    const storeReturningFns = new Set()
    // 表达式体箭头工厂候选（词法序陷阱：声明晚于引用，Program:exit 统一解析）
    const pendingExprBodyArrows = []
    // 实例声明候选 { name, callee }：callee 解析延迟到 Program:exit（包装工厂绑定可能晚于声明）
    const pendingInstanceDecls = []
    // ops 字段访问候选：{ node, field, obj }——Program:exit 统一裁决（绑定可能晚于访问点）
    const candidates = []

    /** 表达式是否追溯到 store（实例变量 or 工厂/包装工厂调用直连） */
    function isStoreExpr(node) {
      if (node.type === 'Identifier') return instanceBindings.has(node.name)
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        return factoryBindings.has(node.callee.name) || storeReturningFns.has(node.callee.name)
      }
      return false
    }

    /** 绑定集终态解析（延迟解析候选 → 终态绑定集合）。幂等可重入：
     *  表达式体箭头工厂与实例声明的解析在绑定集合上单调收敛。 */
    function resolveBindings() {
      for (const { name, body } of pendingExprBodyArrows) {
        if (name && isStoreExpr(body)) storeReturningFns.add(name)
      }
      for (const { name, callee } of pendingInstanceDecls) {
        if (factoryBindings.has(callee) || storeReturningFns.has(callee)) instanceBindings.add(name)
      }
    }

    /** 候选裁决上报（消费即清空，幂等无重复报告） */
    function flushCandidates() {
      // 工厂激活前提：文件 import 了 chat store 工厂（无 import 边 = 同名巧合变量，放行）
      if (factoryBindings.size === 0) {
        candidates.length = 0
        return
      }
      for (const candidate of candidates) {
        const { node, field, obj } = candidate
        if (!isStoreExpr(obj)) continue
        context.report({ node, messageId: 'chatOpsInComponent', data: { field } })
      }
      candidates.length = 0
    }

    /** script 与 template 表达式共用的 ops 访问候选收集 */
    function collectMemberExpression(node) {
      if (node.property.type !== 'Identifier') return
      if (!OPS_FIELDS.has(node.property.name)) return
      if (node.object.type !== 'Identifier' && node.object.type !== 'CallExpression') return
      candidates.push({ node, field: node.property.name, obj: node.object })
    }

    const scriptVisitors = {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return
        if (!STORE_SOURCE_RE.test(node.source.value)) return
        for (const spec of node.specifiers) {
          if (spec.type !== 'ImportSpecifier' && spec.type !== 'ImportDefaultSpecifier') continue
          const importedName =
            spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier'
              ? spec.imported.name
              : spec.local.name
          if (FACTORY_NAMES.has(importedName)) factoryBindings.add(spec.local.name)
        }
      },

      VariableDeclarator(node) {
        if (
          node.init?.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          node.id.type === 'Identifier'
        ) {
          pendingInstanceDecls.push({ name: node.id.name, callee: node.init.callee.name })
        }
      },

      ArrowFunctionExpression(node) {
        // 表达式体箭头工厂（const grab = () => useChatStore()）：body 无 ReturnStatement
        // 节点，ReturnStatement 访问器不可见——收集进 pending，Program:exit 统一解析
        if (node.body.type !== 'BlockStatement') {
          let name = null
          if (node.parent?.type === 'VariableDeclarator' && node.parent.id.type === 'Identifier') {
            name = node.parent.id.name
          }
          pendingExprBodyArrows.push({ name, body: node.body })
        }
      },

      ReturnStatement(node) {
        if (!node.argument || !isStoreExpr(node.argument)) return
        // 最近包含命名函数即工厂包装主体
        const name = resolveEnclosingFnName(node)
        if (name) storeReturningFns.add(name)
      },

      MemberExpression: collectMemberExpression,

      'Program:exit'() {
        resolveBindings()
        flushCandidates()
      },
    }

    // template 表达式（mustache / 指令值）不在 script Program 的默认遍历内——经
    // vue-eslint-parser 的 defineTemplateBodyVisitor 注册 template body 访问器。
    // 时序契约：template body 遍历晚于 script Program 遍历（探针实证 + vue 官方规则
    // 同款依赖），template 访问器运行时 script 侧绑定集已终态——即时裁决；绑定解析
    // 与候选消费均幂等，重复调用无双报。
    const templateVisitors = {
      MemberExpression(node) {
        collectMemberExpression(node)
        resolveBindings()
        flushCandidates()
      },
    }
    const services = sourceCode?.parserServices
    if (typeof services?.defineTemplateBodyVisitor === 'function') {
      // 注意参数序：defineTemplateBodyVisitor(templateBodyVisitor, scriptVisitor)
      return services.defineTemplateBodyVisitor(templateVisitors, scriptVisitors)
    }
    return scriptVisitors
  },
}
