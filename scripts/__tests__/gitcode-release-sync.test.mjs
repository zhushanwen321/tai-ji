/**
 * gitcode-release-sync.mjs 单测（MF-3）：
 * assetList / buildExistingAssetMap（分页形态字段候选 + 同名去重 + size null 语义）
 * 与 fetchUploadTarget（成功补默认 header / 失败信号），mock fetch 不打真 API。
 * runProbe 全链路失败信号 = fetchUploadTarget 非 ok 时 throw 的恢复指引文案（下方锁定）。
 *
 * 复杂度重构配套：apiCall（ok/非 ok/网络异常重试/429 退避/连败 die）、checkEnv（env 校验
 * 四分支）、createRelease（json→form→query 编码降载 + 401 编码无关失败 + 三连败 die +
 * 无 id 按 tag 回查兜底）。全部 mock fetch / mock process.exit，零真实网络调用。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

beforeAll(() => {
  process.env.GITCODE_TOKEN = 'test-token'
  process.env.GITCODE_REPO = 'owner/repo'
})

async function loadModule() {
  vi.resetModules()
  return import('../gitcode-release-sync.mjs')
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  }
}

/** token/repo 是模块加载时读的顶层 const：按用例改 env 后重新 import，结束恢复 beforeAll 值 */
async function withEnv(overrides, fn) {
  const saved = {
    GITCODE_TOKEN: process.env.GITCODE_TOKEN,
    GITCODE_REPO: process.env.GITCODE_REPO,
  }
  delete process.env.GITCODE_TOKEN
  delete process.env.GITCODE_REPO
  Object.assign(process.env, overrides)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  }
}

/** die() = console.error + process.exit(1)：mock exit 抛哨兵中断，捕获输出断言恢复指引 */
function spyDieTargets() {
  const errors = []
  const logs = []
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')) })
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')) })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT_1') })
  const restore = () => {
    exitSpy.mockRestore()
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  return { errors, logs, exitSpy, restore }
}

/** 推进 fake timers 走完 apiCall 链路的全部 sleep（重试退避 2000×attempt + 限速 1500） */
async function flushApiPauses(times = 8) {
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(1500)
  }
}

describe('assetList', () => {
  it('assets 标准形态（name + size 缺失 → null）', async () => {
    const { assetList } = await loadModule()
    const list = assetList({ assets: [{ name: 'a.dmg' }, { name: 'b.exe', size: 5 }] })
    expect(list).toEqual([
      { name: 'a.dmg', size: null },
      { name: 'b.exe', size: 5 },
    ])
  })
  it('attach_files / attachFiles 备选字段名 + 候选 size 字段名（filesize/file_size/attach_size）', async () => {
    const { assetList } = await loadModule()
    expect(assetList({ attach_files: [{ file_name: 'x', filesize: 3 }] })).toEqual([{ name: 'x', size: 3 }])
    expect(assetList({ attachFiles: [{ path: 'y', file_size: '7' }] })).toEqual([{ name: 'y', size: 7 }])
    expect(assetList({ assets: [{ filename: 'z', attach_size: 1 }] })).toEqual([{ name: 'z', size: 1 }])
  })
  it('assets 非数组 / name 空条目过滤 / releaseJson null 安全', async () => {
    const { assetList } = await loadModule()
    expect(assetList({ assets: 'nope' })).toEqual([])
    expect(assetList({ assets: [{ size: 1 }, { name: 'ok' }] })).toEqual([{ name: 'ok', size: null }])
    expect(assetList(null)).toEqual([])
  })
  it('GitCode 实测形态（条目仅 browser_download_url/name/type/id，无 size）→ size null', async () => {
    const { assetList } = await loadModule()
    expect(assetList({ assets: [
      { id: 1, name: 'Taiji-1.0.0.dmg', type: 'binary', browser_download_url: 'https://gitcode.com/owner/repo/releases/download/1.0.0/Taiji-1.0.0.dmg' },
    ] })).toEqual([{ name: 'Taiji-1.0.0.dmg', size: null }])
  })
})

describe('buildExistingAssetMap（runSync 幂等跳过判定）', () => {
  it('同名条目去重（Map 构造 last-wins），null size 语义保留（同名即跳过）', async () => {
    const { buildExistingAssetMap } = await loadModule()
    const m = buildExistingAssetMap({
      assets: [{ name: 'a', size: 1 }, { name: 'a', size: 2 }, { name: 'b' }],
    })
    expect(m.get('a')).toBe(2)
    expect(m.get('b')).toBeNull()
    expect(m.size).toBe(2)
  })
})

