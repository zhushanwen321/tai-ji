/**
 * BtwPanel 契约反向断言（btw-question D9⑤，UI 不可见面守卫）。
 *
 * D9⑤：BTW_BEHAVIOR_CONTRACT 是 model-only 单条注入（spawn `--append-system-prompt`），
 * 明确「不进对话流渲染」。本测试从契约源文件正则提取字面量为常量 A，渲染含普通消息 /
 * 表单 fixture 的 BtwPanel，对 DOM 文本做**逐句反向断言**（按 ；/。 切分，防 markdown
 * 换行打断单句导致整串 toContain 漏判）——A 任何一句出现在可见 DOM 即红。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：A 从源文件 readFileSync + 正则提取（防提取静默失败：A 非空 +
 *   含 D9⑤ 稳定关键词，兼作「A ≡ 源当前内容」的防漂移锚——提取自源本身天然逐字一致）
 * - 使用者（黑盒 DOM）：含普通消息/表单 fixture 的面板渲染文本不含契约任一句
 * - 观察者（形态）：fixture 文本本身可见（证明断言跑在非空渲染面上，防空壳漏判）
 *
 * mock 策略：复用 btw-panel.test.ts 范式——vi.mock('@/api') 局部替换 btw 域；
 * MessageStream / Composer stub 渲染普通消息 / 表单 fixture 文本（非空 div），
 * i18n 由 vitest-i18n-setup 全局 mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/btw-panel-contract-invisible.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  bindDrawerSessionId,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import BtwPanel from '@/components/panel/BtwPanel.vue'

// ── @/api 门面局部 mock：只替换 btw 域（同 btw-panel.test.ts 范式）──
const apiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return { ...actual, btw: apiMock }
})

// ── MessageStream / Composer stub：渲染普通消息 / 表单 fixture 文本（可见非空面）──
const MESSAGE_FIXTURE_TEXT = '普通消息 fixture：用户提问，助手给出回答。'
const COMPOSER_FIXTURE_TEXT = '表单 fixture：输入消息'
// 注意：vi.mock 工厂被 hoist 到文件顶部，工厂内不得引用顶层 const——文案字面量内联（同 btw-panel.test.ts）。
vi.mock('@/components/panel/MessageStream.vue', async () => {
  const { defineComponent: dc, h: hs } = await import('vue')
  return {
    default: dc({
      name: 'MessageStream',
      setup: () =>
        () =>
          hs('div', { 'data-fixture': 'stream' }, [
            '普通消息 fixture：用户提问，助手给出回答。',
          ]),
    }),
  }
})
vi.mock('@/components/panel/Composer.vue', async () => {
  const { defineComponent: dc, h: hs } = await import('vue')
  return {
    default: dc({
      name: 'Composer',
      setup: () =>
        () =>
          hs('div', { 'data-fixture': 'composer' }, ['表单 fixture：输入消息']),
    }),
  }
})

const MAIN_A = 's-btw-a'

// ── 契约文本提取：readFileSync 只读源文件 + 正则提取导出字符串字面量为常量 A ──
/** 源文件路径候选：优先 import.meta.url（与 vitest cwd 无关，稳形态），回退 cwd 两形态。 */
function resolveContractSource(): string {
  const rel = 'runtime/src/services/session/btw-contract-inject.ts'
  const candidates: string[] = []
  // vitest 下 import.meta.url 不保证 file: scheme，仅在是 file URL 时作为首选锚点
  try {
    if (import.meta.url.startsWith('file:')) {
      candidates.push(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)))
    }
  } catch {
    /* 非 file URL → 退 cwd 候选 */
  }
  candidates.push(
    resolve(process.cwd(), `../${rel}`), // cwd = 包根
    resolve(process.cwd(), `packages/${rel}`), // cwd = 仓根
  )
  const hit = candidates.find((p) => existsSync(p))
  if (!hit) throw new Error(`btw-contract-inject.ts not found in candidates: ${candidates.join(', ')}`)
  return hit
}

