/**
 * Demo Plugin E2E Test
 *
 * Validates the demo-plugin sample end-to-end without starting a real Worker:
 *   - package.json manifest is correctly structured for PluginRegistry
 *   - PluginModule.activate() registers tools, hooks, and calls ui.notify
 *   - Hook interceptor transforms content as expected
 */
import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  PluginContext,
  PluginModule,
  TaijiPackageJson,
  HookContext,
} from '../src/services/plugin-service/plugin-types.js'

// ── Helpers ──────────────────────────────────────────────────────

/** Path to the demo plugin directory */
const DEMO_DIR = join(__dirname, '..', 'src', 'plugins', 'demo')

/** Creates a mock PluginContext with spy implementations */
function createMockContext(): {
  context: PluginContext
  registeredTools: Array<{ name: string; description: string }>
  registeredHooks: Array<string>
  notifications: Array<{ level: string; message: string }>
} {
  const registeredTools: Array<{ name: string; description: string }> = []
  const registeredHooks: Array<string> = []
  const notifications: Array<{ level: string; message: string }> = []

  const context: PluginContext = {
    pluginId: 'demo-plugin',
    pluginPath: DEMO_DIR,
    globalState: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      keys: vi.fn(async () => []),
    },
    workspaceState: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      keys: vi.fn(async () => []),
    },
    api: {
      // ── tools ─────────────────────────────────────────────
      tools: {
        register: vi.fn(async (registration) => {
          registeredTools.push({ name: registration.name, description: registration.description })
          return `demo-plugin:${registration.name}`
        }),
        unregister: vi.fn(async () => {}),
      },
      // ── hooks ─────────────────────────────────────────────
      hooks: {
        onBeforeSendMessage: vi.fn(async (handler) => {
          registeredHooks.push('onBeforeSendMessage')
          // Store handler for later invocation in tests
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(context as any)._hookHandlers = (context as any)._hookHandlers || []
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(context as any)._hookHandlers.push(handler)
          return { dispose: () => {} }
        }),
        onBeforeToolCall: vi.fn(async () => ({ dispose: () => {} })),
        onBeforeAgentStart: vi.fn(async () => ({ dispose: () => {} })),
        onAfterToolResult: vi.fn(async () => ({ dispose: () => {} })),
        onPiEvent: vi.fn(async () => ({ dispose: () => {} })),
      },
      // ── storage ──────────────────────────────────────────
      storage: {
        global: {
          get: vi.fn(async () => undefined),
          set: vi.fn(async () => {}),
          delete: vi.fn(async () => {}),
          keys: vi.fn(async () => []),
        },
        workspace: {
          get: vi.fn(async () => undefined),
          set: vi.fn(async () => {}),
          delete: vi.fn(async () => {}),
          keys: vi.fn(async () => []),
        },
      },
      // ── notify ────────────────────────────────────────────
      notify: {
        info: vi.fn(async (_msg: string) => {}),
        warning: vi.fn(async () => {}),
        error: vi.fn(async () => {}),
      },
      // ── sessions ─────────────────────────────────────────
      sessions: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => undefined),
        getActive: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => {}),
        onDidCreateSession: vi.fn(() => ({ dispose: () => {} })),
        onDidDestroySession: vi.fn(() => ({ dispose: () => {} })),
      },
      // ── events ────────────────────────────────────────────
      events: {
        on: vi.fn(() => ({ dispose: () => {} })),
        emit: vi.fn(),
      },
      // ── config ────────────────────────────────────────────
      config: {
        get: vi.fn(async () => undefined),
        getAll: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
      // ── sessionData ───────────────────────────────────────
      sessionData: {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
        keys: vi.fn(async () => []),
      },
      // ── ui ────────────────────────────────────────────────
      ui: {
        showSelect: vi.fn(async () => undefined),
        showConfirm: vi.fn(async () => false),
        showInput: vi.fn(async () => undefined),
        notify: vi.fn(async (level: string, message: string) => {
          notifications.push({ level, message })
        }),
        updateStatusBarItem: vi.fn(async () => {}),
      },
      // ── agent ─────────────────────────────────────────────
      agent: {
        setModel: vi.fn(async () => ''),
        getModel: vi.fn(async () => ''),
        getThinkingLevel: vi.fn(async () => 'high'),
        setThinkingLevel: vi.fn(async () => ''),
        getActiveTools: vi.fn(async () => []),
      },
      // ── workspace ─────────────────────────────────────────
      workspace: {
        rootPath: '/tmp/test-workspace',
        name: 'test-workspace',
        findFiles: vi.fn(async () => ['file1.ts', 'file2.ts']),
      },
      // ── commands / views（W1 类型层落地，mock 占位）───────
      commands: {
        register: vi.fn(async () => ({ dispose: () => {} })),
        unregister: vi.fn(async () => {}),
      },
      views: {
        update: vi.fn(async () => {}),
        listMountPoints: vi.fn(async () => []),
      },
    },
    subscriptions: [],
  }

  return { context, registeredTools, registeredHooks, notifications }
}

