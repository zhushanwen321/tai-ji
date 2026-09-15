/**
 * 品味规则（context-consistency-design D5 / 护栏 G1）：session 事件 handler 禁止直写组件实例级 ref
 *
 * ADR-0049 的 Map 分区范式只约束 composable，组件内 `const stats = ref(...)` + 订阅
 * session 消息直写是 review 盲区（ContextCapacityPopover 串台/丢值的直接根因）：
 * session 级消息 handler 写入实例级状态时，值的生命周期绑定组件挂载周期而非 session
 * 生命周期，切 session 组件不卸载必然跨 session 污染——结构上无法自证安全（设计文档
 * context-consistency-lint-rule §1），本规则把该形态从盲区变成 pre-commit 红灯。
 *
 * 触发 = 三信号 AND（缺一不报，压误报面到最小，见设计文档 §2）：
 * - S1 defineProps 类型/对象字面量含 sessionId（组件按 session 定向）；
 * - S2 <script setup> 顶层调用 useSessionEvents（按名匹配，不追 import 源——防 alias
 *   绕过的成本高于收益）；
 * - S3 useSessionEvents 返回值被调用时，handler 函数体内 `X.value = ...` /
 *   `X.value.field = ...` 直写，且 X 是本组件 setup 顶层声明的 ref（ref/shallowRef；
 *   useTemplateRef 是 DOM 引用非数据态，天然不在白名单——只按 init callee 名收录）。
 *
 * 明确不检测（防规则膨胀）：
 * - handler 内调 store/composable API（写外部 owner 合法——store 自带分区）；
 * - handler 内只读不写（emit 类无状态转发）；
 * - 非 useSessionEvents 的裸 events.on 订阅（违反「api 调用只在 features 层」既有约束，
 *   归那条约束管，不重复立法）。
 *
 * 误报豁免走行内登记注释 taste:allow-instance-level-session-state（与
 * taste:allow-no-data-owner 同机制——通用 disable 类静默豁免已被既有规则禁止，
 * 登记注释是唯一出口，理由可审计）。
 */
const INLINE_ALLOW_RE = /taste:allow-instance-level-session-state/

/** 视为「组件实例级 ref」的初始化形态（useTemplateRef 不在内：DOM 引用非数据态） */
const REF_INIT_FNS = new Set(['ref', 'shallowRef'])

/** 计入 handler 的函数参数节点类型（命名函数声明不在 onMessage(...) 实参位，非本形态） */
const FN_TYPES = new Set(['ArrowFunctionExpression', 'FunctionExpression'])

/** 「最近包含函数」的边界集合——命名 helper（FunctionDeclaration）算独立函数边界：其体内
 * 的赋值不在 handler 字面函数体内，保守放行（helper 传递形态留给后续收紧，不扩误报面） */
const FN_BOUNDARY_TYPES = new Set([...FN_TYPES, 'FunctionDeclaration'])

/**
 * 提取 `X.value = ...` / `X.value.f... = ...` 赋值目标的根 ref 名。
 * 只认根 Identifier 且紧邻成员为 .value 的链——`props.x.value = ...`（根是 props 成员
 * 访问）与本规则目标形态不同，返回 null 交由上层自然放行。
 */
function extractRefWriteTarget(left) {
  if (left.type !== 'MemberExpression') return null
  const memberChain = [] // 从根到最外层的 property 链
  let cur = left
  while (cur.type === 'MemberExpression') {
    memberChain.unshift(cur.property)
    cur = cur.object
  }
  if (cur.type !== 'Identifier') return null
  const first = memberChain[0]
  if (!first || first.type !== 'Identifier' || first.name !== 'value') return null
  return cur.name
}

/**
 * defineProps 的 props 声明中是否存在 sessionId key。两种声明位都查：
 * - 运行时实参 defineProps({...}) → arguments[0]（ObjectExpression）；
 * - 泛型类型实参 defineProps<{...}>() → typeArguments.params[0]（TSTypeLiteral 及
 *   intersection 递归）。TSTypeLiteral 成员字段是 members（typescript-estree 对齐
 *   TS 原生 AST 命名，非 ESTree 的 properties——已探针核实）。
 */