describe('fetchUploadTarget', () => {
  // S-R2-1：apiCall 成功路径自带 sleep(CALL_PAUSE_MS=1500) 串行限速，fake timers 推进
  // 计时器避免真实等待（timer 测试规范）；rejects 断言需在推进计时器前先挂上，
  // 否则 rejection 在推进期间浮动未处理（unhandled rejection 噪音）。
  it('成功：相对 upload_url 补 API 域 + headers 缺 Content-Type 就地补默认', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ upload_url: '/presigned/foo', headers: { 'x-oss': '1' } }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    try {
      const { fetchUploadTarget } = await loadModule()
      const p = fetchUploadTarget('v1.0.0', 'app.dmg')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1500)
      const t = await p
      expect(t.finalUrl).toBe('https://api.gitcode.com/presigned/foo')
      expect(t.headerArgs).toContain('-H \'x-oss: 1\'')
      expect(t.headerArgs).toContain('-H \'Content-Type: application/octet-stream\'')
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('失败信号：非 ok 时 throw 恢复指引（确认 release 存在 + 文档核对）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'not found' }, 404))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    try {
      const { fetchUploadTarget } = await loadModule()
      const assertion = expect(fetchUploadTarget('v1.0.0', 'app.dmg')).rejects.toThrow(/获取附件上传地址失败（HTTP 404）/)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1500)
      await assertion
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('失败信号：响应无 upload_url/url 字段时 throw（API 形态漂移显式报错）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ foo: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    try {
      const { fetchUploadTarget } = await loadModule()
      const assertion = expect(fetchUploadTarget('v1.0.0', 'app.dmg')).rejects.toThrow(/无 upload_url\/url 字段/)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1500)
      await assertion
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

describe('apiCall（串行限速 + 指数退避重试）', () => {
  it('ok：相对 path 拼 API_BASE 前缀 + Private-Token 认证头，返回解析后的 json/text；完整 URL 原样透传', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ hello: 'world' }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    try {
      const { apiCall } = await loadModule()
      const p1 = apiCall('GET', '/repos/owner/repo/releases/tags/v1.0.0')
      await flushApiPauses(2)
      await expect(p1).resolves.toEqual({
        status: 200, ok: true, json: { hello: 'world' }, text: JSON.stringify({ hello: 'world' }),
      })
      const p2 = apiCall('GET', 'https://api.gitcode.com/presigned/foo')
      await flushApiPauses(2)
      await expect(p2).resolves.toMatchObject({ status: 200, ok: true })
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.gitcode.com/api/v5/repos/owner/repo/releases/tags/v1.0.0')
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { 'Private-Token': 'test-token' } })
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.gitcode.com/presigned/foo')
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('非 ok（400）：不重试（fetch 调 1 次），原样返回 status / ok:false / json / text', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'Request body parsing error' }, 400))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    try {
      const { apiCall } = await loadModule()
      const p = apiCall('POST', '/repos/owner/repo/releases')
      await flushApiPauses(2)
      await expect(p).resolves.toEqual({
        status: 400,
        ok: false,
        json: { message: 'Request body parsing error' },
        text: JSON.stringify({ message: 'Request body parsing error' }),
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('网络异常：退避后重试成功（fetch 调 2 次）', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => { throw new TypeError('fetch failed') })
      .mockImplementationOnce(async () => jsonResponse({ ok: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    try {
      const { apiCall } = await loadModule()
      const p = apiCall('GET', '/x')
      await flushApiPauses()
      await expect(p).resolves.toMatchObject({ status: 200, ok: true, json: { ok: 1 } })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('429 限流：退避后重试成功（fetch 调 2 次）', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse({ message: 'rate limited' }, 429))
      .mockImplementationOnce(async () => jsonResponse({ ok: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    try {
      const { apiCall } = await loadModule()
      const p = apiCall('GET', '/x')
      await flushApiPauses()
      await expect(p).resolves.toMatchObject({ status: 200, ok: true })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('连续 3 次网络异常：die 恢复指引（等 1 分钟重跑 / 查 API 变更）', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNRESET') })
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { apiCall } = await loadModule()
      const assertion = expect(apiCall('GET', '/x')).rejects.toThrow('EXIT_1')
      await flushApiPauses()
      await assertion
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(d.errors.join('\n')).toContain('GitCode API 连续 3 次失败：GET /x')
      expect(d.errors.join('\n')).toContain('恢复：等 1 分钟后重跑（api.gitcode.com 有限流与偶发 5xx）；持续失败到 docs.gitcode.com 查 API 是否变更。')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

describe('checkEnv（CLI 第一道闸：env 校验）', () => {
  it('缺 GITCODE_TOKEN：die（exit 1）+ secret/export 配置指引', async () => {
    await withEnv({ GITCODE_REPO: 'owner/repo' }, async () => {
      const { checkEnv } = await loadModule()
      const d = spyDieTargets()
      try {
        expect(() => checkEnv()).toThrow('EXIT_1')
        expect(d.errors.join('\n')).toContain('缺少环境变量 GITCODE_TOKEN（GitCode 私人令牌）。')
        expect(d.errors.join('\n')).toContain('或本地验证时 export GITCODE_TOKEN=<令牌> 后重跑。')
      } finally {
        d.restore()
      }
    })
  })
  it('缺 GITCODE_REPO：die + variable/export 配置指引', async () => {
    await withEnv({ GITCODE_TOKEN: 't' }, async () => {
      const { checkEnv } = await loadModule()
      const d = spyDieTargets()
      try {
        expect(() => checkEnv()).toThrow('EXIT_1')
        expect(d.errors.join('\n')).toContain('缺少或非法的环境变量 GITCODE_REPO=""')
        expect(d.errors.join('\n')).toContain('本地验证时 export GITCODE_REPO=<owner/repo>。')
      } finally {
        d.restore()
      }
    })
  })
  it('非法 repo 格式（多段斜杠）：die 并回显原值', async () => {
    await withEnv({ GITCODE_TOKEN: 't', GITCODE_REPO: 'a/b/c' }, async () => {
      const { checkEnv } = await loadModule()
      const d = spyDieTargets()
      try {
        expect(() => checkEnv()).toThrow('EXIT_1')
        expect(d.errors.join('\n')).toContain('缺少或非法的环境变量 GITCODE_REPO="a/b/c"（应为 GitCode 仓库 owner/repo，如 qq_18433817/tai-ji）。')
      } finally {
        d.restore()
      }
    })
  })
  it('token + 合法 repo 全齐：通过（不 exit 不报错）', async () => {
    await withEnv({ GITCODE_TOKEN: 't', GITCODE_REPO: 'owner/repo' }, async () => {
      const { checkEnv } = await loadModule()
      const d = spyDieTargets()
      try {
        expect(() => checkEnv()).not.toThrow()
        expect(d.exitSpy).not.toHaveBeenCalled()
        expect(d.errors).toEqual([])
      } finally {
        d.restore()
      }
    })
  })
})

/** Range 探测响应 mock：probeRemoteSize 读 status + headers.content-range 的 total */
function rangeResponse(status, total) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (/content-range/i.test(k) && total !== undefined ? `bytes 0-1023/${total}` : null) },
    text: async () => '',
  }
}

describe('diffNameSets（refs/附件镜像共用的集合互差）', () => {
  it('missing = 期望有实际无；extra = 实际有期望无；两侧全等时双空', async () => {
    const { diffNameSets } = await loadModule()
    expect(diffNameSets(['a', 'b'], ['b', 'c'])).toEqual({ missing: ['a'], extra: ['c'] })
    expect(diffNameSets(['a'], ['a'])).toEqual({ missing: [], extra: [] })
    expect(diffNameSets([], ['x'])).toEqual({ missing: [], extra: ['x'] })
    expect(diffNameSets(['x'], [])).toEqual({ missing: ['x'], extra: [] })
  })
  it('行含 hash 前缀（refs 场景）时按完整行全等比对，不做部分匹配', async () => {
    const { diffNameSets } = await loadModule()
    const src = ['abc123 refs/heads/main', 'def456 refs/tags/v1.0.0']
    const dst = ['abc123 refs/heads/main', 'fff000 refs/tags/v1.0.0']
    expect(diffNameSets(src, dst)).toEqual({
      missing: ['def456 refs/tags/v1.0.0'],
      extra: ['fff000 refs/tags/v1.0.0'],
    })
  })
})

describe('verifyUploadedAssets（附件推后验证：name 集合 + 逐件远端大小）', () => {
  const FILES = [
    { name: 'a.dmg', size: 100 },
    { name: 'b.zip', size: 200 },
  ]

  it('全部通过：assets 齐且远端大小逐一相符，不 exit，打印通过行', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse({ id: 1, assets: [{ name: 'a.dmg' }, { name: 'b.zip' }] }))
      .mockImplementationOnce(async () => rangeResponse(206, 100))
      .mockImplementationOnce(async () => rangeResponse(206, 200))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { verifyUploadedAssets } = await loadModule()
      const p = verifyUploadedAssets('v1.0.0', FILES)
      await flushApiPauses(3)
      await p
      expect(d.exitSpy).not.toHaveBeenCalled()
      expect(d.logs.join('\n')).toContain('附件验证通过：2 件全部存在且远端大小与本地一致')
      // 第二件直链探测确实走了匿名下载 URL（302 由 fetch mock 层面消化）
      expect(fetchMock.mock.calls[1][0]).toContain('/releases/download/v1.0.0/a.dmg')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('缺失附件：die 并列出缺失清单与重跑恢复指引', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse({ id: 1, assets: [{ name: 'a.dmg' }] }))
      .mockImplementationOnce(async () => rangeResponse(206, 100))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { verifyUploadedAssets } = await loadModule()
      const assertion = expect(verifyUploadedAssets('v1.0.0', FILES)).rejects.toThrow('EXIT_1')
      await flushApiPauses(3)
      await assertion
      expect(d.errors.join('\n')).toContain('附件镜像验证失败：缺失 1 件：b.zip')
      expect(d.errors.join('\n')).toContain('恢复：重跑本命令（幂等，已成功件按名跳过只补缺失）')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('远端大小不符（截断/同名旧件残留）：die 列出两侧大小', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse({ id: 1, assets: [{ name: 'a.dmg' }, { name: 'b.zip' }] }))
      .mockImplementationOnce(async () => rangeResponse(206, 999))
      .mockImplementationOnce(async () => rangeResponse(206, 200))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { verifyUploadedAssets } = await loadModule()
      const assertion = expect(verifyUploadedAssets('v1.0.0', FILES)).rejects.toThrow('EXIT_1')
      await flushApiPauses(3)
      await assertion
      expect(d.errors.join('\n')).toContain('a.dmg —— 远端 999 != 本地 100 bytes（截断或同名旧件残留）')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('GitCode 多出附件（人工补件）：WARN 保留不删，不判失败', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse({ id: 1, assets: [{ name: 'a.dmg' }, { name: 'b.zip' }, { name: 'manual.bin' }] }))
      .mockImplementationOnce(async () => rangeResponse(206, 100))
      .mockImplementationOnce(async () => rangeResponse(206, 200))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { verifyUploadedAssets } = await loadModule()
      const p = verifyUploadedAssets('v1.0.0', FILES)
      await flushApiPauses(3)
      await p
      expect(d.exitSpy).not.toHaveBeenCalled()
      expect(d.logs.join('\n')).toContain('[WARN] GitCode 侧多出附件（人工补件？保留不删）：manual.bin')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('直链首次探测失败（CDN 未生效）：等 5s 重试一次成功则不判失败', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse({ id: 1, assets: [{ name: 'a.dmg' }] }))
      .mockImplementationOnce(async () => rangeResponse(404))
      .mockImplementationOnce(async () => rangeResponse(206, 100))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { verifyUploadedAssets } = await loadModule()
      const p = verifyUploadedAssets('v1.0.0', [FILES[0]])
      const assertion = vi.advanceTimersByTimeAsync(5000)
      await flushApiPauses(3)
      await assertion
      await p
      expect(d.exitSpy).not.toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(d.logs.join('\n')).toContain('附件验证通过：1 件全部存在且远端大小与本地一致')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('release 回查不到（状态异常）：die 指引重跑', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse({ message: 'not found' }, 404))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { verifyUploadedAssets } = await loadModule()
      const assertion = expect(verifyUploadedAssets('v1.0.0', FILES)).rejects.toThrow('EXIT_1')
      await flushApiPauses(3)
      await assertion
      expect(d.errors.join('\n')).toContain('附件镜像验证失败：release v1.0.0 回查不到')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

describe('createRelease（json→form→query 编码降载）', () => {
  const payloadJson = (body) => JSON.stringify({
    tag_name: 'v1.2.3', name: 'release 1.2.3', body, prerelease: 'false',
  })

  it('json 编码直接成功：body 为 JSON 串 + Content-Type json，无降档日志', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 111 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { createRelease } = await loadModule()
      const p = createRelease({ tag: 'v1.2.3', name: 'release 1.2.3', body: 'notes' })
      await flushApiPauses(2)
      await expect(p).resolves.toEqual({ id: 111 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.gitcode.com/api/v5/repos/owner/repo/releases')
      expect(opts.body).toBe(payloadJson('notes'))
      expect(opts.headers['Content-Type']).toBe('application/json')
      expect(d.logs.join('\n')).not.toContain('编码被拒')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('json 被拒 → form 成功：第 2 次调用 body 为 URLSearchParams（form 编码形态）', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse({ message: 'parsing error' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ id: 222 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { createRelease } = await loadModule()
      const p = createRelease({ tag: 'v1.2.3', name: 'release 1.2.3', body: 'notes' })
      await flushApiPauses(3)
      await expect(p).resolves.toEqual({ id: 222 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const [, opts0] = fetchMock.mock.calls[0]
      const [url1, opts1] = fetchMock.mock.calls[1]
      expect(opts0.body).toBe(payloadJson('notes'))
      expect(url1).toBe('https://api.gitcode.com/api/v5/repos/owner/repo/releases')
      expect(opts1.body).toBeInstanceOf(URLSearchParams)
      expect(opts1.body.toString()).toBe('tag_name=v1.2.3&name=release+1.2.3&body=notes&prerelease=false')
      expect(d.logs.join('\n')).toContain('[info] createRelease: json 编码被拒，form 编码成功（后续调用沿用）')
      expect(d.logs.join('\n')).toContain('[info] createRelease json 编码失败（HTTP 400）')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('json→form→query 全降档：第 3 次调用 URL 带 query 串、body 为空（编码形态断言）', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse({ message: 'parsing error' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ message: 'parsing error' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ id: 333 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { createRelease } = await loadModule()
      const p = createRelease({ tag: 'v1.2.3', name: 'release 1.2.3', body: 'notes' })
      await flushApiPauses(4)
      await expect(p).resolves.toEqual({ id: 333 })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      const [url2, opts2] = fetchMock.mock.calls[2]
      expect(url2).toBe(
        'https://api.gitcode.com/api/v5/repos/owner/repo/releases?tag_name=v1.2.3&name=release+1.2.3&body=notes&prerelease=false',
      )
      expect(opts2.body).toBeUndefined()
      expect(d.logs.join('\n')).toContain('[info] createRelease: json 编码被拒，query 编码成功（后续调用沿用）')
      expect(d.logs.join('\n')).toContain('[info] createRelease form 编码失败（HTTP 400）')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('query 成功但响应无 id：按 tag 回查返回 release（findReleaseByTag 兜底）', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse({ message: 'parsing error' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ message: 'parsing error' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ ok: 1 }))
      .mockImplementationOnce(async () => jsonResponse({ id: 444, assets: [] }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { createRelease } = await loadModule()
      const p = createRelease({ tag: 'v1.2.3', name: 'release 1.2.3', body: 'notes' })
      await flushApiPauses(5)
      await expect(p).resolves.toEqual({ id: 444, assets: [] })
      expect(fetchMock).toHaveBeenCalledTimes(4)
      const [url3] = fetchMock.mock.calls[3]
      expect(url3).toBe('https://api.gitcode.com/api/v5/repos/owner/repo/releases/tags/v1.2.3')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('401 编码无关错误：不降档直接 die（令牌恢复指引）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'unauthorized' }, 401))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { createRelease } = await loadModule()
      const assertion = expect(
        createRelease({ tag: 'v1.2.3', name: 'release 1.2.3', body: 'notes' }),
      ).rejects.toThrow('EXIT_1')
      await flushApiPauses()
      await assertion
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(d.errors.join('\n')).toContain('令牌无效或无写权限（HTTP 401）：')
      expect(d.errors.join('\n')).toContain('恢复：到 GitCode 个人设置检查私人令牌是否过期、是否授予目标仓库写权限')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('三种编码均失败：die 最后响应片段 + 文档核对指引', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'parsing error' }, 400))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const d = spyDieTargets()
    try {
      const { createRelease } = await loadModule()
      const assertion = expect(
        createRelease({ tag: 'v1.2.3', name: 'release 1.2.3', body: 'notes' }),
      ).rejects.toThrow('EXIT_1')
      await flushApiPauses()
      await assertion
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(d.errors.join('\n')).toContain('创建 release 三种编码均失败，最后响应（HTTP 400）')
      expect(d.errors.join('\n')).toContain('恢复：到 docs.gitcode.com/docs/apis/post-api-v-5-repos-owner-repo-releases 核对接口契约后调整本脚本')
    } finally {
      d.restore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
