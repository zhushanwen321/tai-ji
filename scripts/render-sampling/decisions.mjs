// render-sampling 管道判定层：lib.mjs 中所有「出错即静默产物污染」的决策逻辑
// （发送按钮 sig 匹配 / 渲染判稳 / CDP 边框余量算术 / CLI 参数解析）收拢于此，
// vitest 直测（scripts/__tests__/render-sampling-decisions.test.mjs）。
// 抽取先例：scripts/lib/scheduler-e2e-judgers.cjs（84b05333e）。
//
// 两类函数，约束不同：
// 1. 浏览器侧采集函数（probeSendButton / collectRenderState）——page.evaluate
//    直接传函数引用，playwright 序列化函数体后闭包丢失，故必须自包含（禁止引用
//    模块级符号）；默认参数 doc = document 使同一函数体可被 jsdom 直测。
// 2. 纯数据函数（isRenderSettled / 余量算术 / CLI 参数）——无 DOM 依赖，Node 侧直测。

/**
 * 发送按钮探测（浏览器侧自包含）：从 .composer-input 的父元素向上取最近 div
 * 祖先为容器（真实结构：composer-input 是 div，closest('div') 含自身会把作用域
 * 缩成输入框内部，兄弟层发送按钮（Composer.vue composer-bar 内）永远不可达，
 * 按钮通道退化为恒 fallback Enter——scope 必须从 parentElement 起算），返回第一个
 * 未禁用且 sig（aria-label / title / data-testid 拼接）命中 send|发送|submit 的
 * button，click 后返回命中 sig（trim 后）；无 composer 或无命中返回 null
 * （调用方 fallback Enter 提交）。sig 匹配规则漂移 = 发送通道判定漂移，改动须同步单测。
 * @param {Document} doc
 * @returns {string | null}
 */
export function probeSendButton(doc = document) {
  const composer = doc.querySelector('.composer-input')
  if (!composer) return null
  const scope = composer.parentElement?.closest('div') ?? doc
  for (const el of scope.querySelectorAll('button')) {
    if (el.disabled) continue
    const sig = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('data-testid') ?? ''}`
    if (/send|发送|submit/i.test(sig)) {
      el.click()
      return sig.trim()
    }
  }
  return null
}

/**
 * 渲染状态采集（浏览器侧自包含）：img 三态计数（pending = 加载中未完成 /
 * broken = complete 且 naturalWidth=0 的失败图 / loaded = naturalWidth>0）
 * + 文档滚动高度（判稳依据）。naturalWidth 是图片加载完成的唯一可靠信号。
 * @param {Document} doc
 * @returns {{ pending: number, broken: number, loaded: number, height: number }}
 */
export function collectRenderState(doc = document) {
  const imgs = [...doc.querySelectorAll('img')]
  return {
    pending: imgs.filter((i) => i.naturalWidth === 0 && !i.complete).length,
    broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
    loaded: imgs.filter((i) => i.naturalWidth > 0).length,
    height: doc.documentElement.scrollHeight,
  }
}

/**
 * 渲染判稳判定：布局高度与上一轮相同且无 pending 图片。纯数据函数，
 * 循环与超时编排留在 lib.mjs waitForRenderSettled。
 * @param {{ pending: number, height: number }} state
 * @param {number} lastHeight 上一轮 height（首轮 -1 恒不等，保证至少采样两轮）
 */
export function isRenderSettled(state, lastHeight) {
  return state.height === lastHeight && state.pending === 0
}

/**
 * resizeViewport 的 windowBounds 余量算术：目标外框 = 目标内容区 + 当前实测
 * 边框余量（外框 - 内容区）。算错 = 窄窗验收尺寸全错且无报错（静默产物污染）。
 * @param {{ width: number, height: number }} target 目标内容区尺寸
 * @param {{ width: number, height: number }} frame 当前窗口外框尺寸
 * @param {{ width: number, height: number }} content resize 前内容区尺寸
 * @returns {{ width: number, height: number }} Browser.setWindowBounds 的 bounds
 */
export function windowBoundsForContent(target, frame, content) {
  return {
    width: target.width + (frame.width - content.width),
    height: target.height + (frame.height - content.height),
  }
}

/**
 * restoreViewport 的宽度校准算术：从当前外框宽扣除「实际生效内容宽 - 期望内容宽」
 * 的差量，使内容区回到期望宽度；高度保持外框现值（恢复只针对宽度轴）。
 * @param {number} frameW 当前窗口外框宽
 * @param {number} actualW resizeViewport 实际生效的内容宽（nowW，缺省回退原内容宽）
 * @param {number} targetW 期望恢复的内容宽
 * @returns {{ width: number, height: number }}（height 由调用方传入当前外框高）
 */
export function restoreWindowBounds(frameW, actualW, targetW, frameH) {
  return { width: frameW - (actualW - targetW), height: frameH }
}

/**
 * CLI 参数读取：flag 存在返回其后的值（末尾无值时 undefined，与原 arg() 行为一致），
 * 不存在返回 undefined。
 * @param {string[]} argv
 * @param {string} flag 形如 '--cdp-port'
 */
export function flagValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i !== -1 ? argv[i + 1] : undefined
}

/**
 * cli.mjs 三要素校验：返回缺失的必填 flag 清单（空数组 = 齐全）。
 * @param {{ cdpPort?: string, samplePath?: string, outDir?: string }} args
 * @returns {string[]}
 */
export function missingSampleCliArgs({ cdpPort, samplePath, outDir }) {
  const missing = []
  if (!cdpPort) missing.push('--cdp-port')
  if (!samplePath) missing.push('--sample')
  if (!outDir) missing.push('--out')
  return missing
}
