/**
 * 容器关闭后的焦点契约落点（display-containers §6.7 焦点契约）：任一容器关闭后焦点回
 * composer——**放弃「归还打开前焦点」的精确锚定**（既有 overlay 壳的焦点锚记录/归还行为
 * 随 W1 拆除），统一回 composer 的单一规则，不为浮层单独保留第二套焦点语义。
 *
 * composer-box 是 Composer.vue 根输入容器（class + data-testid 双锚，useGlobalShortcuts
 * 的 isComposerFocused 同源判定）；其内层 contenteditable 才是真实可聚焦输入，聚焦下沉
 * 到内层（无内层时聚焦容器本身，保持可见焦点环）。
 */
const COMPOSER_BOX_SELECTOR = '[data-testid="composer-box"], .composer-box'

export function focusComposer(): void {
  const box = document.querySelector<HTMLElement>(COMPOSER_BOX_SELECTOR)
  if (!box) return
  const input = box.querySelector<HTMLElement>('[contenteditable="true"], textarea, input')
  const target = input ?? box
  if (typeof target.focus === 'function') target.focus()
}
