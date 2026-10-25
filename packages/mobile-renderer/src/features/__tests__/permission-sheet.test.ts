// PermissionSheet 组件级单测（remote-use-mobile-v2 §6.18 消费半 / spec F8；验收条款 2）。
//
// 锁定：
// - **无归属一等分支（V-6 不成立 → 恒全局呈现）**：u-runtime-adapt 结论 = 组装点触发链
//   不携带会话上下文 → protocol `sessionId` 恒 undefined → 权限请求恒进程级全局请求。
//   呈现面锁两件事：① 权限作用域逐条列出（可作答面）；② **不渲染任何会话归属锚点**
//   （无会话名/会话行——归属语义诚实，V-6 重审通过后的归属呈现位由消费方扩展）。
// - 拒绝在左（安全侧在左，spec §5.1；destructive 档）
// - BM3 假成功红线呈现面：error 显形错误行（RPC 失败弹窗不关供重试——controller 权威）
// - 作答上抛：approve 携带 pluginId + permissions、deny 携带 pluginId（controller transport
//   的 RPC 面在 ui 包 controller 单测锁定，此处断言组件编排）
import { describe, expect, it, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PermissionSheet from '../PermissionSheet.vue'
import { i18n } from '../../i18n'

function bodyEl(testid: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

function mountSheet(props: Record<string, unknown>) {
  return mount(PermissionSheet, {
    global: { plugins: [i18n] },
    props: {
      open: true,
      pluginId: 'tasks',
      permissions: ['fs.read', 'net.fetch'],
      pending: true,
      ...props,
    },
    attachTo: document.body,
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('PermissionSheet（§6.18 无归属一等分支 + F8 审批面）', () => {
  it('权限作用域逐条列出 + 全局呈现（无归属分支：不渲染会话归属锚点）', async () => {
    const wrapper = mountSheet({})
    await flushPromises()
    // 逐条作用域（可作答面）
    expect(bodyEl('permission-sheet-perm-fs.read')?.textContent).toBe('fs.read')
    expect(bodyEl('permission-sheet-perm-net.fetch')?.textContent).toBe('net.fetch')
    // 全局呈现：作用域提示行标明进程级请求；渲染树内无会话归属锚点（无会话名/会话行
    // testid 域——V-6 不成立时归属位不存在即「一等分支」的呈现语义）
    const hint = bodyEl('permission-sheet-scope-hint')?.textContent ?? ''
    expect(hint.includes('进程级请求') || hint.includes('process-level')).toBe(true)
    expect(wrapper.find('[data-testid="permission-sheet-session"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('拒绝在左（安全侧；destructive 档）+ 允许在右', async () => {
    const wrapper = mountSheet({})
    await flushPromises()
    const deny = bodyEl('permission-sheet-deny')
    const approve = bodyEl('permission-sheet-approve')
    expect(deny).not.toBeNull()
    expect(approve).not.toBeNull()
    // 左右序：footer 内 deny 在 approve 之前
    const footer = deny!.parentElement!
    const children = Array.from(footer.children)
    expect(children.indexOf(deny!)).toBeLessThan(children.indexOf(approve!))
    // destructive 危险档（--danger-soft 底的中权重档，spec §6.1）
    expect(deny!.className).toContain('bg-danger-soft')
    wrapper.unmount()
  })

  it('作答上抛：approve 携带 pluginId+permissions、deny 携带 pluginId', async () => {
    const wrapper = mountSheet({})
    await flushPromises()
    ;(bodyEl('permission-sheet-approve') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.emitted('approve')).toEqual([[{ pluginId: 'tasks', permissions: ['fs.read', 'net.fetch'] }]])

    ;(bodyEl('permission-sheet-deny') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.emitted('deny')).toEqual([[{ pluginId: 'tasks' }]])
    wrapper.unmount()
  })

  it('BM3 假成功红线呈现面：error=true 显形错误行（RPC 失败弹窗不关供重试）', async () => {
    const wrapper = mountSheet({ error: true })
    await flushPromises()
    expect(bodyEl('permission-sheet-error')).not.toBeNull()
    // 错误在位时作答钮仍可用（重试面）
    expect(bodyEl('permission-sheet-approve')).not.toBeNull()
    wrapper.unmount()
  })

  it('pending=false 或 pluginId 空：Sheet 内容门关闭（已收尾/过期撤窗后不渲染浮层内容）', async () => {
    const wrapper = mountSheet({ pending: false })
    await flushPromises()
    expect(bodyEl('sheet-content')).toBeNull()
    wrapper.unmount()

    const empty = mountSheet({ pluginId: '' })
    await flushPromises()
    expect(bodyEl('sheet-content')).toBeNull()
    empty.unmount()
  })
})
