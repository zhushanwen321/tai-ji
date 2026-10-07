# branch-review minor 残余（feat-optimize-ui → dev-0.11.0，随分支带走）

来源：dev-merge 合入点横切审查（feat-optimize-ui → dev-0.11.0，2026-10-07，run 记录 `.tmp/dev-merge-review/dmg-2a471eeda/`）。质量门全绿，必修（critical/major）经 2 轮审查修复循环全部收敛；以下 2 条建议级（minor）按流程随分支带走，不阻塞合并，待后续排期。各条完整证据链见 run 目录 ledger.json。同轮第 3 条 minor（win1.png 误入 residual commit）已当场修复（删除 commit ebc532d32），不在此列。

## 1. AnsiText.vue ANSI 解析降级后 watch 守卫吞掉全部后续更新，渲染管线永久冻结无自愈路径（dmg-r2-2）

- 现状：`packages/ui/src/rendering-protocol/primitives/AnsiText.vue` 的 renderFull catch（:79-84）置 `parser = null`、`processedLen = -1`（onMounted :88-90 首渲与 watch 重建分支 :113 两处可达）；watch 首行守卫 :96 `if (!el || !parser || prev === undefined) return` 把降级态（parser=null）的每次后续 content 更新直接 return——工具输出流冻结在降级时刻的转义文本直至组件重挂载，且无告警。组件头注释 :14「降级后恢复：新建 AnsiUp 实例全量重渲染」与 :80「parser 置空，下轮强制重建」声明的设计意图恰被该守卫阻断（守卫拦截了它声称的『下轮重建』）。违反 code-harden「错误后状态必须回到可继续的正确状态」与 C-proc-21「降级 ≠ 吞错」。
- 实现要点：watch 回调守卫改分流：`if (!el) return` 之后，`!parser || processedLen < 0 || prev === undefined` 时直接 `renderFull(next); return`（全量重建自愈，兑现头注释「降级后恢复」设计意图）；保留既有追加分支持 `catch → renderFull(next)` 不变。补一条单测：首渲触发降级（ansi_to_html 抛错）后继续追加 content，断言 DOM 渲染为新内容的全量重建而非冻结在降级时刻文本。

## 2. key-orchestrator Ctrl/Cmd+F 判定 `e.key === 'f'` 对 Shift/CapsLock 大写形态 miss，表面内查找快捷键不触发（dmg-r2-3）

- 现状：`packages/renderer/src/composables/features/app/key-orchestrator/orchestrator.ts:76` `if (e.key === 'f' && (e.metaKey || e.ctrlKey))`——Shift 按下或 CapsLock 开启时 `e.key === 'F'`，快捷键静默 miss；浏览器原生 Ctrl+F 按 keycode 判定不受大小写影响，属与本应用快捷键惯例的偏差。
- 实现要点：orchestrator.ts:76 判定改 `e.key.toLowerCase() === 'f'`（或并判 `e.code === 'KeyF'`），使 Shift/CapsLock 大写形态与浏览器原生 Ctrl+F 行为对齐；isComposing / defaultPrevented 守卫顺序保持不变。
