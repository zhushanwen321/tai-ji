import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { isValidExternalUrl, isPathInAllowedPrefixes, isAllowedAppNavigation } from '../gateway/input-validators.js'

describe('isValidExternalUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isValidExternalUrl('http://example.com')).toBe(true)
    expect(isValidExternalUrl('https://example.com/path?q=1')).toBe(true)
  })

  it('accepts mixed-case protocol (case-insensitive)', () => {
    expect(isValidExternalUrl('HTTPS://example.com')).toBe(true)
    expect(isValidExternalUrl('HtTp://example.com')).toBe(true)
  })

  it('rejects dangerous protocols', () => {
    expect(isValidExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isValidExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isValidExternalUrl('data:text/html,<script>1</script>')).toBe(false)
  })

  it('rejects protocol-relative and bare strings', () => {
    expect(isValidExternalUrl('//example.com')).toBe(false)
    expect(isValidExternalUrl('example.com')).toBe(false)
    expect(isValidExternalUrl('')).toBe(false)
  })
})

describe('isPathInAllowedPrefixes', () => {
  // 按文档契约：allowedPrefixes 须带 trailing path.sep
  const allowed = [path.join('/tmp', 'allowed') + path.sep]
  const base = path.join('/tmp', 'allowed')

  it('allows file inside allowed dir', () => {
    expect(isPathInAllowedPrefixes(path.join(base, 'foo.txt'), allowed)).toBe(true)
    expect(isPathInAllowedPrefixes(path.join(base, 'sub', 'bar.txt'), allowed)).toBe(true)
  })

  it('allows the allowed dir itself (exact dir match)', () => {
    // resolved === '/tmp/allowed' → resolved + sep === '/tmp/allowed/'
    expect(isPathInAllowedPrefixes(base, allowed)).toBe(true)
  })

  it('rejects sibling dir outside allowed', () => {
    expect(isPathInAllowedPrefixes(path.join('/tmp', 'other', 'x.txt'), allowed)).toBe(false)
    expect(isPathInAllowedPrefixes('/tmp/secret', allowed)).toBe(false)
  })

  it('neutralizes ../ directory traversal via path.resolve', () => {
    // /tmp/allowed/../secret → resolve → /tmp/secret → not under allowed
    expect(isPathInAllowedPrefixes(path.join(base, '..', 'secret'), allowed)).toBe(false)
    expect(isPathInAllowedPrefixes(`${base}/../../../../etc/passwd`, allowed)).toBe(false)
  })

  it('prevents trailing-sep prefix false match (foo vs foobar)', () => {
    // /tmp/allowed-sibling must NOT match prefix /tmp/allowed/
    expect(isPathInAllowedPrefixes(path.join('/tmp', 'allowedbar', 'x'), allowed)).toBe(false)
    expect(isPathInAllowedPrefixes('/tmp/allowed-extension', allowed)).toBe(false)
  })

  it('returns false when no prefixes provided', () => {
    expect(isPathInAllowedPrefixes('/tmp/allowed/foo.txt', [])).toBe(false)
  })

  it('matches against any of multiple prefixes', () => {
    const multi = [
      path.join('/tmp', 'a') + path.sep,
      path.join('/tmp', 'b') + path.sep,
    ]
    expect(isPathInAllowedPrefixes(path.join('/tmp', 'b', 'x'), multi)).toBe(true)
    expect(isPathInAllowedPrefixes(path.join('/tmp', 'c', 'x'), multi)).toBe(false)
  })
})

describe('isAllowedAppNavigation（D2b will-navigate 应用自身源判定）', () => {
  // window-factory 调用形态：devOrigin=VITE_DEV_URL，fileRoot=app.getAppPath()
  const opts = { devOrigin: 'http://localhost:1420', fileRoot: '/Applications/TaiJi.app/Contents/Resources/app.asar' }

  it('dev 态：放行 vite dev server 同源导航（含 query 与 HMR full-reload 同源）', () => {
    expect(isAllowedAppNavigation('http://localhost:1420/?windowId=win-1', opts)).toBe(true)
    expect(isAllowedAppNavigation('http://localhost:1420/some/route', opts)).toBe(true)
  })

  it('dev 态：拒绝非 1420 端口的本地 server 与远程源', () => {
    expect(isAllowedAppNavigation('http://localhost:1421/', opts)).toBe(false)
    expect(isAllowedAppNavigation('http://evil.example.com/', opts)).toBe(false)
    expect(isAllowedAppNavigation('https://evil.example.com/', opts)).toBe(false)
  })

  it('prod/E2E 态：放行 file:// 且路径在 appPath 内', () => {
    expect(isAllowedAppNavigation(
      'file:///Applications/TaiJi.app/Contents/Resources/app.asar/renderer/dist/index.html',
      opts,
    )).toBe(true)
  })

  it('file:// 但路径在 appPath 之外被拒（防 preload 注入到任意本地页）', () => {
    expect(isAllowedAppNavigation('file:///etc/passwd', opts)).toBe(false)
    expect(isAllowedAppNavigation('file:///Users/tester/evil.html', opts)).toBe(false)
    // appPath 兄弟目录不被前缀误放行（trailing sep）
    expect(isAllowedAppNavigation(
      'file:///Applications/TaiJi.app/Contents/Resources/app.asar.evil/x.html',
      opts,
    )).toBe(false)
  })

  it('非 http(s) origin 匹配一律拒绝：about:blank / javascript: / 空 / 非法 URL', () => {
    expect(isAllowedAppNavigation('about:blank', opts)).toBe(false)
    expect(isAllowedAppNavigation('javascript:alert(1)', opts)).toBe(false)
    expect(isAllowedAppNavigation('', opts)).toBe(false)
    expect(isAllowedAppNavigation('not a url', opts)).toBe(false)
  })

  it('可选参数缺省不参与判定（只传 devOrigin 或只传 fileRoot）', () => {
    expect(isAllowedAppNavigation('http://localhost:1420/', { devOrigin: 'http://localhost:1420' })).toBe(true)
    expect(isAllowedAppNavigation('http://localhost:1420/', { fileRoot: '/app' })).toBe(false)
    expect(isAllowedAppNavigation('file:///app/index.html', { fileRoot: '/app' })).toBe(true)
    expect(isAllowedAppNavigation('file:///app/index.html', {})).toBe(false)
  })
})