function propsDeclareSessionId(argNode) {
  if (!argNode) return false
  switch (argNode.type) {
    case 'ObjectExpression':
      return argNode.properties.some(
        (p) =>
          p.type === 'Property' &&
          ((p.key.type === 'Identifier' && p.key.name === 'sessionId') ||
            (p.key.type === 'Literal' && p.key.value === 'sessionId')),
      )
    case 'TSTypeLiteral':
      return argNode.members.some(
        (p) =>
          p.type === 'TSPropertySignature' &&
          p.key.type === 'Identifier' &&
          p.key.name === 'sessionId',
      )
    case 'TSIntersectionType': // defineProps<{A} & {B}> 拆开再查
      return argNode.types.some((t) => propsDeclareSessionId(t))
    default:
      return false
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow writing instance-level refs from session-event handlers in components ' +
        'scoped by sessionId prop (ADR-0049 lifecycle mismatch, context-consistency D5/G1)',
    },
    schema: [],
    messages: {
      instanceLevelSessionState:
        '组件同时持有 sessionId prop、订阅 session 事件、并在 handler 内直写本地 ref（{{refName}}）。\n' +
        'session 级状态的生命周期与组件实例错位会导致切换 session 后丢值/串台（ADR-0049）。\n' +
        '迁移：状态迁入 useSessionScopedState 分区 composable（范式样本 useContextUsage），' +
        'handler 用第二参数 sid 调 updateFor(sid, ...)。确认无跨 session 风险的例外加 ' +
        'taste:allow-instance-level-session-state 登记注释。',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? ''
    if (!filename.endsWith('.vue')) return {}
    const sourceCode = context.sourceCode ?? context.getSourceCode?.()

    // 仅 <script setup> 生效：defineProps/onMessage 宏与 setup 语义绑定，普通 <script>
    //（选项式组件）不出现本反模式组合。优先经 vue-eslint-parser 的文档片段判定，
    // 拿不到 services 时回退源码正则（行为一致性兜底）。
    const services = sourceCode.parserServices ?? context.parserServices
    const fragment = services?.getDocumentFragment?.()
    const isSetup =
      fragment != null
        ? fragment.children.some(
            (el) =>
              el.type === 'VElement' &&
              el.name === 'script' &&
              el.startTag.attributes.some(
                (a) => !a.directive && a.key.name === 'setup',
              ),
          )
        : /<script\b[^>]*\bsetup\b[^>]*>/.test(sourceCode.text ?? sourceCode.getText())
    if (!isSetup) return {}

    let threeSignalsReady = false
    /** useSessionEvents 返回值的接收名（常见 onMessage），S3 按 receiver(...) 调用追 handler */
    const receiverNames = new Set()
    /** setup 顶层声明的 ref 名白名单——只报本组件生命周期持有的 ref，props/import 来源天然放行（T5 语义） */
    const localRefNames = new Set()
    /** receiver(...) 调用中实参位的函数节点集合（ESLint 父先于子访问，收集必先于其体内赋值判定） */
    const handlerFns = new Set()

    /**
     * 检查赋值点是否带行内豁免登记（声明行尾注释 + 向上紧邻注释块）。
     * 与 require-data-owner-annotation 的 collectAttachedText 同款源码行回溯——
     * eslint 注释 attach 对嵌套函数体内的节点不稳定，物理行回溯语义稳定。
     */
    function hasInlineAllow(node) {
      const startLine = node.loc.start.line
      const lines = sourceCode.lines
      const texts = [lines[startLine - 1] ?? '']
      for (let i = startLine - 2; i >= 0; i -= 1) {
        const t = (lines[i] ?? '').trim()
        if (t === '') break
        if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) {
          texts.push(t)
          continue
        }
        break // 代码行断——防止拿远处注释冒充登记
      }
      return INLINE_ALLOW_RE.test(texts.join('\n'))
    }

    /**
     * 收集 <script setup> 顶层语句里的直接调用表达式（两种来源：
     * ExpressionStatement.expression / VariableDeclaration 各 declarator 的 init）。
     * ExpressionStatement.expression 未必是调用（await foo() 是 AwaitExpression）。
     */
    function collectTopLevelCalls(program) {
      const calls = []
      for (const stmt of program.body) {
        if (
          stmt.type === 'ExpressionStatement' &&
          stmt.expression.type === 'CallExpression'
        ) {
          calls.push(stmt.expression)
        }
        if (stmt.type === 'VariableDeclaration') {
          for (const d of stmt.declarations) {
            if (d.init?.type === 'CallExpression') calls.push(d.init)
          }
        }
      }
      return calls
    }

    /** 单个 defineProps 调用是否声明 sessionId：运行时实参 + 泛型类型实参任一命中 */
    function definePropsDeclaresSessionId(expr) {
      // defineProps<{...}>() 泛型形态（ContextCapacityPopover 同款）——类型实参
      // 在 typeArguments.params，不在运行时 arguments
      const typeArg = expr.typeArguments ?? expr.typeParameters
      return (
        propsDeclareSessionId(expr.arguments[0]) ||
        propsDeclareSessionId(typeArg?.params?.[0] ?? null)
      )
    }

    /**
     * 按 callee 名分类单个顶层调用，汇入三信号收集：defineProps → S1 props 信号；
     * useSessionEvents → S2 信号 + receiverNames（S3 按接收名追调用）；
     * ref/shallowRef 初始化 → localRefNames 白名单。
     */
    function classifyTopLevelCall(expr, signals) {
      if (expr.callee.type !== 'Identifier') return
      const name = expr.callee.name
      if (name === 'defineProps') {
        signals.hasSessionIdProp ||= definePropsDeclaresSessionId(expr)
      } else if (name === 'useSessionEvents') {
        signals.callsUseSessionEvents = true
        // S3 只追 Identifier 接收名；解构/未接收形态无以定位调用方，信号不齐即不报
        const decl = expr.parent?.type === 'VariableDeclarator' ? expr.parent : null
        if (decl?.id.type === 'Identifier') receiverNames.add(decl.id.name)
      } else if (
        REF_INIT_FNS.has(name) &&
        expr.parent?.type === 'VariableDeclarator' &&
        expr.parent.id.type === 'Identifier'
      ) {
        localRefNames.add(expr.parent.id.name)
      }
    }

    return {
      // S1/S2/S3 白名单收集都在 <script setup> 顶层（Program.body 即 vue-eslint-parser 的
      // script 顶层语句——已探针验证），一次性静态扫顶层即可，不递归整树。
      Program(program) {
        const signals = { hasSessionIdProp: false, callsUseSessionEvents: false }
        for (const expr of collectTopLevelCalls(program)) {
          classifyTopLevelCall(expr, signals)
        }
        threeSignalsReady =
          signals.hasSessionIdProp && signals.callsUseSessionEvents && receiverNames.size > 0
      },

      CallExpression(node) {
        if (!threeSignalsReady) return
        if (node.callee.type !== 'Identifier' || !receiverNames.has(node.callee.name)) return
        for (const arg of node.arguments) {
          if (FN_TYPES.has(arg.type)) handlerFns.add(arg)
        }
      },

      AssignmentExpression(node) {
        if (!threeSignalsReady || handlerFns.size === 0) return
        const refName = extractRefWriteTarget(node.left)
        if (!refName || !localRefNames.has(refName)) return
        // 最近包含函数必须就是注册 handler 本体——handler 内嵌套函数（setTimeout 回调等）
        // 的写不算「handler 函数体内」，收紧到子文档 §2 S3 的字面口径
        let fn = node.parent
        while (fn && !FN_BOUNDARY_TYPES.has(fn.type)) fn = fn.parent
        if (!fn || !handlerFns.has(fn)) return
        if (hasInlineAllow(node)) return
        context.report({ node, messageId: 'instanceLevelSessionState', data: { refName } })
      },
    }
  },
}
