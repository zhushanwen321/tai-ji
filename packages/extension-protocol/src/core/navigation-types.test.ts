import { describe, it, expect } from 'vitest'
import type { GuiComponent, TreeItem, HostContainerAction } from './types'

/**
 * 容器导航原语契约（容器扩展点统一 §6.4）：action-bar item 增 hostAction、TreeItem 增
 * action——插件首次能表达「点击请求宿主打开某个容器的某个标签页」。params 限标量与
 * action-bar args 同一校验口径（禁嵌套对象防无 schema 结构化旁路）；负向断言由本包
 * typecheck（tsc --noEmit，include 覆盖 src 测试）承载 @ts-expect-error 的真伪验证。
 */
describe('容器导航原语（§6.4：action-bar hostAction + TreeItem.action）', () => {
  it('action-bar item 可声明 hostAction（overlay/drawer + tabId + 标量 params），纯展示项维持旧行为', () => {
    const bar: GuiComponent<'action-bar'> = {
      type: 'action-bar',
      props: {
        items: [
          {
            id: 'open-doc',
            label: '打开报告',
            hostAction: { kind: 'drawer', tabId: 'ui.doc', params: { filePath: '/tmp/report.md' } },
          },
          { id: 'plain', label: '纯展示' },
        ],
      },
    }
    expect(bar.props.items[0].hostAction?.kind).toBe('drawer')
    expect(bar.props.items[0].hostAction?.tabId).toBe('ui.doc')
    expect(bar.props.items[0].hostAction?.params).toEqual({ filePath: '/tmp/report.md' })
    expect(bar.props.items[1].hostAction).toBeUndefined()
  })

  it('TreeItem.action 承载行点击（hostAction 或 commandId），缺省 = 纯展示行不变', () => {
    const items: TreeItem[] = [
      { label: 'run-1', status: 'done', action: { hostAction: { kind: 'overlay', tabId: 'ui.runs' } } },
      { label: 'rerun', action: { commandId: 'wf.rerun' } },
      { label: 'plain' },
    ]
    expect(items[0].action?.hostAction?.tabId).toBe('ui.runs')
    expect(items[1].action?.commandId).toBe('wf.rerun')
    expect(items[2].action).toBeUndefined()
  })

  it('params 限标量：字符串/数字/布尔合法；嵌套对象在类型层被拒（@ts-expect-error，tsc 承载）', () => {
    const scalar: HostContainerAction = { kind: 'drawer', tabId: 'x.y', params: { s: 'a', n: 1, b: false } }
    expect(Object.values(scalar.params ?? {})).toEqual(['a', 1, false])
    // 嵌套对象字面量不可赋给 params（Record<string, string | number | boolean>）
    const nested = { kind: 'drawer', tabId: 'x.y', params: { deep: { inner: 1 } } }
    // @ts-expect-error params 值限标量：嵌套对象形状必须被类型层拒绝
    const rejected: HostContainerAction = nested
    expect(rejected.tabId).toBe('x.y')
  })
})
