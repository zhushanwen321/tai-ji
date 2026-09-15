'use strict'

/**
 * ESM loader 集成测试 fixture（fork 子进程侧）。
 *
 * 收 run 消息（items: [{label, url}]）后逐个动态 import，把每个结果发回宿主后退出。
 * fixture 自身在 pluginDir 外（parentURL 不在沙箱内 → loader 放行），
 * 插件测试文件（.mjs，pluginDir 内）的内部 import 才会触发 loader 拦截——真实链路。
 */

process.on('message', async (msg) => {
  if (!msg || msg.type !== 'run') return

  const results = []
  for (const item of msg.items) {
    try {
      await import(item.url)
      results.push({ label: item.label, ok: true })
    } catch (e) {
      // code 属性（PERMISSION_DENIED）与 message 都回传，断言可验 code
      const err = e && typeof e === 'object' && 'code' in e ? e : null
      results.push({
        label: item.label,
        ok: false,
        error: err && err.code ? `${err.code}: ${String((e && e.message) || e)}` : String((e && e.message) || e),
      })
    }
  }

  if (process.send) process.send({ type: 'results', results })
  process.exit(0)
})
