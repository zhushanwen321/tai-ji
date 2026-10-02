/**
 * blueprint-match 蓝图-实例匹配规则测试（workflow-visualization U5——设计 §3.3-D2 形式化
 * 规则逐条 + §4 单测化路径）。
 *
 * fixture 形态口径 = u1 解析器真实产物（workflow-dag-parser.ts extractNameTemplate）：
 * templateName 变量段为合成标记 `${…}`、无字面段整段 `*`、matchPattern 变量段为 `.*`
 * ——不自造 `<...>` 尖括号形态（设计 §3.1-3 示例仅为文档示意），防测试与实装断链。
 *
 * 断言清单：
 * - 两级判据：phase 等值 ∧ 模板正则命中（同名调用点跨 phase 由 phase 判据天然分流）
 * - 多命中按字面段总长降序取更具体者（同词根双调用点——`reviewer-${…}-a${…}` vs
 *   `reviewer-security-${…}`，后者字面更长胜出；变量段数不同的模板不被标记长度偏置）
 * - 仍并列歧义 → 进未匹配分组标注 hitCount，不静默择一
 * - 零命中实例进未匹配分组不静默丢弃；实例 phase 缺失 → 未匹配（不猜缺省分区名）
 * - 同节点实例按 taskIndex（trace step 序号 call.id）升序挂接
 * - 零调用点 run（nodes 空）→ 全部实例进未匹配分组
 * - 字面段按正则转义：实例名含 `+`/`(` 等正则元字符不误匹配
 * - 坏 matchPattern（传输损坏防御面）→ 该节点按零命中处理，不拖垮整表
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/__tests__/blueprint-match.test.ts
 */
import { describe, it, expect } from 'vitest'
import { matchInstancesToNodes, templateLiteralLength } from '../blueprint-match'
import type { WorkflowAgentCall, WorkflowDagNode } from '@taiji/shared'

function node(id: string, templateName: string, matchPattern: string, phase: string): WorkflowDagNode {
  return { id, kind: 'agent', templateName, matchPattern, phase, line: 1 }
}

function call(id: number, agent: string, phase: string): WorkflowAgentCall {
  return { id, agent, phase, status: 'done' }
}

describe('blueprint-match：D2 两级判据', () => {
  it('先 phase 后正则：同名调用点跨 phase 复用由 phase 判据天然分流', () => {
    const dag = {
      nodes: [
        node('n1', 'reviewer-${…}', '^reviewer-.*$', 'alpha'),
        node('n2', 'reviewer-${…}', '^reviewer-.*$', 'beta'),
      ],
    }
    const result = matchInstancesToNodes(dag, [call(0, 'reviewer-a', 'alpha'), call(1, 'reviewer-b', 'beta')])
    expect(result.byNode.get('n1')?.map((c) => c.id)).toEqual([0])
    expect(result.byNode.get('n2')?.map((c) => c.id)).toEqual([1])
    expect(result.unmatched).toHaveLength(0)
  })

  it('模板正则命中：字面段精确匹配实例名', () => {
    const dag = { nodes: [node('n1', 'dev-${…}', '^dev-.*$', 'p')] }
    const result = matchInstancesToNodes(dag, [call(0, 'dev-W1', 'p')])
    expect(result.byNode.get('n1')).toHaveLength(1)
    expect(result.unmatched).toHaveLength(0)
  })
})

