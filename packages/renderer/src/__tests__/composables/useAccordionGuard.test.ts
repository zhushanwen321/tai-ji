/**
 * useAccordionGuard 行为测试（R4 手风琴展开 + dirty 守卫状态机）。
 *
 * 背景：u06（清理点#3）把 PendingAction 三变体判别联合收敛成单 pendingTarget 赋值，
 * commit message 声称「6 行为场景等价」但全仓无测试文件——本文件把该等价性钉成可回归断言。
 *
 * 观测面（消费者视角，镜像 ProviderPage.vue 的真实绑定）：
 * - aria-expanded / body-<id> ← expandedId
 * - dirty-<id> 徽章 ← expandedId === id && currentBodyDirty
 * - guard-dialog ← v-model:open（guardDialogOpen）；confirm 走 @confirm="confirmDiscard"，
 *   cancel 走 update:open(false)（ConfirmDialog 语义：confirm/cancel 仅回调，关闭由 update:open 驱动）
 *
 * pendingTarget 是 composable 内部哨兵（未导出，消费者不可见）；其 4 态差异只能经
 * 「弹窗是否开」+「confirm 后 expandedId 落到哪」两条外部可观察路径区分——本文件按此断言，
 * 不用内部 ref 代替可见形态。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAccordionGuard.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { defineComponent, h, type VNode } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useAccordionGuard } from '@/composables/features/settings/useAccordionGuard'

const ROWS = ['p1', 'p2'] as const
const NEW_ID = '__new__'
const NEW_BODY = `body-${NEW_ID}`
const NEW_ROW = `row-${NEW_ID}`

type Guard = ReturnType<typeof useAccordionGuard>

interface Host {
  wrapper: VueWrapper
  guard: Guard
}

const wrappers: VueWrapper[] = []

/** 挂载镜像 ProviderPage 绑定形态的宿主（render 函数读 ref.value 建立响应式依赖） */
function mountHost(): Host {
  const holder: { guard?: Guard } = {}
  const wrapper = mount(
    defineComponent({
      name: 'AccordionGuardHost',
      setup() {
        const g = useAccordionGuard(NEW_ID)
        holder.guard = g
        return () => {
          const rows: VNode[] = []
          for (const id of [...ROWS, NEW_ID]) {
            rows.push(
              h(
                'span',
                {
                  key: `row-${id}`,
                  'data-testid': `row-${id}`,
                  role: 'button',
                  'aria-expanded': String(g.expandedId.value === id),
                  onClick: () => g.toggleExpand(id),
                },
                id,
              ),
            )
            if (g.expandedId.value === id) {
              const body: VNode[] = []
              if (g.currentBodyDirty.value) {
                body.push(h('span', { key: 'dirty', 'data-testid': `dirty-${id}` }))
              }
              rows.push(h('div', { key: `body-${id}`, 'data-testid': `body-${id}` }, body))
            }
          }
          const dialog = g.guardDialogOpen.value
            ? h('div', { 'data-testid': 'guard-dialog' }, [
                h('div', {
                  'data-testid': 'guard-confirm',
                  role: 'button',
                  onClick: () => g.confirmDiscard(),
                }),
                h('div', {
                  'data-testid': 'guard-cancel',
                  role: 'button',
                  // ConfirmDialog 取消：emit('update:open', false) → v-model set(false)
                  onClick: () => {
                    g.guardDialogOpen.value = false
                  },
                }),
              ])
            : h('span', { 'data-testid': 'guard-dialog-absent' })
          return h('div', [
            ...rows,
            h('div', { 'data-testid': 'add-btn', role: 'button', onClick: () => g.createAndExpand() }),
            h('div', { 'data-testid': 'dirty-on', role: 'button', onClick: () => g.onBodyDirtyChange(true) }),
            h('div', { 'data-testid': 'dirty-off', role: 'button', onClick: () => g.onBodyDirtyChange(false) }),
            h('div', { 'data-testid': 'save-btn', role: 'button', onClick: () => g.onBodySaved() }),
            h('div', { 'data-testid': 'cancel-btn', role: 'button', onClick: () => g.onBodyCancel() }),
            dialog,
          ])
        }
      },
    }),
  )
  wrappers.push(wrapper)
  const guard = holder.guard
  if (!guard) throw new Error('宿主组件未暴露 guard')
  return { wrapper, guard }
}

function sel(id: string): string {
  return `[data-testid="${id}"]`
}

function visible(host: Host, id: string): boolean {
  return host.wrapper.find(sel(id)).exists()
}

async function click(host: Host, id: string): Promise<void> {
  const el = host.wrapper.find(sel(id))
  if (!el.exists()) throw new Error(`未找到可点击元素 ${id}`)
  await el.trigger('click')
}

/** 展开 p1 并上抛 dirty（collapse/switch/add 三态的前置） */
async function expandP1Dirty(host: Host): Promise<void> {
  await click(host, 'row-p1')
  await click(host, 'dirty-on')
  expect(visible(host, 'dirty-p1')).toBe(true)
}

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
})

