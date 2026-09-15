/**
 * 品味规则（data-source-governance R2）：store mutation 只能被 owner 文件调用
 *
 * W24 起从「拦直呼形态」升级为「文件内调用图分析」：受管 mutation 的调用许可来自
 * 数据源登记表（docs/architecture/data-source-registry.md，父文档 §3.6 R2：许可表
 * 来自登记表，登记表条目驱动逐步收紧）。检测面 = import 边 + 函数级转发（一层起步）：
 *
 * 1. 直呼（W4 保留）：`store.applySnapshot(...)` / `useSessionStore().applySnapshot(...)`；
 * 2. 形参转发（一层）：`f(store)` 实参是 store 实例/工厂调用 → 被调函数对应形参成为
 *    store 写通道 → 该形参在函数体内调受管 mutation → 报错（三层链：caller → f →
 *    mutation，W4 直呼版对形参形态不可见，本条是其超集证明）；
 * 3. 方法引用传递：`g(store.applySnapshot)` 把受管方法引用作为值传递（脱离接收者后
 *    可在任意回调内被调，等价转发）——W4 docstring 点名的检出边界，本版收口；
 * 4. 工厂包装：本文件函数 return store 表达式 → getStore().applySnapshot(...)。
 *    W24 R2 收口后覆盖四形态：函数 return 语句、表达式体箭头（const grab = () =>
 *    useSessionStore()——无 ReturnStatement 节点，收集进 pending 列表、Program:exit
 *    统一解析以消解「body 引用的绑定声明晚于箭头」词法序陷阱）、对象方法（const box =
 *    { grab() { return useSessionStore() } }——函数名取 Property key）及其调用点
 *    MemberExpression receiver（box.grab().applySnapshot(...)——直接调用与双重包装同报）。
 *
 * 已知检出边界（docstring 声明，S1 语义层兜底——父文档 §3.6 现状诚实声明）：
 * - 转发函数定义在其他文件（import 进来的函数吃 store 实参）：调用方文件内不可判定，
 *   跨文件数据流静态不可判定处维持 S1；检测激活前提 = 本文件 import store 工厂，
 *   port 注入形态（core useChat/use-session 经 type-only import 接收 store）因此天然放行；
 * - 形参转发只追一层（实参直接绑定 store 表达式），「形参再传形参」的深层链不追；
 * - 解构/rest 形参、同名函数作用域混淆等间接形态不追踪（文件级宽松集合，同 W4 精度）；
 * - 对象方法 receiver 裁决按方法名命中文件级工厂集合（box.grab() 的 grab 与任意
 *   return store 的函数视为同一通道）：同名属性碰撞的理论误报可接受（文件级宽松集合
 *   精度，与形参转发声明一致；全仓 lint 0 errors 实测把关）；
 * - computed key 定义/调用（obj['grab']() / obj[k](){...}）、IIFE 工厂
 *   （(function(){return useSessionStore()})()）、赋值表达式箭头（g = () => store，
 *   非 const 声明形态）、类方法（MethodDefinition）等生僻间接形态不追踪，归 S1。
 *
 * 许可表（登记表驱动）：PERMITTED_FILES 每条挂登记表条目号，运行时经
 * taste-lint/lib/parse-registry.mjs 对照登记表 §1 主表校验——条目失效（登记表删条目/
 * 改号）= 护栏配置失真，对每个被检文件报 stalePermittedEntry。
 *
 * 误报豁免闭环（对齐 check-domain-boundaries allowlist 先例）：规则拦到合法写入时，
 * 豁免路径 = 先在 data-source-registry.md 补条目/例外 + 本文件 PERMITTED_FILES 登记，
 * 再加行内豁免注释 `taste:allow-non-owner-mutation`——禁止只加注释不登记。
 */

import { loadRegistryEntries, findStaleEntries } from '../lib/parse-registry.mjs'

/** 受管 mutation → 登记表条目引用（登记表 §1 主表；新增受管 mutation 须先在登记表落条目）。
 *  W13 起三入口（setGroups/updateLabel/updateSessionState）收敛为唯一写入口 applySnapshot。 */
const WATCHED_MUTATIONS = {
  applySnapshot: {
    entries: ['#1', '#2'],
    note: '#1（renderer 三路写）/ #2（session 列表载入 + modelId/thinkingLevel 局部更新）——W13 起唯一写入口',
  },
}