// ── Tests ────────────────────────────────────────────────────────

describe('Demo Plugin E2E', () => {
  // ── TC-D01: package.json manifest is valid ──────────────────
  it('TC-D01: package.json manifest is correctly structured', async () => {
    const raw = await readFile(join(DEMO_DIR, 'package.json'), 'utf-8')
    const pkg: TaijiPackageJson = JSON.parse(raw)

    expect(pkg.name).toBe('demo-plugin')
    expect(pkg.version).toBeTruthy()  // version is bumped by release script
    expect(pkg.taijiPlugin).toBeDefined()
    expect(pkg.taijiPlugin.manifestVersion).toBe(1)
    expect(pkg.taijiPlugin.activationEvents).toContain('onStartupFinished')
    expect(pkg.taijiPlugin.trustLevel).toBe('sandbox')

    // contributes
    const contributes = pkg.taijiPlugin.contributes
    expect(contributes).toBeDefined()
    expect(contributes!.tools).toHaveLength(1)
    expect(contributes!.tools![0].name).toBe('demo_search')
    expect(contributes!.hooks).toContain('onBeforeSendMessage')

    // permissions
    expect(pkg.taijiPlugin.permissions).toContain('workspace:file:search')
  })

  // ── TC-D02: PluginModule type is correct ────────────────────
  it('TC-D02: PluginModule has activate and deactivate', async () => {
    // Dynamic import to get the plugin module
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    expect(typeof plugin.activate).toBe('function')
    expect(typeof plugin.deactivate).toBe('function')
  })

  // ── TC-D03: activate registers tools ────────────────────────
  it('TC-D03: activate registers the demo_search tool', async () => {
    const { context, registeredTools } = createMockContext()
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    await plugin.activate(context)

    expect(registeredTools).toHaveLength(1)
    expect(registeredTools[0].name).toBe('demo_search')
    expect(registeredTools[0].description).toContain('Search for files')
    expect(context.api.tools.register).toHaveBeenCalledOnce()
  })

  // ── TC-D04: activate registers hooks ────────────────────────
  it('TC-D04: activate registers onBeforeSendMessage hook', async () => {
    const { context, registeredHooks } = createMockContext()
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    await plugin.activate(context)

    expect(registeredHooks).toContain('onBeforeSendMessage')
    expect(context.api.hooks.onBeforeSendMessage).toHaveBeenCalledOnce()
  })

  // ── TC-D05: activate sends UI notification ──────────────────
  it('TC-D05: activate sends info notification', async () => {
    const { context, notifications } = createMockContext()
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    await plugin.activate(context)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].level).toBe('info')
    expect(notifications[0].message).toContain('Demo plugin activated')
  })

  // ── TC-D06: hook interceptor transforms !important ──────────
  it('TC-D06: hook interceptor transforms !important to IMPORTANT', async () => {
    const { context } = createMockContext()
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    await plugin.activate(context)

    // Retrieve the handler that was registered
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers = (context as any)._hookHandlers as Array<(ctx: HookContext) => Promise<unknown>>
    expect(handlers).toHaveLength(1)

    const handler = handlers[0]
    const hookCtx: HookContext = {
      pluginId: 'demo-plugin',
      hookType: 'onBeforeSendMessage',
      data: { content: 'please review this !important change' },
      timestamp: Date.now(),
    }

    const result = await handler(hookCtx) as { proceed: boolean; modifiedData?: unknown }

    expect(result.proceed).toBe(true)
    const modified = result.modifiedData as { content: string }
    expect(modified.content).toBe('please review this IMPORTANT change')
  })

  // ── TC-D07: hook passes through normal content ──────────────
  it('TC-D07: hook passes through normal content unchanged', async () => {
    const { context } = createMockContext()
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    await plugin.activate(context)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers = (context as any)._hookHandlers as Array<(ctx: HookContext) => Promise<unknown>>
    const handler = handlers[0]

    const hookCtx: HookContext = {
      pluginId: 'demo-plugin',
      hookType: 'onBeforeSendMessage',
      data: { content: 'normal message without markers' },
      timestamp: Date.now(),
    }

    const result = await handler(hookCtx) as { proceed: boolean; modifiedData?: unknown }

    expect(result.proceed).toBe(true)
    expect(result.modifiedData).toBeUndefined()
  })

  // ── TC-D08: deactivate is callable ──────────────────────────
  it('TC-D08: deactivate runs without error', async () => {
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    expect(() => plugin.deactivate!()).not.toThrow()
  })
})
