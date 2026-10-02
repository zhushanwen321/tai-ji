/**
 * run-name 脚本名归一纯函数测试（dmg-r1-8：run 名定位判据单源）。
 *
 * 归一语义 = basename 化（含反斜杠路径）+ 去脚本扩展名（.js/.mjs/.cjs/.ts），
 * 路径 / 带扩展名 / bare 三形态互通（L4 真机发现：主 agent 常传脚本路径而
 * record.scriptName 存 basename）。本函数是 overlay findRun 与 drawer WorkflowTab
 * 两入口判据的共同实现——入口级行为（runId 优先 / 取最新）归各自入口测试。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/__tests__/run-name.test.ts
 */
import { describe, it, expect } from 'vitest'
import { normalizeWorkflowScriptName } from '../run-name'

describe('normalizeWorkflowScriptName（三形态互通）', () => {
  it('bare 名保持原样（record.scriptName 存 basename 的基准形态）', () => {
    expect(normalizeWorkflowScriptName('flow-a')).toBe('flow-a')
  })

  it('绝对/相对路径 → basename（正反斜杠均归一）', () => {
    expect(normalizeWorkflowScriptName('/Users/agent/workflows/flow-a.js')).toBe('flow-a')
    expect(normalizeWorkflowScriptName('./workflows/flow-a.js')).toBe('flow-a')
    expect(normalizeWorkflowScriptName('C:\\workflows\\flow-a.js')).toBe('flow-a')
  })

  it('脚本扩展名四族剥除：.js / .mjs / .cjs / .ts（bare 与带扩展名互通）', () => {
    for (const ext of ['.js', '.mjs', '.cjs', '.ts']) {
      expect(normalizeWorkflowScriptName(`flow-a${ext}`)).toBe('flow-a')
    }
  })

  it('非脚本扩展名不剥（.md / .json 等保持完整 basename）', () => {
    expect(normalizeWorkflowScriptName('/docs/flow-a.md')).toBe('flow-a.md')
    expect(normalizeWorkflowScriptName('flow-a.json')).toBe('flow-a.json')
  })

  it('名字自身含点号仅剥末段脚本扩展名', () => {
    expect(normalizeWorkflowScriptName('my.flow-a.js')).toBe('my.flow-a')
  })

  it('空串与裸扩展名不炸（入口侧空值守卫在前，此处仅形态确定）', () => {
    expect(normalizeWorkflowScriptName('')).toBe('')
    expect(normalizeWorkflowScriptName('.js')).toBe('')
  })
})