/** session store 工厂的 import 识别：绑定名 + import source 形态（renderer 壳 / core 包出口 / core 深路径） */
const STORE_FACTORY_NAMES = new Set(['useSessionStore', 'createSessionStore'])
const STORE_SOURCE_RE =
  /(^|\/)stores\/session(\.ts)?$|^@taiji\/core$|\/domain\/session(\/(store|index))?(\.ts)?$/

/**
 * 许可文件（按路径后缀匹配）。owner 定义处 + 登记表声明的现行写路径实现文件，
 * 每条挂登记表条目号（运行时对照登记表校验——「许可表来自登记表」的机检形态）；
 * 收紧 = owner 化 wave 落地后删除对应条目（登记表条目驱动逐步收紧）。
 */
const PERMITTED_FILES = [
  // owner：mutation 定义处（pinia 注册壳）
  { suffix: 'packages/renderer/src/stores/session.ts', entries: ['#1'] },
  // owner：mutation 定义处（core factory 本体）
  { suffix: 'packages/core/src/domain/session/store.ts', entries: ['#1'] },
  // #1/#2 现行写路径：applySnapshot 唯一写入口的整表形态（config.sessions 广播/列表载入）+ rename 乐观更新
  {
    suffix: 'packages/renderer/src/composables/features/sidebar/useSidebar.ts',
    entries: ['#1', '#2'],
  },
  // #1 现行写路径：applySnapshot 单 session 乐观更新（switchModel/setThinkingLevel）
  {
    suffix: 'packages/renderer/src/composables/features/model/useModel.ts',
    entries: ['#1', '#2'],
  },
]

const INLINE_ALLOW_RE = /taste:allow-non-owner-mutation/

// ── Program:exit 裁决子阶段（模块级提取：Program:exit 只做编排，各阶段独立可测）──

/**
 * 许可表条目失真检测（登记表驱动：条目失效即护栏失真）。
 *
 * 必须先于 factoryBindings 提前 return 执行：不 import store 工厂的文件（core 包
 * 多数文件）也要跑，否则护栏配置失真在这些文件上静默。loadRegistryEntries 模块级
 * 缓存，多文件 lint 零增量成本。取舍：多文件 lint 时同一 stale 每文件报一次
 * （ESLint 规则实例 per-file、无跨文件去重通道；模块级去重状态会破坏测试用例
 * 隔离）——重复不改变 fail-loud 语义与 CI 判定，接受。
 */
function reportStalePermittedEntries(context, sourceCode) {
  const permittedForCheck = [
    ...PERMITTED_FILES,
    ...Object.entries(WATCHED_MUTATIONS).map(([name, w]) => ({
      suffix: `WATCHED_MUTATIONS.${name}`,
      entries: w.entries,
    })),
  ]
  const stale = findStaleEntries(permittedForCheck, loadRegistryEntries())
  const programNode = sourceCode?.ast
  for (const { entry, suffix } of stale) {
    if (programNode) {
      context.report({
        node: programNode,
        messageId: 'stalePermittedEntry',
        data: { entry, suffix },
      })
    }
  }
}

/** 行内豁免注释探测：node 前后注释任一命中 taste:allow-non-owner-mutation */
function hasInlineAllowComment(sourceCode, node) {
  return Boolean(
    sourceCode &&
      [
        ...sourceCode.getCommentsBefore(node),
        ...sourceCode.getCommentsAfter(node),
      ].some((c) => INLINE_ALLOW_RE.test(c.value)),
  )
}

/**
 * 形参通道表：形参名 → 绑定函数名集合。
 *
 * f(store) 的 f 是本文件函数 → 第 idx 个 Identifier 形参绑定 store。
 * 多函数绑定：f(store) 与 g(store) 并存时两个函数都建通道——按形参名
 * last-write-wins 会漏报被覆盖函数体内的调用。
 */
function buildParamOwnerFn(paramChannels, fnDecls) {
  const paramOwnerFn = new Map()
  for (const { fnName, idx } of paramChannels) {
    const params = fnDecls.get(fnName)
    if (!params) continue // 外部 import 函数：跨文件数据流不可判定，S1 兜底
    const paramName = params[idx]
    if (!paramName) continue
    let owners = paramOwnerFn.get(paramName)
    if (!owners) paramOwnerFn.set(paramName, (owners = new Set()))
    owners.add(fnName)
  }
  return paramOwnerFn
}

