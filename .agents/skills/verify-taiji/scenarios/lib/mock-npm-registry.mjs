/**
 * 本机 mock npm registry（verify-taiji 插件安装类剧本共享夹具）。
 *
 * 形态：HTTPS 静态服务（Node 内置 https，自签证书见 fixtures/plugin-pkgs/certs/），
 * 实现 NpmPluginInstaller → downloadPackageTarball 消费的最小 registry 面：
 *   GET /<name>                    → packument 元数据（dist-tags + versions[].dist.tarball）
 *   GET /<name>/-/<file>.tgz      → tarball 字节（npm pack 产物，package/ 根 strip=1 兼容）
 *
 * 为什么是 HTTPS + localhost：npm-installer 的 validateUrlHost 拒绝非 https 与
 * 纯 IP/私网 host（SSRF 防线）；`localhost` 含字母可过 host 检查，https 由
 * NODE_EXTRA_CA_CERTS（env 白名单 NODE_ 前缀放行）信任自签证书。registry 地址本身
 * 经 NODE_OPTIONS=--require 预载脚本注入（NPM_* 不在 main→runtime env 白名单），
 * 预载脚本 = fixtures/plugin-pkgs/preload/npm-registry-preload.cjs。
 *
 * 端口固定 47820（预载脚本内写死同值；剧本进程串行运行，进程退出即释放端口）。
 */
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

/**
 * 夹具根定位（repo 锚定）：worktree 的 .agents 是指向 workspace 的符号链接，Node
 * 模块 realpath 会把 import.meta.dirname 解析到 workspace 侧——路径一律以 worktree
 * 根（ctx.repo）为锚，不经模块自身路径推导。
 */
export function pluginPkgsDir(repo) {
  return path.join(repo, '.agents', 'skills', 'verify-taiji', 'fixtures', 'plugin-pkgs')
}

export const REGISTRY_PORT = 47820
export const REGISTRY_URL = `https://localhost:${REGISTRY_PORT}`

/** 预载注入需要的实例 env（scenario meta.env 直接展开使用）。 */
export function registryEnv(repo) {
  const dir = pluginPkgsDir(repo)
  return {
    NODE_EXTRA_CA_CERTS: path.join(dir, 'certs', 'localhost-cert.pem'),
    NODE_OPTIONS: `--require ${path.join(dir, 'preload', 'npm-registry-preload.cjs')}`,
  }
}

/**
 * 起服务。pkgs 形态：
 *   { '<name>': { versions: { '<ver>': '<abs .tgz path>' }, latest: '<ver>' } }
 * 返回句柄 { url, port, setLatest(name, ver), requests, close() }。
 */
export async function startMockNpmRegistry(repo, pkgs) {
  const dir = pluginPkgsDir(repo)
  const distDir = path.join(dir, 'dist')
  const state = { pkgs }
  const requests = []

  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(dir, 'certs', 'localhost-key.pem')),
      cert: fs.readFileSync(path.join(dir, 'certs', 'localhost-cert.pem')),
    },
    (req, res) => {
      const url = new URL(req.url, 'https://localhost')
      requests.push({ path: url.pathname, at: Date.now() })
      // packument：/<name>（非 scoped；encodePackageName 对 scoped 才转义，夹具全用裸名）
      const pkgName = decodeURIComponent(url.pathname).replace(/^\//, '').split('/-/')[0]
      const pkg = state.pkgs[pkgName]
      if (!pkg) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not_found', name: pkgName }))
        return
      }
      const tgzMatch = url.pathname.match(/\/-\/(.+\.tgz)$/)
      if (tgzMatch) {
        const file = path.join(distDir, tgzMatch[1])
        if (!fs.existsSync(file)) {
          res.writeHead(404)
          res.end('tarball not found')
          return
        }
        res.writeHead(200, { 'content-type': 'application/x-gzip' })
        fs.createReadStream(file).pipe(res)
        return
      }
      const versions = {}
      for (const [ver, file] of Object.entries(pkg.versions)) {
        const tarballFile = path.basename(file)
        versions[ver] = {
          name: pkgName,
          version: ver,
          dist: {
            tarball: `${REGISTRY_URL}/${pkgName}/-/${tarballFile}`,
            // 不带 integrity/shasum → 下载端跳过完整性校验（本地夹具无此需求）
          },
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: pkgName, 'dist-tags': { latest: pkg.latest }, versions }))
    },
  )

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(REGISTRY_PORT, '127.0.0.1', resolve)
  })

  return {
    url: REGISTRY_URL,
    port: REGISTRY_PORT,
    requests,
    /** 翻转 dist-tags.latest（S26 更新链：推高清单 latest 触发更新提示）。 */
    setLatest(name, ver) {
      if (!state.pkgs[name]) throw new Error(`mock registry: unknown package ${name}`)
      state.pkgs[name].latest = ver
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * 写插件清单（remote-config 域缓存文件，runtime 经 fail-safe 链/节流窗读它）。
 * dataDir = 实例数据目录；entries = PluginCatalogEntry 数组（family 元数据见
 * runtime plugin-catalog.ts guard：id/displayName/vendor 非空、credentialSource ∈
 * {oauth, ide-extract}、modelCount 非负整数）。
 *
 * 注意：不要给夹具条目带 piExtensionVersion——installPiExtensionMember 按该字段
 * 判定双产物，缺失 = 单产物（跳过 WoolExtensionInstaller）。
 */
export function seedPluginCatalog(dataDir, entries) {
  const dir = path.join(dataDir, 'remote-config')
  fs.mkdirSync(dir, { recursive: true })
  const envelope = {
    version: 1,
    checkedAt: Date.now(),
    data: { version: 1, plugins: entries },
  }
  const file = path.join(dir, 'v2-plugins.json')
  fs.writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  return file
}

/**
 * 家族清单条目构造器（单产物 provider 插件形态）。
 * namespace = 插件命名空间（= family.id，条目行与清单家族的前缀匹配键）。
 * piExtensionVersion 传入 = 双产物条目（A23a：plugin-catalog guard 允许该字段出现，
 * plugin-service.installPiExtensionMember 按它判定需装 pi 扩展成员）。
 */
export function catalogEntry({ packageName, pluginId, displayName, namespace, version, piExtensionVersion, capabilities = [], readPaths = [] }) {
  return {
    packageName,
    pluginId,
    displayName,
    pluginVersion: version,
    ...(piExtensionVersion !== undefined ? { piExtensionVersion } : {}),
    family: {
      id: namespace,
      displayName,
      vendor: 'verify-taiji fixtures',
      credentialSource: 'oauth',
      modelCount: 1,
    },
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(readPaths.length > 0 ? { readPaths } : {}),
  }
}
