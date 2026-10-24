'use strict'
/**
 * verify-taiji 插件验收预载脚本（经 NODE_OPTIONS=--require 注入 dev 实例进程树）。
 *
 * 作用：把 npm registry 指向本机 mock（fixtures/plugin-pkgs 证书 + scenarios/lib/
 * mock-npm-registry.mjs 起的 HTTPS 服务）。为什么走 --require 而非直接设
 * NPM_CONFIG_REGISTRY：main→runtime 的 env 白名单（shared ENV_WHITELIST_PREFIXES）
 * 只放行 TAIJI_/NODE_ 等前缀，NPM_* 在 runtime 进程被剥除——预载脚本在 runtime
 * 进程自身启动时补写，绕不开的是白名单、补得上的是进程内 env。
 * NODE_EXTRA_CA_CERTS（信任 mock 证书）在白名单内，直接经 env 传递，不经本脚本。
 */
try {
  if (!process.env.NPM_CONFIG_REGISTRY) {
    process.env.NPM_CONFIG_REGISTRY = 'https://localhost:47820'
  }
} catch {
  /* 预载失败不阻断进程启动（安装场景会以 not_found 失败并可归因） */
}

/**
 * wool-manifest 本地夹具拦截（opt-in，A23a 双产物剧本专用）。
 *
 * WoolExtensionInstaller.fetchManifest 的清单地址是硬编码常量（github 权威源 + gitcode
 * 备源，manifestUrl 端口仅测试注入、组合根未暴露），真机剧本要确定性双产物安装就必须
 * 在零产品改动前提下把这两条 URL 的 fetch 折到本地夹具文件
 * （fixtures/plugin-pkgs/wool-manifest.json，路径经 TAIJI_VERIFY_WOOL_MANIFEST_FILE
 * 传入——TAIJI_ 前缀在 main→runtime env 白名单内）。只拦清单域名，其余请求原样透传
 * globalThis.fetch；未设 env 时本段整体不生效（其余剧本零影响）。
 */
try {
  const manifestFile = process.env.TAIJI_VERIFY_WOOL_MANIFEST_FILE
  if (manifestFile && !globalThis.__verifyWoolManifestPatched) {
    globalThis.__verifyWoolManifestPatched = true
    const nodeFs = require('node:fs')
    const origFetch = globalThis.fetch.bind(globalThis)
    const isManifestUrl = (url) =>
      typeof url === 'string' &&
      (url.includes('tai-ji-plugin/releases/latest/download/wool-manifest.json') ||
        url.startsWith('https://api.gitcode.com/'))
    globalThis.fetch = (input, init) => {
      try {
        const url = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : String(input)
        if (isManifestUrl(url)) {
          const body = nodeFs.readFileSync(manifestFile, 'utf8')
          return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
        }
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)))
      }
      return origFetch(input, init)
    }
  }
} catch {
  /* 拦截装配失败不阻断进程启动（双产物安装会以清单不可达失败并可归因） */
}