/** 正则提取 `export const BTW_BEHAVIOR_CONTRACT = '…'` 字面量内容（单/双引号皆容）。 */
function extractContract(): string {
  const src = readFileSync(resolveContractSource(), 'utf8')
  const m = /export\s+const\s+BTW_BEHAVIOR_CONTRACT\s*=\s*(['"])([\s\S]*?)\1/.exec(src)
  if (!m) throw new Error('BTW_BEHAVIOR_CONTRACT literal not found — extraction regex drifted')
  return m[2]
}

const A = extractContract()

/** D9⑤ 稳定关键词（防提取静默失败 + A ≡ 源当前内容的防漂移锚）。 */
const D9_KEYS = ['父任务快照仅供背景', '不自动续主任务', '改工作区'] as const

/** 契约句切分：按 ；/。 切（契约本身以 ； 分句），逐句反向断言防换行打断漏判。 */
function contractSentences(contract: string): string[] {
  return contract
    .split(/[；。;]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

let boundSid: Ref<string | null>

function mountPanel(sessionId: string | null) {
  return mount(BtwPanel, { props: { sessionId } })
}

async function settle(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
  await flushPromises()
  await nextTick()
  await nextTick()
}

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  boundSid = ref<string | null>(MAIN_A)
  bindDrawerSessionId(boundSid)
  _resetDrawerForTest()
})

describe('D9⑤ 契约提取自源（构建者白盒 + 防漂移锚）', () => {
  it('A 非空且含 D9⑤ 稳定关键词（提取未静默失败；A 即源当前内容，逐字一致成立）', () => {
    expect(A.length).toBeGreaterThan(0)
    for (const key of D9_KEYS) expect(A).toContain(key)
    // 句切分产出多句（反向断言的输入面有效）
    expect(contractSentences(A).length).toBeGreaterThanOrEqual(2)
  })
})

describe('BtwPanel 契约 UI 反向断言（使用者黑盒 DOM + 观察者形态）', () => {
  it('含普通消息/表单 fixture 的面板渲染文本不含契约任一句（D9⑤ model-only 不可见）', async () => {
    apiMock.list.mockResolvedValue([{ vid: 'btw:pi-1' }])
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    // 观察者：fixture 面可见（防空壳——断言必须跑在非空渲染面上）
    const dom = wrapper.text()
    // 注意：不用 data-testid——父组件透传的 data-testid 会覆盖 stub 自有值（同 btw-panel.test.ts 落点）
    expect(wrapper.find('[data-fixture="stream"]').exists()).toBe(true)
    expect(wrapper.find('[data-fixture="composer"]').exists()).toBe(true)
    expect(dom).toContain(MESSAGE_FIXTURE_TEXT)
    expect(dom).toContain(COMPOSER_FIXTURE_TEXT)

    // 使用者：整串不可见
    expect(dom).not.toContain(A)
    // 逐句反向断言（防 markdown/渲染换行打断单句导致整串漏判）
    const sentences = contractSentences(A)
    expect(sentences.length).toBeGreaterThanOrEqual(2)
    for (const s of sentences) expect(dom).not.toContain(s)
  })

  it('空态（无线）与新建线（fork pill）路径同样不含契约任一句', async () => {
    apiMock.list.mockResolvedValue([])
    apiMock.create.mockResolvedValue({
      vid: 'btw:pi-9',
      mainSid: MAIN_A,
      forkState: 'full',
    })

    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)
    const emptyDom = wrapper.text()
    expect(emptyDom).toContain('还没有旁路线') // 空态可见，防空壳
    expect(emptyDom).not.toContain(A)
    for (const s of contractSentences(A)) expect(emptyDom).not.toContain(s)

    await wrapper.find('[data-testid="btw-empty-new"]').trigger('click')
    await settle(wrapper)
    const createdDom = wrapper.text()
    expect(createdDom).toContain('已含主对话快照') // fork pill 可见，防空壳
    expect(createdDom).not.toContain(A)
    for (const s of contractSentences(A)) expect(createdDom).not.toContain(s)
  })
})