describe('blueprint-match：D2 多命中裁决', () => {
  it('同词根双调用点：按字面段总长降序取更具体者（S3 场景）', () => {
    const dag = {
      nodes: [
        node('broad', 'reviewer-${…}-a${…}', '^reviewer-.*-a.*$', 'p'),
        node('specific', 'reviewer-security-${…}', '^reviewer-security-.*$', 'p'),
      ],
    }
    // reviewer-security-x 同时命中两模板 → 字面段更长的 specific 胜
    //（broad 字面 = "reviewer--a" 11 字符；specific 字面 = "reviewer-security-" 18 字符）
    const result = matchInstancesToNodes(dag, [call(0, 'reviewer-security-x', 'p')])
    expect(result.byNode.has('specific')).toBe(true)
    expect(result.byNode.has('broad')).toBe(false)
    expect(result.unmatched).toHaveLength(0)
  })

  it('变量段数不同的模板不被 `${…}` 标记长度偏置：真字面长者胜（一致性修复 U3 回归）', () => {
    const dag = {
      nodes: [
        node('many-var', 'r-${…}-${…}-${…}', '^r-.*-.*-.*$', 'p'),
        node('more-literal', 'r-xx-${…}', '^r-xx-.*$', 'p'),
      ],
    }
    // r-xx-1-2 同时命中两模板；字符总数 many-var 14 > more-literal 9（含 `${…}` 标记），
    // 真字面 4 < 5——按字面段总长判 more-literal 更具体
    const result = matchInstancesToNodes(dag, [call(0, 'r-xx-1-2', 'p')])
    expect(result.byNode.has('more-literal')).toBe(true)
    expect(result.byNode.has('many-var')).toBe(false)
  })

  it('全通配 `*`（description 非静态/缺省的 u1 产物）字面 0：与具体模板多命中时具体者胜', () => {
    const dag = {
      nodes: [
        node('wild', '*', '^.*$', 'p'),
        node('specific', 'rev-${…}', '^rev-.*$', 'p'),
      ],
    }
    const result = matchInstancesToNodes(dag, [call(0, 'rev-1', 'p')])
    expect(result.byNode.has('specific')).toBe(true)
    expect(result.byNode.has('wild')).toBe(false)
  })

  it('字面段总长并列的歧义命中 → 进未匹配分组并标注 hitCount，不静默择一', () => {
    const dag = {
      nodes: [
        node('a', 'reviewer-${…}-x', '^reviewer-.*-x$', 'p'),
        node('b', 'reviewer-${…}-x', '^reviewer-.*-x$', 'p'),
      ],
    }
    const result = matchInstancesToNodes(dag, [call(0, 'reviewer-q-x', 'p')])
    expect(result.byNode.size).toBe(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatched[0].ambiguous).toBe(true)
    expect(result.unmatched[0].hitCount).toBe(2)
  })

  it('templateLiteralLength：剥 u1 产物形态 `${…}` 变量段后的字面字符总长', () => {
    expect(templateLiteralLength('reviewer-${…}-a${…}-r${…}')).toBe('reviewer--a-r'.length)
    expect(templateLiteralLength('reviewer-security-${…}')).toBe('reviewer-security-'.length)
    expect(templateLiteralLength('*')).toBe(0) // 非静态表达式整段通配 → 字面 0
    // 变量段数偏置回归：字符总数 14 > 9，真字面 4 < 5——剥标记后按真字面比较
    expect(templateLiteralLength('r-${…}-${…}-${…}')).toBe(4)
    expect(templateLiteralLength('r-xx-${…}')).toBe(5)
  })
})

describe('blueprint-match：未匹配分组（不静默丢弃）', () => {
  it('零命中实例进未匹配分组（hitCount=0）', () => {
    const dag = { nodes: [node('n1', 'dev-${…}', '^dev-.*$', 'p')] }
    const result = matchInstancesToNodes(dag, [call(0, 'other-agent', 'p')])
    expect(result.byNode.size).toBe(0)
    expect(result.unmatched).toEqual([
      { call: expect.objectContaining({ agent: 'other-agent' }), hitCount: 0, ambiguous: false },
    ])
  })

  it('实例 phase 缺失 → 未匹配分组（不猜解析器缺省分区名）', () => {
    const dag = { nodes: [node('n1', 'dev-${…}', '^dev-.*$', 'p')] }
    const orphan: WorkflowAgentCall = { id: 0, agent: 'dev-W1', status: 'done' }
    const result = matchInstancesToNodes(dag, [orphan])
    expect(result.byNode.size).toBe(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatched[0].hitCount).toBe(0)
  })

  it('零调用点 run（nodes 空）→ 全部实例进未匹配分组（渲染层空画布 + 居中摘要提示形态）', () => {
    const result = matchInstancesToNodes({ nodes: [] }, [call(0, 'a', 'p'), call(1, 'b', 'p')])
    expect(result.byNode.size).toBe(0)
    expect(result.unmatched).toHaveLength(2)
  })
})

describe('blueprint-match：挂接与防御面', () => {
  it('同节点实例按 taskIndex（call.id）升序挂接（轮次/维度区分靠实例名自身展示）', () => {
    const dag = { nodes: [node('n1', 'rev-${…}', '^rev-.*$', 'p')] }
    const result = matchInstancesToNodes(dag, [call(5, 'rev-e', 'p'), call(1, 'rev-a', 'p'), call(3, 'rev-c', 'p')])
    expect(result.byNode.get('n1')?.map((c) => c.id)).toEqual([1, 3, 5])
  })

  it('字面段按正则转义：实例名含 + / ( 等元字符不误匹配（D2① 转义义务的渲染侧消费验证）', () => {
    // 解析器对字面段转义后，`c++` 的 `+` 是字面字符——`.*` 通配不会把 `c++(v1)` 误配到
    // 其他模板（实例名元字符不改变匹配结果集）
    const dag = { nodes: [node('n1', 'build-+c++-${…}', '^build-\\+c\\+\\+.*$', 'p')] }
    const result = matchInstancesToNodes(dag, [call(0, 'build-+c++(v1)', 'p')])
    expect(result.byNode.get('n1')).toHaveLength(1)
  })

  it('坏 matchPattern → 该节点按零命中处理，不拖垮整表', () => {
    const dag = {
      nodes: [node('bad', 'x-${…}', '^([unclosed', 'p'), node('good', 'ok-${…}', '^ok-.*$', 'p')],
    }
    const result = matchInstancesToNodes(dag, [call(0, 'ok-1', 'p'), call(1, 'x-1', 'p')])
    expect(result.byNode.get('good')?.map((c) => c.id)).toEqual([0])
    expect(result.unmatched.map((u) => u.call.id)).toEqual([1])
  })
})