describe('useAccordionGuard（R4 展开守卫状态机）', () => {
  describe('四态矩阵', () => {
    it('collapse：点已展开行 + dirty → 守卫挂起且行未收起', async () => {
      const host = mountHost()
      await expandP1Dirty(host)
      expect(visible(host, 'body-p1')).toBe(true)

      await click(host, 'row-p1')

      expect(visible(host, 'guard-dialog')).toBe(true)
      expect(host.guard.guardDialogOpen.value).toBe(true)
      // 未确认前不得收起：body 仍在、aria-expanded 仍为 true
      expect(visible(host, 'body-p1')).toBe(true)
      expect(host.wrapper.get(sel('row-p1')).attributes('aria-expanded')).toBe('true')
      // confirm 后落点=null 才是 collapse（与 switch 的区分见 confirmDiscard 三态用例）
      await click(host, 'guard-confirm')
      expect(host.guard.expandedId.value).toBeNull()
      expect(visible(host, 'body-p1')).toBe(false)
    })

    it('switch：点其他行 + dirty → 守卫挂起，原展开行保持未切换', async () => {
      const host = mountHost()
      await expandP1Dirty(host)

      await click(host, 'row-p2')

      expect(visible(host, 'guard-dialog')).toBe(true)
      expect(visible(host, 'body-p1')).toBe(true)
      expect(visible(host, 'body-p2')).toBe(false)
      expect(host.wrapper.get(sel('row-p2')).attributes('aria-expanded')).toBe('false')
      // confirm 后落点=p2 才是 switch
      await click(host, 'guard-confirm')
      expect(host.guard.expandedId.value).toBe('p2')
      expect(visible(host, 'body-p2')).toBe(true)
    })

    it('add：createAndExpand + dirty → 守卫挂起，未进入新建态', async () => {
      const host = mountHost()
      await expandP1Dirty(host)

      await click(host, 'add-btn')

      expect(visible(host, 'guard-dialog')).toBe(true)
      expect(visible(host, 'body-p1')).toBe(true)
      expect(visible(host, NEW_BODY)).toBe(false)
      // confirm 后落点=newId 才是 add
      await click(host, 'guard-confirm')
      expect(host.guard.expandedId.value).toBe(NEW_ID)
      expect(visible(host, NEW_BODY)).toBe(true)
    })

    it('none：无 dirty → 展开/收起/新建/切换均直达，不弹守卫', async () => {
      const host = mountHost()
      expect(host.guard.guardDialogOpen.value).toBe(false)
      expect(visible(host, 'guard-dialog-absent')).toBe(true)

      // 展开
      await click(host, 'row-p1')
      expect(visible(host, 'body-p1')).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(host.guard.guardDialogOpen.value).toBe(false)

      // 无 dirty 切换
      await click(host, 'row-p2')
      expect(visible(host, 'body-p2')).toBe(true)
      expect(visible(host, 'body-p1')).toBe(false)
      expect(visible(host, 'guard-dialog')).toBe(false)

      // 无 dirty 收起
      await click(host, 'row-p2')
      expect(visible(host, 'body-p2')).toBe(false)
      expect(host.wrapper.get(sel('row-p2')).attributes('aria-expanded')).toBe('false')
      expect(visible(host, 'guard-dialog')).toBe(false)

      // 无 dirty 新建
      await click(host, 'add-btn')
      expect(visible(host, NEW_BODY)).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(host.guard.guardDialogOpen.value).toBe(false)

      // 新建行同样可无守卫收起
      await click(host, NEW_ROW)
      expect(visible(host, NEW_BODY)).toBe(false)
      expect(host.wrapper.get(sel(NEW_ROW)).attributes('aria-expanded')).toBe('false')
      expect(visible(host, 'guard-dialog')).toBe(false)
    })
  })

  describe('守卫弹窗开合', () => {
    it('guardDialogOpen 与守卫在途一一对应：三态挂起均开、无守卫均关', async () => {
      const host = mountHost()
      expect(host.guard.guardDialogOpen.value).toBe(false)
      expect(visible(host, 'guard-dialog')).toBe(false)

      await expandP1Dirty(host)

      // collapse 态挂起 → 开；取消（update:open false）→ 关且不执行动作、不动 dirty
      await click(host, 'row-p1')
      expect(host.guard.guardDialogOpen.value).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(true)
      await click(host, 'guard-cancel')
      expect(host.guard.guardDialogOpen.value).toBe(false)
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(visible(host, 'body-p1')).toBe(true)
      expect(visible(host, 'dirty-p1')).toBe(true)

      // switch 态挂起 → 开
      await click(host, 'row-p2')
      expect(host.guard.guardDialogOpen.value).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(true)
      await click(host, 'guard-cancel')
      expect(visible(host, 'guard-dialog')).toBe(false)

      // add 态挂起 → 开
      await click(host, 'add-btn')
      expect(host.guard.guardDialogOpen.value).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(true)
      await click(host, 'guard-cancel')
      expect(host.guard.guardDialogOpen.value).toBe(false)
      expect(visible(host, 'guard-dialog')).toBe(false)
    })
  })

  describe('confirmDiscard 三态行为', () => {
    it('收起态（pendingTarget=null）→ 确认后 expandedId=null 并清 dirty', async () => {
      const host = mountHost()
      await expandP1Dirty(host)
      await click(host, 'row-p1')

      await click(host, 'guard-confirm')

      expect(host.guard.expandedId.value).toBeNull()
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.wrapper.get(sel('row-p1')).attributes('aria-expanded')).toBe('false')
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })

    it('切换态（pendingTarget=string）→ 确认后 expandedId=目标 id 并清 dirty', async () => {
      const host = mountHost()
      await expandP1Dirty(host)
      await click(host, 'row-p2')

      await click(host, 'guard-confirm')

      expect(host.guard.expandedId.value).toBe('p2')
      expect(visible(host, 'body-p2')).toBe(true)
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.wrapper.get(sel('row-p2')).attributes('aria-expanded')).toBe('true')
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })

    it('新建态（pendingTarget=newId）→ 确认后进入新建态', async () => {
      const host = mountHost()
      await expandP1Dirty(host)
      await click(host, 'add-btn')

      await click(host, 'guard-confirm')

      expect(host.guard.expandedId.value).toBe(NEW_ID)
      expect(visible(host, NEW_BODY)).toBe(true)
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })

    it('无守卫在途时直接调用（非法路径）→ 提前返回，不改任何状态', async () => {
      const host = mountHost()
      await expandP1Dirty(host)

      host.guard.confirmDiscard()

      expect(host.guard.expandedId.value).toBe('p1')
      expect(host.guard.currentBodyDirty.value).toBe(true)
      expect(visible(host, 'body-p1')).toBe(true)
      expect(visible(host, 'dirty-p1')).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(false)
    })
  })

  describe('dirty 上抛对守卫判定的影响', () => {
    it('同一动作：dirty=false 直达切换，dirty=true 被拦截', async () => {
      const host = mountHost()

      // dirty=false：切到 p2 直达
      await click(host, 'row-p1')
      await click(host, 'row-p2')
      expect(visible(host, 'body-p2')).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(false)

      // 切回 p1 并上抛 dirty=true：同样的「切到 p2」被拦截
      await click(host, 'row-p1')
      await click(host, 'dirty-on')
      await click(host, 'row-p2')
      expect(visible(host, 'guard-dialog')).toBe(true)
      expect(visible(host, 'body-p2')).toBe(false)
    })

    it('dirty 取消上抛（dirty-change false）后，collapse 不再被拦截', async () => {
      const host = mountHost()
      await expandP1Dirty(host)
      await click(host, 'row-p1')
      expect(visible(host, 'guard-dialog')).toBe(true)

      // 放弃守卫（取消不动 dirty）→ dirty 仍 true，再点仍拦截
      await click(host, 'guard-cancel')
      await click(host, 'row-p1')
      expect(visible(host, 'guard-dialog')).toBe(true)
      await click(host, 'guard-cancel')

      // body 上抛 dirty=false → 同样点击直达收起
      await click(host, 'dirty-off')
      expect(visible(host, 'dirty-p1')).toBe(false)
      await click(host, 'row-p1')
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })

    it('expandedId=null 时 dirty 不再拦截 createAndExpand（守卫前置条件=当前有展开行）', async () => {
      const host = mountHost()
      // 无展开行但 dirty=true（上抛残留）→ createAndExpand 直达
      await click(host, 'dirty-on')
      await click(host, 'add-btn')
      expect(visible(host, NEW_BODY)).toBe(true)
      expect(visible(host, 'guard-dialog')).toBe(false)
      expect(host.guard.guardDialogOpen.value).toBe(false)
    })
  })

  describe('ProviderEditBody 事件接入', () => {
    it('onBodyDirtyChange 上抛驱动 dirty 徽章与 currentBodyDirty', async () => {
      const host = mountHost()
      await click(host, 'row-p1')
      expect(visible(host, 'dirty-p1')).toBe(false)
      await click(host, 'dirty-on')
      expect(visible(host, 'dirty-p1')).toBe(true)
      expect(host.guard.currentBodyDirty.value).toBe(true)
      await click(host, 'dirty-off')
      expect(visible(host, 'dirty-p1')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })

    it('onBodySaved / onBodyCancel 均收起并清 dirty', async () => {
      const host = mountHost()
      await expandP1Dirty(host)
      await click(host, 'save-btn')
      expect(host.guard.expandedId.value).toBeNull()
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)

      await expandP1Dirty(host)
      await click(host, 'cancel-btn')
      expect(host.guard.expandedId.value).toBeNull()
      expect(visible(host, 'body-p1')).toBe(false)
      expect(host.guard.currentBodyDirty.value).toBe(false)
    })
  })
})
