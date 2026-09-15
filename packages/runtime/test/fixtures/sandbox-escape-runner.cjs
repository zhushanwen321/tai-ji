'use strict'

/**
 * S1-W3 沙箱逃逸回归 runner（fork 子进程侧）。
 *
 * 与 __tests__/fixtures/esm-loader-fixture.cjs 的差异：本 runner 回传 results 后
 * **不主动 process.exit**——被 import 的插件顶层 console.log（sibling 副作用标记）
 * 走 stdout pipe，异步 flush 尚未完成时 exit 会丢弃数据。宿主端收完结果并消费
 * stdout 后 kill 本进程。
 */

process.on('message', async (msg) => {
  if (!msg || msg.type !== 'run') return

  const results = []
  for (const item of msg.items) {
    try {
      await import(item.url)
      results.push({ label: item.label, ok: true })
    } catch (e) {
      const err = e && typeof e === 'object' && 'code' in e ? e : null
      results.push({
        label: item.label,
        ok: false,
        error: err && err.code ? `${err.code}: ${String((e && e.message) || e)}` : String((e && e.message) || e),
      })
    }
  }

  if (process.send) process.send({ type: 'results', results })
})
