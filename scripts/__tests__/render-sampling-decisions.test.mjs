/**
 * render-sampling 管道判定层单测（scripts/render-sampling/decisions.mjs）。
 *
 * 该库是 docs/testing/render-sampling.md 登记的复用管道资产（禁现场重写），
 * 判定逻辑出错形态全部是静默产物污染（发送通道判定漂移 / 假稳定误判 /
 * 窄窗验收尺寸算错无报错），故对判定面直接锁定：浏览器侧采集函数用 jsdom
 * 直测同一函数体（page.evaluate 序列化后跑的就是它，见 decisions.mjs 头注），
 * 纯数据函数直测，lib.mjs 的通道决策与判稳轮询编排用 fake page / fake timers
 * 锁「抽取后保持接线」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

import {
  collectRenderState,
  flagValue,
  isRenderSettled,
  missingSampleCliArgs,
  probeSendButton,
  restoreWindowBounds,
  windowBoundsForContent,
} from '../render-sampling/decisions.mjs'
import { clickSendOrSubmit, waitForRenderSettled } from '../render-sampling/lib.mjs'

const doc = (html) => new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document

// ---------- probeSendButton：发送按钮 DOM 探测 ----------

describe('probeSendButton 命中面', () => {
  it('data-testid 命中 send：返回 sig 并真实 click 按钮', () => {
    const d = doc(`
      <div class="composer-wrap">
        <div class="composer-input" contenteditable="true"></div>
        <button data-testid="send-button">发送</button>
      </div>`)
    let clicks = 0
    d.querySelector('button').addEventListener('click', () => { clicks++ })
    expect(probeSendButton(d)).toBe('send-button')
    expect(clicks).toBe(1)
  })

  it('aria-label 命中（大小写不敏感）', () => {
    const d = doc(`
      <div><div class="composer-input" contenteditable="true"></div>
      <button aria-label="Send message"></button></div>`)
    expect(probeSendButton(d)).toBe('Send message')
  })

  it('title 命中中文「发送」', () => {
    const d = doc(`
      <div><div class="composer-input" contenteditable="true"></div>
      <button title="发送"></button></div>`)
    expect(probeSendButton(d)).toBe('发送')
  })

  it('sig 三属性拼接：title 与 aria-label 均未命中但 data-testid 命中 submit', () => {
    const d = doc(`
      <div><div class="composer-input" contenteditable="true"></div>
      <button data-testid="chat-submit"></button></div>`)
    expect(probeSendButton(d)).toBe('chat-submit')
  })

  it('composer 自身为 div：scope 从父元素起算，内部按钮经容器后代集合命中', () => {
    const d = doc(`
      <div><div class="composer-input" contenteditable="true">
        <button data-testid="send"></button>
      </div></div>`)
    expect(probeSendButton(d)).toBe('send')
  })

  it('composer 无 div 容器（body 直接挂载）：scope 回退 document 仍可探测', () => {
    const d = doc('<div class="composer-input" contenteditable="true"></div>')
    const btn = d.createElement('button')
    btn.setAttribute('data-testid', 'send')
    d.body.append(btn)
    expect(probeSendButton(d)).toBe('send')
  })
})

describe('probeSendButton 不命中面（lib fallback Enter）', () => {
  it('全部按钮 disabled：跳过禁用项返回 null', () => {
    const d = doc(`
      <div><div class="composer-input" contenteditable="true"></div>
      <button data-testid="send-button" disabled></button></div>`)
    expect(probeSendButton(d)).toBeNull()
  })

  it('sig 无 send|发送|submit 匹配：不误点无关按钮', () => {
    const d = doc(`
      <div><div class="composer-input" contenteditable="true"></div>
      <button aria-label="删除"></button>
      <button title="取消"></button></div>`)
    expect(probeSendButton(d)).toBeNull()
  })

  it('无 composer：直接 null 不探测', () => {
    const d = doc('<div><button data-testid="send"></button></div>')
    expect(probeSendButton(d)).toBeNull()
  })

  it('composer 存在但无任何按钮：null', () => {
    const d = doc('<div><div class="composer-input" contenteditable="true"></div></div>')
    expect(probeSendButton(d)).toBeNull()
  })

  it('sig 缺失属性按空串拼接不抛错（getAttribute 返回 null 的按钮）', () => {
    const d = doc(`
      <div><div class="composer-input" contenteditable="true"></div>
      <button data-testid="send"></button></div>`)
    // 该按钮无 aria-label/title——sig 前段为两个空格，trim 后仍命中 testid
    expect(probeSendButton(d)).toBe('send')
  })
})

// ---------- collectRenderState：img 三态计数 + 高度采集 ----------

describe('collectRenderState', () => {
  it('img 三态分类：pending（加载中）/ broken（失败 0x0）/ loaded', () => {
    const d = doc('<img src="https://x/a.png">')
    const imgs = d.querySelectorAll('img')
    // jsdom 不加载资源：有 src 的 img 处于加载中（complete=false, naturalWidth=0）
    const broken = d.createElement('img')
    Object.defineProperty(broken, 'complete', { value: true })
    Object.defineProperty(broken, 'naturalWidth', { value: 0 })
    const loaded = d.createElement('img')
    Object.defineProperty(loaded, 'naturalWidth', { value: 42 })
    d.body.append(broken, loaded)
    expect(imgs.length).toBe(1)
    expect(collectRenderState(d)).toEqual({ pending: 1, broken: 1, loaded: 1, height: 0 })
  })

  it('height 透传 documentElement.scrollHeight（defineProperty 验证取值来源）', () => {
    const d = doc('')
    Object.defineProperty(d.documentElement, 'scrollHeight', { value: 1234 })
    expect(collectRenderState(d).height).toBe(1234)
  })
})

// ---------- isRenderSettled：判稳判定 ----------

describe('isRenderSettled', () => {
  it('pending=0 且高度与上轮相同 → 稳定', () => {
    expect(isRenderSettled({ pending: 0, height: 120 }, 120)).toBe(true)
  })

  it('pending>0：即使高度不变也不判稳（图片仍在加载）', () => {
    expect(isRenderSettled({ pending: 2, height: 120 }, 120)).toBe(false)
  })

  it('高度仍在变化：不判稳（首轮 lastHeight=-1 恒不等，保证至少采样两轮）', () => {
    expect(isRenderSettled({ pending: 0, height: 120 }, -1)).toBe(false)
    expect(isRenderSettled({ pending: 0, height: 130 }, 120)).toBe(false)
  })
})

// ---------- waitForRenderSettled：判稳轮询编排（fake timers + fake page） ----------

describe('waitForRenderSettled 轮询编排', () => {
  afterEach(() => vi.useRealTimers())

  const fakePage = (states) => ({
    evaluate: async () => (states.length > 1 ? states.shift() : states[0]),
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
  })

  it('高度稳定且 pending=0 后返回该状态（中途高度变化继续轮询）', async () => {
    vi.useFakeTimers()
    const page = fakePage([
      { pending: 1, broken: 0, loaded: 0, height: 100 },
      { pending: 0, broken: 0, loaded: 2, height: 120 },
      { pending: 0, broken: 0, loaded: 2, height: 120 },
    ])
    const promise = waitForRenderSettled(page, { timeout: 15000, settleMs: 600 })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(promise).resolves.toEqual({ pending: 0, broken: 0, loaded: 2, height: 120 })
  })

  it('超时返回末态（pending 未清零也不得挂死，交由断言判定可否接受）', async () => {
    vi.useFakeTimers()
    const finalState = { pending: 1, broken: 0, loaded: 0, height: 100 }
    const page = fakePage([finalState])
    const promise = waitForRenderSettled(page, { timeout: 15000, settleMs: 600 })
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(promise).resolves.toBe(finalState)
  })
})

// ---------- clickSendOrSubmit：通道决策 + decisions 接线 ----------

describe('clickSendOrSubmit 通道决策', () => {
  it('探测命中：返回 button 通道与命中 sig，不按 Enter', async () => {
    const press = vi.fn()
    const page = {
      evaluate: async () => 'send-button',
      locator: () => ({ first: () => ({ press }) }),
    }
    await expect(clickSendOrSubmit(page)).resolves.toEqual({ channel: 'button', hit: 'send-button' })
    expect(press).not.toHaveBeenCalled()
  })

  it('探测为 null：fallback Enter 提交，返回 enter 通道', async () => {
    const press = vi.fn()
    const page = {
      evaluate: async () => null,
      locator: (sel) => {
        expect(sel).toBe('.composer-input[contenteditable="true"]')
        return { first: () => ({ press }) }
      },
    }
    await expect(clickSendOrSubmit(page)).resolves.toEqual({ channel: 'enter', hit: null })
    expect(press).toHaveBeenCalledWith('Enter')
  })
})

// ---------- CDP 边框余量算术 ----------

describe('windowBoundsForContent（resize 余量算术）', () => {
  it('外框 = 目标内容区 + 当前实测边框余量', () => {
    // 原内联表达式回归对照：width + (bounds.width - before.w)
    expect(windowBoundsForContent({ width: 390, height: 844 }, { width: 400, height: 900 }, { width: 384, height: 860 }))
      .toEqual({ width: 390 + (400 - 384), height: 844 + (900 - 860) })
  })

  it('零余量（外框=内容区，无窗口边框）：外框即目标尺寸', () => {
    expect(windowBoundsForContent({ width: 390, height: 844 }, { width: 390, height: 844 }, { width: 390, height: 844 }))
      .toEqual({ width: 390, height: 844 })
  })
})

describe('restoreWindowBounds（恢复宽度校准算术）', () => {
  it('从外框宽扣除「实际生效内容宽 - 期望内容宽」差量，高度保持', () => {
    // 原内联表达式回归对照：bounds.width - ((orig.nowW ?? orig.w) - orig.w)
    expect(restoreWindowBounds(400, 420, 390, 900)).toEqual({ width: 400 - (420 - 390), height: 900 })
  })

  it('实际生效即期望宽（nowW 回退 orig.w）：外框宽不变', () => {
    expect(restoreWindowBounds(400, 390, 390, 900)).toEqual({ width: 400, height: 900 })
  })
})

// ---------- cli.mjs 参数解析 ----------

describe('flagValue', () => {
  it('flag 存在返回其后紧跟值', () => {
    expect(flagValue(['node', 'cli.mjs', '--cdp-port', '9222'], '--cdp-port')).toBe('9222')
  })

  it('flag 位于末尾无值：undefined（与原 arg() 行为一致）', () => {
    expect(flagValue(['node', 'cli.mjs', '--cdp-port'], '--cdp-port')).toBeUndefined()
  })

  it('flag 缺失：undefined', () => {
    expect(flagValue(['node', 'cli.mjs'], '--out')).toBeUndefined()
  })

  it('非 flag 的同名值不误匹配（indexOf 精确比对）', () => {
    expect(flagValue(['node', 'cli.mjs', '--cdp-port', '--out', 'dir'], '--out')).toBe('dir')
  })
})

describe('missingSampleCliArgs', () => {
  it('三要素齐全：空数组', () => {
    expect(missingSampleCliArgs({ cdpPort: '9222', samplePath: 'a.md', outDir: 'out' })).toEqual([])
  })

  it('逐项报出缺失 flag（错误信息指向恢复动作）', () => {
    expect(missingSampleCliArgs({ cdpPort: '9222' })).toEqual(['--sample', '--out'])
    expect(missingSampleCliArgs({})).toEqual(['--cdp-port', '--sample', '--out'])
  })

  it('空串视为缺失（与原 !cdpPort 判定一致）', () => {
    expect(missingSampleCliArgs({ cdpPort: '', samplePath: 'a.md', outDir: 'out' })).toEqual(['--cdp-port'])
  })
})
