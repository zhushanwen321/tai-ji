/**
 * check-ci-vitest-targets.mjs 守卫逻辑单测（G2：CI vitest 目标非空）。
 *
 * 误放行会让「CI 步骤空跑」回归（taste-lint 事故形态：目标被根 config exclude，
 * vitest run 恒 No test files found）——五条行为机器锁定：
 *   R1 run 值提取（单行 / 块形态 / 缩进边界）
 *   R2 命令分类（direct 三前缀 / script 引用三形态 / unrecognized fail loud / 无关放行）
 *   R3 GitHub 模板剥离（--shard=${{ … }}/${{ … }} 含空格，必须先剥再 token 化）
 *   R4 干跑重写（run→list --filesOnly、目标与 --config 保留、其余 flag 丢弃）
 *   R5 script 展开分级（assert / 递归 skip / 无 vitest ignore）
 */
import { describe, it, expect } from 'vitest'
import {
  stripGithubTemplates,
  extractRunValues,
  parseWorkspaceGlobs,
  classifyCommand,
  pickDryRunArgs,
  buildDirectDryRun,
  buildScriptDryRun,
} from '../check-ci-vitest-targets.mjs'

// ---------- R1 run 值提取 ----------

describe('R1 extractRunValues', () => {
  it('单行 run: 与块 run: | 均提取，行号正确', () => {
    const yaml = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - name: A',
      '        run: pnpm run foo',
      '      - name: B',
      '        run: |',
      '          pnpm exec vitest run a.test.mjs',
      '          node scripts/x.mjs',
    ].join('\n')
    const runs = extractRunValues(yaml)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual({ line: 5, cmd: 'pnpm run foo' })
    expect(runs[1]).toEqual({ line: 7, cmd: 'pnpm exec vitest run a.test.mjs && node scripts/x.mjs' })
  })

  it('缩进降级终止块收集，空行跳过', () => {
    const yaml = [
      '      - run: |',
      '          cmd-a',
      '',
      '          cmd-b',
      '      - run: cmd-c',
    ].join('\n')
    const runs = extractRunValues(yaml)
    expect(runs).toEqual([
      { line: 1, cmd: 'cmd-a && cmd-b' },
      { line: 5, cmd: 'cmd-c' },
    ])
  })
})

// ---------- R2 命令分类 ----------

describe('R2 classifyCommand', () => {
  it('direct 三前缀识别（pnpm exec / pnpm --filter exec / npx）', () => {
    expect(classifyCommand('pnpm exec vitest run taste-lint')).toMatchObject({
      kind: 'direct', runner: 'pnpm exec', filterPkg: null,
    })
    expect(classifyCommand('pnpm --filter @taiji/runtime exec vitest run --shard=1/2')).toMatchObject({
      kind: 'direct', runner: 'pnpm --filter @taiji/runtime exec', filterPkg: '@taiji/runtime',
    })
    expect(classifyCommand('npx vitest run a.test.mjs --silent')).toMatchObject({
      kind: 'direct', runner: 'npx', filterPkg: null,
    })
  })

  it('script 引用三形态识别（pnpm run X / pnpm --filter X run Y / 裸 pnpm X）', () => {
    expect(classifyCommand('pnpm run test:taste-lint')).toEqual({ kind: 'script', filterPkg: null, scriptName: 'test:taste-lint', args: null })
    expect(classifyCommand('pnpm --filter @taiji/electron run test:main')).toEqual({ kind: 'script', filterPkg: '@taiji/electron', scriptName: 'test:main', args: null })
    expect(classifyCommand('pnpm extensions:test')).toEqual({ kind: 'script', filterPkg: null, scriptName: 'extensions:test', args: null })
  })

  it('带参引用提取 args（install 等内建的放行由主流程经 scripts 表 miss 裁决）', () => {
    expect(classifyCommand('pnpm install --frozen-lockfile')).toEqual({ kind: 'script', filterPkg: null, scriptName: 'install', args: '--frozen-lockfile' })
    expect(classifyCommand('pnpm run lint').args).toBeNull()
  })

  it('vitest run 出现但形态不认识 → unrecognized（拒绝静默放行）', () => {
    expect(classifyCommand('bash -c "vitest run x"').kind).toBe('unrecognized')
  })

  it('非 pnpm 命令 → null（不进守卫面）', () => {
    expect(classifyCommand('node scripts/check-publish-surface.mjs')).toBeNull()
  })
})

