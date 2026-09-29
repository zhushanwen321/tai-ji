/**
 * Task 2 测试: Worker Sandbox (require 拦截)
 *
 * 验证 sandbox 模式下 require 拦截逻辑：
 * - trusted Worker 的 require 不受限
 * - sandbox Worker require 被拦截（blockedBuiltins）
 * - process.env 被替换为空 Proxy
 *
 * 不创建真实 Worker Thread，只单元测试拦截函数逻辑。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  createRequireInterceptor,
} from '../src/services/plugin-service/plugin-sandbox.js'

describe('Task 2: Worker Sandbox (require 拦截)', () => {
  describe('createRequireInterceptor', () => {
    // fixture 目录 mkdtemp 自建自删且测试侧先 realpathSync 归一：生产码
    // createRequireInterceptor 内部对 pluginDir 做 realpathSync 归一后再 startsWith
    // 判界（macOS tmpdir 经 /var → /private/var symlink）——目录缺失会走生产码
    // realpath warn + fail-closed 分支，未归一则断言传入的 resolvedPath 字符串与
    // 归一后的判界前缀恒不匹配。
    let pluginDir = ''

    beforeAll(() => {
      pluginDir = realpathSync(mkdtempSync(join(tmpdir(), 'taiji-plugin-sandbox-')))
    })

    afterAll(() => {
      if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('allows relative paths within pluginDir', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 应该不抛异常
      const inside = join(pluginDir, 'utils.js')
      const result = interceptor('./utils', inside)
      expect(result).toBe(inside)
    })

    it('rejects relative paths outside pluginDir', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 第二形态：嵌套穿越（./../../ 前缀），宿主 resolve 后同样落在 pluginDir 外
      const cases = [
        { request: '../escape', resolved: join(dirname(pluginDir), 'escape.js') },
        { request: './../../etc/passwd', resolved: join(dirname(pluginDir), 'etc', 'passwd') },
      ] as const
      for (const { request, resolved } of cases) {
        try {
          interceptor(request, resolved)
          expect.unreachable('should have thrown')
        } catch (err) {
          expect(err).toBeInstanceOf(Error)
          expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
        }
      }
    })

    it('rejects blocked builtin modules', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 'module'：node:module 暴露 createRequire，是绕过链第一环（黑名单必含）
      for (const mod of ['fs', 'child_process', 'net', 'module']) {
        try {
          interceptor(mod, undefined)
          expect.unreachable('should have thrown')
        } catch (err) {
          expect(err).toBeInstanceOf(Error)
          expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
        }
      }
    })

    it('rejects node: prefixed builtins (M6a-01 bypass regression)', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // CJS 侧黑名单查 node: 前缀剥离后的裸名：node:fs / node:child_process / node:module
      // 均须拦截（node:module 的 createRequire 是绕过链第一环）
      for (const mod of ['node:fs', 'node:fs/promises', 'node:child_process', 'node:module']) {
        try {
          interceptor(mod, undefined)
          expect.unreachable(`should have thrown for ${mod}`)
        } catch (err) {
          expect(err).toBeInstanceOf(Error)
          expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
        }
      }
    })

    it('allows node: prefixed safe builtins', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 安全模块的 node: 形态放行（require('node:path') 与 require('path') 等价）
      for (const mod of ['node:path', 'node:util', 'node:events']) {
        expect(interceptor(mod, undefined)).toBe(mod)
      }
    })

    it('allows path, url, util, events', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      for (const mod of ['path', 'url', 'util', 'events']) {
        const result = interceptor(mod, undefined)
        expect(result).toBe(mod)
      }
    })
  })
})
