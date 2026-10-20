#!/usr/bin/env node
/**
 * vitest 启动 wrapper（runtime test script 入口）。
 *
 * 为什么存在：pnpm 10.x 会把 `pnpm test -- <filter>` 的 `--` 一并转发给脚本，
 * 而 vitest 把 `--` 后的参数当透传、不作文件过滤器——`pnpm -C packages/runtime
 * test -- archive` 会静默跑全量（669 文件、4 分钟）而非 archive 过滤子集，
 * 满并行全量还会触发既有竞态（双 spawn + jiti 冷编译形态，见 vitest.config.ts
 * 头注释），把与过滤目标无关的文件红灯带进退出码。impl-plan 各单元 testCommand
 * （`test -- archive` / `test -- canvas` 等）的书写意图全部是过滤跑。
 *
 * 行为：剥掉 pnpm 转发的前导 `--` 后透传 vitest；无参（`pnpm test` 全量）与
 * 其他形态原样透传，行为零变化。
 */
import { spawnSync } from 'node:child_process'

const raw = process.argv.slice(2)
const args = raw[0] === '--' ? raw.slice(1) : raw

const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...args], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