// ---------- R3 GitHub 模板剥离 ----------

describe('R3 stripGithubTemplates', () => {
  it('shard 双模板剥净，模板内空格不产生假 token', () => {
    const stripped = stripGithubTemplates('--shard=${{ matrix.shard-index }}/${{ matrix.shard-total }}')
    expect(stripped).toBe('--shard=/')
    expect(stripped.split(/\s+/)).toHaveLength(1)
  })
})

// ---------- R4 干跑重写 ----------

describe('R4 pickDryRunArgs / buildDirectDryRun', () => {
  it('位置目标与 --config 保留，run 专属 flag 丢弃', () => {
    expect(pickDryRunArgs(' --config x/y.config.ts taste-lint')).toEqual({
      targets: ['taste-lint'],
      flags: ['--config x/y.config.ts'],
    })
    expect(pickDryRunArgs(' --shard=// a.test.mjs b.test.mjs --silent')).toEqual({
      targets: ['a.test.mjs', 'b.test.mjs'],
      flags: [],
    })
  })

  it('direct → vitest list --filesOnly，目标含被 exclude 目录时由干跑实证红', () => {
    const dry = buildDirectDryRun({
      runner: 'pnpm exec',
      rest: ' --config taste-lint/vitest.config.ts taste-lint',
    })
    expect(dry).toBe('pnpm exec vitest list --filesOnly --config taste-lint/vitest.config.ts taste-lint')
  })

  it('shard 模板形态重写后不含 list 无关 flag', () => {
    const dry = buildDirectDryRun({
      runner: 'pnpm --filter @taiji/runtime exec',
      rest: ' --shard=//',
    })
    expect(dry).toBe('pnpm --filter @taiji/runtime exec vitest list --filesOnly')
  })
})

// ---------- R5 script 展开分级 ----------

describe('R5 buildScriptDryRun', () => {
  it('含 vitest run 且非递归 → assert（vitest run 替换为 list --filesOnly）', () => {
    expect(buildScriptDryRun('cd main && vitest run')).toEqual({
      action: 'assert', cmd: 'cd main && vitest list --filesOnly',
    })
    expect(buildScriptDryRun('pnpm exec vitest run --config taste-lint/vitest.config.ts taste-lint')).toEqual({
      action: 'assert', cmd: 'pnpm exec vitest list --filesOnly --config taste-lint/vitest.config.ts taste-lint',
    })
  })

  it('pnpm exec 不算二次转发（可整条重写直跑）', () => {
    const outcome = buildScriptDryRun('pnpm exec vitest run scripts/__tests__/x.test.mjs')
    expect(outcome.action).toBe('assert')
  })

  it('pnpm -r 递归 → skip（extensions:test 形态）', () => {
    expect(buildScriptDryRun("pnpm -r --filter '@zhushanwen/pi-*' test").action).toBe('skip')
  })

  it('二次 run 转发 → skip；无 vitest 且非递归 → ignore', () => {
    expect(buildScriptDryRun('pnpm --filter @taiji/frontend run test && pnpm --filter @taiji/runtime run test').action).toBe('skip')
    expect(buildScriptDryRun('eslint . --max-warnings 0')).toEqual({ action: 'ignore' })
  })
})

// ---------- workspace globs 解析 ----------

describe('parseWorkspaceGlobs', () => {
  it('packages 键下的一级 globs 收入，后续顶层键终止', () => {
    expect(parseWorkspaceGlobs("packages:\n  - 'packages/*'\n  - 'apps/*'\n\nonlyBuiltDependencies:\n  - esbuild\n")).toEqual([
      'packages/*', 'apps/*',
    ])
  })
})
