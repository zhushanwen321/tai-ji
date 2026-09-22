/**
 * 单实例互斥守卫单测（probe 判定矩阵 + register 原子写）。
 *
 * probe 侧注入 fake isPortReachable 隔离网络；register/读文件走 mkdtemp 真目录
 * （防线路线：tmp 自建自删）。核心断言面：活实例拒绝（双来源）、stale 放行接管、
 * 损坏文件不阻塞、同端口去重、登记文件内容与权限。
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeSingleInstance, registerRuntimeInstance, RUNTIME_INSTANCE_FILE, type InstanceGuardDeps } from '../../infra/single-instance-guard.js'

/** 按端口可控的探活 fake：reachablePorts 集合外的端口一律不可达。 */
function fakeProbe(reachablePorts: number[]): InstanceGuardDeps {
  return { isPortReachable: async (port) => reachablePorts.includes(port) }
}

/** 每用例独立 tmp 数据目录（用后删除）。 */
async function withTmpDataDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'taiji-single-instance-guard-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

describe('probeSingleInstance', () => {
  it('无任何标记文件 → 放行（blocked=false, 无 holder）', async () => {
    await withTmpDataDir(async (dir) => {
      const result = await probeSingleInstance(dir, fakeProbe([3210]))
      expect(result.blocked).toBe(false)
      expect(result.holder).toBeUndefined()
    })
  })

  it('runtime-instance.json 指向活端口 → 拒绝并携带 pid 与来源', async () => {
    await withTmpDataDir(async (dir) => {
      await writeFile(join(dir, RUNTIME_INSTANCE_FILE), JSON.stringify({ pid: 4242, port: 3370, startedAt: '2026-09-22T00:00:00.000Z' }))
      const result = await probeSingleInstance(dir, fakeProbe([3370]))
      expect(result.blocked).toBe(true)
      expect(result.holder).toEqual({ port: 3370, pid: 4242, source: 'runtime-instance.json' })
    })
  })

  it('instance 端口已死（stale 残留）→ 放行接管', async () => {
    await withTmpDataDir(async (dir) => {
      await writeFile(join(dir, RUNTIME_INSTANCE_FILE), JSON.stringify({ pid: 1, port: 3370, startedAt: '2026-09-22T00:00:00.000Z' }))
      const result = await probeSingleInstance(dir, fakeProbe([]))
      expect(result.blocked).toBe(false)
    })
  })

  it('instance 缺失、supervisor runtime.port 指向活端口 → 拒绝（兼容未写本文件的旧版实例）', async () => {
    await withTmpDataDir(async (dir) => {
      await writeFile(join(dir, 'runtime.port'), '3210')
      const result = await probeSingleInstance(dir, fakeProbe([3210]))
      expect(result.blocked).toBe(true)
      expect(result.holder).toEqual({ port: 3210, source: 'runtime.port' })
    })
  })

  it('instance 端口已死但 runtime.port 活 → 仍拒绝（任一候选可达即活实例在场）', async () => {
    await withTmpDataDir(async (dir) => {
      await writeFile(join(dir, RUNTIME_INSTANCE_FILE), JSON.stringify({ pid: 9, port: 3370, startedAt: '2026-09-22T00:00:00.000Z' }))
      await writeFile(join(dir, 'runtime.port'), '3210')
      const result = await probeSingleInstance(dir, fakeProbe([3210]))
      expect(result.blocked).toBe(true)
      expect(result.holder).toEqual({ port: 3210, source: 'runtime.port' })
    })
  })

  it('两文件指向同一活端口 → 去重且来源保持 instance 优先（含 pid）', async () => {
    await withTmpDataDir(async (dir) => {
      await writeFile(join(dir, RUNTIME_INSTANCE_FILE), JSON.stringify({ pid: 4242, port: 3210, startedAt: '2026-09-22T00:00:00.000Z' }))
      await writeFile(join(dir, 'runtime.port'), '3210')
      const result = await probeSingleInstance(dir, fakeProbe([3210]))
      expect(result.holder).toEqual({ port: 3210, pid: 4242, source: 'runtime-instance.json' })
    })
  })

  it('损坏 JSON / 非法端口值 → 忽略该候选不阻塞启动', async () => {
    await withTmpDataDir(async (dir) => {
      await writeFile(join(dir, RUNTIME_INSTANCE_FILE), '{not-json')
      await writeFile(join(dir, 'runtime.port'), 'not-a-port')
      const result = await probeSingleInstance(dir, fakeProbe([]))
      expect(result.blocked).toBe(false)
    })
  })

  it('默认探活实现：真 TCP 环回（活端口可达 / 闲置端口不可达）', async () => {
    await withTmpDataDir(async (dir) => {
      const server = await import('node:net').then((net) =>
        new Promise<import('node:net').Server>((resolve) => {
          const s = net.createServer(() => {})
          s.listen(0, '127.0.0.1', () => resolve(s))
        }),
      )
      try {
        const livePort = (server.address() as { port: number }).port
        // 无标记文件 → 默认探活不触发直接放行
        const noMarker = await probeSingleInstance(dir)
        // 写标记后验默认探活的真 TCP 可达路径
        await writeFile(join(dir, 'runtime.port'), String(livePort))
        const blocked = await probeSingleInstance(dir)
        expect(noMarker.blocked).toBe(false)
        expect(blocked.blocked).toBe(true)
        expect(blocked.holder?.port).toBe(livePort)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  })
})

describe('registerRuntimeInstance', () => {
  it('listen 成功后原子写登记文件：pid/port/startedAt 齐全且可被 probe 读回', async () => {
    await withTmpDataDir(async (dir) => {
      registerRuntimeInstance(dir, 3370)
      const raw = JSON.parse(await readFile(join(dir, RUNTIME_INSTANCE_FILE), 'utf-8')) as { pid: number; port: number; startedAt: string }
      expect(raw.pid).toBe(process.pid)
      expect(raw.port).toBe(3370)
      expect(typeof raw.startedAt).toBe('string')
      // 探活 fake 标记该端口为活 → register 后的文件足以让下一轮启动拒绝
      const result = await probeSingleInstance(dir, fakeProbe([3370]))
      expect(result.blocked).toBe(true)
      expect(result.holder?.pid).toBe(process.pid)
    })
  })

  it('重复 register 覆盖旧登记（重启换端口场景）', async () => {
    await withTmpDataDir(async (dir) => {
      registerRuntimeInstance(dir, 3370)
      registerRuntimeInstance(dir, 3380)
      const raw = JSON.parse(await readFile(join(dir, RUNTIME_INSTANCE_FILE), 'utf-8')) as { port: number }
      expect(raw.port).toBe(3380)
    })
  })
})