/** CallExpression receiver 裁决（工厂直连 / 工厂包装 / 对象方法双重包装）→ 裁决或 null */
function classifyCallReceiver(obj, mutation, bindings) {
  const base = { mutation, entries: WATCHED_MUTATIONS[mutation].note }
  if (obj.callee.type === 'Identifier') {
    if (bindings.factoryBindings.has(obj.callee.name)) {
      return { messageId: 'nonOwnerMutation', data: base }
    }
    if (bindings.storeReturningFns.has(obj.callee.name)) {
      return { messageId: 'wrappedFactoryMutation', data: { ...base, fn: obj.callee.name } }
    }
    return null
  }
  // box.grab().applySnapshot()：receiver 工厂是对象方法（方法名命中文件级工厂集合，
  // 同名属性碰撞的理论误报已在 docstring「已知检出边界」声明）
  if (
    obj.callee.type === 'MemberExpression' &&
    obj.callee.property.type === 'Identifier' &&
    bindings.storeReturningFns.has(obj.callee.property.name)
  ) {
    return {
      messageId: 'wrappedFactoryMutation',
      data: { ...base, fn: obj.callee.property.name },
    }
  }
  return null
}

/** 单个受管 mutation 调用候选分类（Identifier / CallExpression receiver 两形态）→ 裁决或 null */
function classifyMutationCandidate(obj, stack, mutation, bindings) {
  const base = { mutation, entries: WATCHED_MUTATIONS[mutation].note }
  if (obj.type === 'Identifier') {
    if (bindings.instanceBindings.has(obj.name)) {
      return { messageId: 'nonOwnerMutation', data: base }
    }
    if (
      bindings.paramOwnerFn.has(obj.name) &&
      // 同名形参多函数绑定：fnStack 命中任一绑定函数即报（非 last-write-wins）
      stack.some((fn) => bindings.paramOwnerFn.get(obj.name).has(fn))
    ) {
      return { messageId: 'forwardedMutation', data: { ...base, param: obj.name } }
    }
    return null
  }
  if (obj.type === 'CallExpression') return classifyCallReceiver(obj, mutation, bindings)
  return null
}

/** 裁决并上报受管 mutation 调用候选（行内豁免注释放行） */
function reportMutationCandidates(candidates, bindings, sourceCode, context) {
  for (const { node, mutation, fnStack: stack, obj } of candidates) {
    const verdict = classifyMutationCandidate(obj, stack, mutation, bindings)
    if (!verdict) continue
    if (hasInlineAllowComment(sourceCode, node)) continue
    context.report({ node, messageId: verdict.messageId, data: verdict.data })
  }
}

