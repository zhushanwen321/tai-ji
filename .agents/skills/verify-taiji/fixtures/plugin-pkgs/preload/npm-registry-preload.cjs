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