/** 上报值位置受管方法引用（detachedMethodRef，行内豁免注释放行） */
function reportDetachedMethodRefs(methodRefs, sourceCode, context) {
  for (const ref of methodRefs) {
    if (hasInlineAllowComment(sourceCode, ref)) continue
    context.report({
      node: ref,
      messageId: 'detachedMethodRef',
      data: {
        mutation: ref.property.name,
        entries: WATCHED_MUTATIONS[ref.property.name].note,
      },
    })
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow calls to registered store mutations outside permitted owner files, ' +
        'including one-hop intra-file forwarding (data-source-governance R2: import-edge + ' +
        'function-level call-graph detection)',
    },
    schema: [],
    messages: {
      nonOwnerMutation:
        'store mutation {{mutation}} 只能被许可文件直呼，当前文件不在许可表内（登记条目：{{entries}}）。' +
        '合法路径：改经 owner 文件暴露的编排方法；确属新增合法写方：先在 docs/architecture/data-source-registry.md ' +
        '补条目/例外并在规则 PERMITTED_FILES 登记，或加行内豁免注释 taste:allow-non-owner-mutation。',
      forwardedMutation:
        'store mutation {{mutation}} 经本文件函数转发调用（形参 {{param}} 由实参绑定到 store 实例），' +
        '非许可文件不得以转发形态写 store（登记条目：{{entries}}）。' +
        '合法路径：把该编排移入 owner 文件（docs/architecture/data-source-registry.md 登记条目）' +
        '或经 owner 暴露的方法；确属合法转发：登记表补例外 + 行内豁免注释 taste:allow-non-owner-mutation。',
      wrappedFactoryMutation:
        'store mutation {{mutation}} 经本文件工厂包装函数 {{fn}}() 间接触达 store（登记条目：{{entries}}）。' +
        '包装不改变非许可文件写 store 的事实；豁免同上：登记表补例外 + 行内豁免注释。',
      detachedMethodRef:
        '受管 mutation 方法引用 {{mutation}} 被作为值传递/脱离 store 接收者持有（登记条目：{{entries}}）——' +
        '脱离接收者后可在任意回调内被调，等价于转发写入口。合法路径：改为显式调用或在 owner 文件内收口；' +
        '确属合法：在 docs/architecture/data-source-registry.md 补条目/例外 + 行内豁免注释 taste:allow-non-owner-mutation。',
      stalePermittedEntry:
        '规则许可表引用的登记条目 {{entry}}（许可文件 {{suffix}}）不在 docs/architecture/data-source-registry.md ' +
        '登记表内——护栏配置失真（登记表条目已删/改号？）。修复：登记表 §1 主表与规则 PERMITTED_FILES ' +
        '双向核对后再提交。',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? ''

    if (
      filename.includes('.test.') ||
      filename.includes('.spec.') ||
      filename.includes('__tests__')
    ) {
      return {}
    }
    if (PERMITTED_FILES.some((item) => filename.endsWith(item.suffix))) return {}

    // store 工厂绑定名（import { useSessionStore } from '@/stores/session' 等）
    const factoryBindings = new Set()
    // store 实例变量名（const s = useSessionStore()，任意作用域——文件级宽松集合，同 W4 精度）
    const instanceBindings = new Set()
    // 本文件函数定义：函数名 → 形参名数组（只记 Identifier 形参，位置对齐 arguments 下标）
    const fnDecls = new Map()
    // 返回 store 表达式的本文件函数名（工厂包装形态）
    const storeReturningFns = new Set()
    // 表达式体箭头工厂候选 { name, body }：body 无 ReturnStatement 节点，且 body 引用的
    // 绑定可能声明晚于箭头（词法序陷阱）——Program:exit 统一解析（与 candidates 裁决同相位）
    const pendingExprBodyArrows = []
    // 实参为 store 表达式的本地函数调用（形参通道候选）
    const paramChannels = []
    // 受管 mutation 调用候选：{ node, mutation, fnStack, obj }——Program:exit 统一裁决
    // （合法 JS 允许「声明晚于引用」，单遍词法序会漏检，W4 先例）
    const candidates = []
    // 值位置的受管方法引用（g(store.applySnapshot) / const h = store.applySnapshot）
    const methodRefs = []
    // 当前函数名栈（FunctionDeclaration/FunctionExpression/ArrowFunctionExpression 进出）
    const fnStack = []

    const enterFn = (node) => {
      let name = null
      if (node.type === 'FunctionDeclaration' && node.id) name = node.id.name
      else if (
        node.parent &&
        node.parent.type === 'VariableDeclarator' &&
        node.parent.id.type === 'Identifier'
      ) {
        name = node.parent.id.name
      } else if (
        node.parent &&
        node.parent.type === 'Property' &&
        node.parent.key.type === 'Identifier'
      ) {
        // 对象方法（{ grab() {...} } / { grab: () => ... }）：函数名取 Property key
        name = node.parent.key.name
      }
      if (name && node.params) {
        fnDecls.set(
          name,
          node.params.map((p) => (p.type === 'Identifier' ? p.name : null)),
        )
      }
      // 表达式体箭头工厂（const grab = () => useSessionStore()）：body 无 ReturnStatement
      // 节点，ReturnStatement 访问器不可见——收集进 pending，Program:exit 统一解析
      if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') {
        pendingExprBodyArrows.push({ name, body: node.body })
      }
      fnStack.push(name)
    }
    const exitFn = () => fnStack.pop()

    /** 表达式是否追溯到 store（实例变量 or 工厂调用直连） */
    function isStoreExpr(node) {
      if (node.type === 'Identifier') return instanceBindings.has(node.name)
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        return factoryBindings.has(node.callee.name)
      }
      return false
    }

    return {
      ImportDeclaration(node) {
        // type-only import 不引入运行时绑定，不构成直呼通道
        if (node.importKind === 'type') return
        if (!STORE_SOURCE_RE.test(node.source.value)) return
        for (const spec of node.specifiers) {
          if (
            spec.type === 'ImportDefaultSpecifier' ||
            spec.type === 'ImportSpecifier'
          ) {
            const importedName =
              spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier'
                ? spec.imported.name
                : spec.local.name
            if (STORE_FACTORY_NAMES.has(importedName)) {
              factoryBindings.add(spec.local.name)
            }
          }
        }
      },

      VariableDeclarator(node) {
        if (
          node.init?.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          factoryBindings.has(node.init.callee.name) &&
          node.id.type === 'Identifier'
        ) {
          instanceBindings.add(node.id.name)
        }
      },

      'FunctionDeclaration': enterFn,
      'FunctionDeclaration:exit': exitFn,
      'FunctionExpression': enterFn,
      'FunctionExpression:exit': exitFn,
      'ArrowFunctionExpression': enterFn,
      'ArrowFunctionExpression:exit': exitFn,

      ReturnStatement(node) {
        // 工厂包装：本文件函数 return store 表达式
        if (!node.argument || !isStoreExpr(node.argument)) return
        const owner = [...fnStack].reverse().find(Boolean)
        if (owner) storeReturningFns.add(owner)
      },

      CallExpression(node) {
        const { callee } = node
        if (callee.type === 'MemberExpression') {
          if (callee.property.type !== 'Identifier') return
          const mutation = callee.property.name
          if (!Object.prototype.hasOwnProperty.call(WATCHED_MUTATIONS, mutation)) {
            return
          }
          if (
            callee.object.type === 'Identifier' ||
            (callee.object.type === 'CallExpression' &&
              (callee.object.callee.type === 'Identifier' ||
                // box.grab().applySnapshot()：receiver 工厂是对象方法调用（双重包装逃逸收口）
                callee.object.callee.type === 'MemberExpression'))
          ) {
            candidates.push({
              node,
              mutation,
              fnStack: [...fnStack],
              obj: callee.object,
            })
          }
          return
        }
        if (callee.type === 'Identifier') {
          // f(store) / f(useSessionStore())：实参绑定 store → 被调函数形参成写通道候选
          node.arguments.forEach((arg, idx) => {
            if (isStoreExpr(arg)) paramChannels.push({ fnName: callee.name, idx })
          })
        }
      },

      MemberExpression(node) {
        // 值位置的受管方法引用（非 callee 位置——callee 位置由 CallExpression 收）
        if (node.property.type !== 'Identifier') return
        if (!Object.prototype.hasOwnProperty.call(WATCHED_MUTATIONS, node.property.name)) {
          return
        }
        const parent = node.parent
        if (parent && parent.type === 'CallExpression' && parent.callee === node) return
        if (isStoreExpr(node.object)) methodRefs.push(node)
      },

      'Program:exit'() {
        const sourceCode = context.sourceCode ?? context.getSourceCode?.()

        // 阶段 1：许可表条目失真检测（登记表驱动）——须先于 factoryBindings 提前 return，
        // 细节与取舍见 reportStalePermittedEntries docstring
        reportStalePermittedEntries(context, sourceCode)

        // 阶段 2 激活前提：文件 import 了 store 工厂（无 import 边 = port 注入/无关联，W4 语义对齐）
        if (factoryBindings.size === 0) return

        // 阶段 3：形参通道表构建（f(store) 形参绑定，多函数绑定语义）
        const paramOwnerFn = buildParamOwnerFn(paramChannels, fnDecls)

        // 阶段 4：表达式体箭头工厂——词法序陷阱在此统一消解（instanceBindings/factoryBindings 已齐）
        for (const { name, body } of pendingExprBodyArrows) {
          if (name && isStoreExpr(body)) storeReturningFns.add(name)
        }

        // 阶段 5/6：候选裁决上报 + 方法引用上报（行内豁免注释放行）
        const bindings = {
          instanceBindings,
          factoryBindings,
          storeReturningFns,
          paramOwnerFn,
        }
        reportMutationCandidates(candidates, bindings, sourceCode, context)
        reportDetachedMethodRefs(methodRefs, sourceCode, context)
      },
    }
  },
}
