'use strict'

/**
 * plugin-fs-guard.cjs —— fs.read-user-data 的路径检查与只读导出子集代理
 * （provider-plugin-access D3）
 *
 * 两条加载通道的只读执法共用本文件的名单常量与路径检查，消费方各取所需：
 *   - plugin-esm-loader.cjs（fork 子进程，--import 注入）：**Node 的 customization
 *     hooks（resolve/load）运行在专用 hooks 线程**——其 globalThis 与主线程不同
 *     实例，实测（2026-10-24 探针）load hook 侧经 globalThis/process 向生成的代理
 *     模块传递代理对象全部不可见。因此 ESM 通道取「代理模块的 ESM 源码模板」：
 *     load hook 返回 format:'module' 的自包含源码，在**主线程**求值，其中
 *     `import realFs from 'node:fs'` 的 parentURL 是 sentinel URL（非 file://）
 *     → loader 自身放行 → 原生 fs 经 ESM 通道到手（initSandbox 的 CJS
 *     _resolveFilename patch 天然不覆盖 ESM import）。
 *   - plugin-bootstrap.ts initSandbox（同一 fork 子进程主线程）：CJS require 通道
 *     取 buildProxyObject 直接构建的代理对象（Module._load patch 返回），与 ESM
 *     模板同语义。行为代码两份是真实运行环境差异（模板源码求值 vs 主线程直接
 *     持有对象），名单常量与本文件单一事实源共用，键集一致性由 in-process 测试
 *     断言（两份行为代码名单漂移的机器防线）。
 *
 * D3 的两个独立机制在本文件各承载其一（不互相顶替）：
 *   - 路径边界：configure() 按 readPaths（家目录相对路径）在 hooks 线程归一为
 *     绝对路径白名单（realpath 防符号链接绕过，含「声明内 symlink → 声明外」；
 *     目标不存在时逐级取最近存在祖先、余下段参与匹配，保留 ENOENT 语义），随
 *     模板内联为字面量，每次 fs 调用校验。
 *   - 只读性：读与元数据 API 显式白名单放行，写改 API 显式拒绝（错误码
 *     PERMISSION_DENIED，可诊断）；open / promises.open 只放行读 flags（'r' /
 *     'rs' / O_RDONLY），promises.open 返回的 FileHandle 经 Proxy 包装拒绝写方法。
 *
 * 模板 = 代理构建逻辑的单一事实源：in-process 测试做结构断言（import 面 / 内联
 * 白名单 / named export 与名单一致），行为面由真实 fork 的 P-perm fixture 覆盖。
 */

const REAL_FS = require('node:fs')
const NODE_PATH = require('node:path')
const NODE_OS = require('node:os')

/** 放行清单 env 键（loader 解码与宿主侧 plugin-fs-guard.ts 编码共用同一字面量） */
const ENV_ALLOWED_MODULES_KEY = 'TAIJI_PLUGIN_ALLOWED_MODULES'
const ENV_READ_PATHS_KEY = 'TAIJI_PLUGIN_READ_PATHS'

// ── 路径边界（readPaths，hooks 线程归一）─────────────────────────

/** 归一后的 readPaths 白名单：[{ real, suffix, broken }] */
let allowedEntries = []

/**
 * realpath 归一，目标不存在时逐级向上取最近存在祖先（suffix 承接余下段）。
 * ENOTDIR（路径中文件段被当目录用，如 readPaths 指向文件后拼子路径）同 ENOENT
 * 处理——向上到该文件段自身 realpath 成功。broken = 祖先也解析失败（目录异常），
 * 调用方 fail-closed。
 */
function resolveForCheck(absolutePath) {
  let current = NODE_PATH.resolve(absolutePath)
  const suffix = []
  for (;;) {
    try {
      return { real: REAL_FS.realpathSync(current), suffix }
    } catch (e) {
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return { real: current, suffix, broken: true }
      const parent = NODE_PATH.dirname(current)
      if (parent === current) return { real: current, suffix, broken: true }
      suffix.unshift(NODE_PATH.basename(current))
      current = parent
    }
  }
}

/** 白名单展开为「real + 余下段」的绝对路径可比字符串 */
function entryKey(entry) {
  return NODE_PATH.join(entry.real, ...entry.suffix)
}

/**
 * 配置 readPaths 白名单（loader initialize 时调用一次）。
 * readPaths 语义 = 家目录相对路径（manifest taijiPlugin.readPaths，D3）；homedir
 * 在本进程内动态推导（fork env 的 HOME，测试可注入隔离）。归一为绝对路径后随
 * 代理源码模板内联——模板运行侧无需 homedir。
 */
function configure(options) {
  const home = NODE_OS.homedir()
  const list = options && Array.isArray(options.readPaths) ? options.readPaths : []
  allowedEntries = []
  for (const rel of list) {
    if (typeof rel !== 'string' || rel.trim() === '') continue
    allowedEntries.push(resolveForCheck(NODE_PATH.resolve(home, rel)))
  }
}

/** 白名单的绝对路径形态（模板内联用；broken 条目剔除——fail-closed） */
function inlineReadBases() {
  return allowedEntries.filter((entry) => !entry.broken).map(entryKey)
}

// ── 只读导出名单（模板与导出面共用）──────────────────────────────

/** fs（同步/回调/流面）读与元数据 API（第一参为路径） */
const READ_PATH_APIS = [
  'readFile',
  'readFileSync',
  'readdir',
  'readdirSync',
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'access',
  'accessSync',
  'realpath',
  'realpathSync',
  'readlink',
  'readlinkSync',
  'existsSync',
  'opendir',
  'opendirSync',
]

/** fs 面 fd 族读 API（无路径入参；fd 只能来自受 flags 检查的 open） */
const FD_READ_APIS = ['read', 'readSync', 'readv', 'readvSync', 'fstat', 'fstatSync', 'close', 'closeSync']

/** fs 面写改 API 显式拒绝名单（错误码 PERMISSION_DENIED 可诊断；fail-closed） */
const DENIED_APIS = [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'unlink',
  'unlinkSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'chmod',
  'chmodSync',
  'fchmod',
  'fchmodSync',
  'chown',
  'chownSync',
  'fchown',
  'fchownSync',
  'lchown',
  'lchownSync',
  'truncate',
  'truncateSync',
  'ftruncate',
  'ftruncateSync',
  'utimes',
  'utimesSync',
  'futimes',
  'futimesSync',
  'lutimes',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'write',
  'writeSync',
  'writev',
  'writevSync',
  'fsync',
  'fsyncSync',
  'fdatasync',
  'fdatasyncSync',
  'createWriteStream',
  'openAsBlob',
  'watch',
  'watchFile',
  'unwatchFile',
]

/** fs/promises 面读 API（第一参为路径） */
const PROMISES_READ_APIS = ['readFile', 'readdir', 'stat', 'lstat', 'access', 'realpath', 'readlink']

/** fs/promises 面写改 API 显式拒绝名单 */
const PROMISES_DENIED_APIS = [
  'writeFile',
  'appendFile',
  'unlink',
  'rm',
  'rmdir',
  'mkdir',
  'mkdtemp',
  'rename',
  'copyFile',
  'cp',
  'chmod',
  'lchmod',
  'chown',
  'lchown',
  'truncate',
  'utimes',
  'lutimes',
  'symlink',
  'link',
  'watch',
  'openAsBlob',
]

/** FileHandle 写方法拒绝名单（promises.open 读 flags 打开后仍拒绝经句柄写入） */
const HANDLE_DENIED_METHODS = ['writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes', 'sync', 'datasync', 'write']

/** 代理模块 named export 名单（模板 export 行与名单常量一致性由测试断言） */
function proxyExportNames(target) {
  if (target === 'fs/promises') {
    return [...PROMISES_READ_APIS, 'open', 'opendir', ...PROMISES_DENIED_APIS]
  }
  return [...READ_PATH_APIS, 'createReadStream', 'open', 'openSync', ...FD_READ_APIS, ...DENIED_APIS, 'promises', 'constants', 'Stats', 'Dirent', 'Dir']
}

// ── 代理模块 ESM 源码模板（在主线程求值）─────────────────────────

/**
 * 生成 load hook 返回的自包含 ESM 源码（target = 'fs' | 'fs/promises'）。
 *
 * - `import realFs from 'node:fs'` 的 parentURL = sentinel URL（非 file://）→
 *   loader 自身放行，原生 fs 经 ESM 通道到手，不经 CJS _resolveFilename patch；
 * - readPaths 白名单以归一后的绝对路径字面量内联（READ_BASES）；
 * - named export 逐键显式声明（ESM 静态可分析，`import { readFile }` 直接可用）；
 * - fs 面同时内嵌 promises 命名空间构建段（m.promises = pm，同一 realFs.promises
 *   数据源），`fs.promises.readFile` 形态与 `import fs/promises` 同面放行。
 */
function buildProxyModuleSource(target) {
  const isPromises = target === 'fs/promises'
  const lines = [
    "import realFs from 'node:fs'",
    "import nodePath from 'node:path'",
    `const READ_BASES = ${JSON.stringify(inlineReadBases())}`,
    "const PERMISSION_DENIED = 'PERMISSION_DENIED'",
    '',
    'function sandboxError(message) {',
    '  const err = new Error(message)',
    '  err.code = PERMISSION_DENIED',
    '  return err',
    '}',
    '',
    '// ── 路径边界（readPaths 白名单已在宿主侧 realpath 归一）──────',
    '',
    '// 目标 realpath 归一；不存在时逐级取最近存在祖先（ENOENT 语义保留），',
    '// 余下段拼回后与白名单做前缀匹配（目录 readPath 覆盖子树）',
    'function resolveForCheck(absolutePath) {',
    '  let current = nodePath.resolve(absolutePath)',
    '  const suffix = []',
    '  for (;;) {',
    '    try {',
    '      return { real: realFs.realpathSync(current), suffix }',
    '    } catch (e) {',
    "      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return { real: current, suffix, broken: true }",
    '      const parent = nodePath.dirname(current)',
    '      if (parent === current) return { real: current, suffix, broken: true }',
    '      suffix.unshift(nodePath.basename(current))',
    '      current = parent',
    '    }',
    '  }',
    '}',
    '',
    'function isPathAllowed(targetPath) {',
    '  const target = resolveForCheck(targetPath)',
    '  if (target.broken) return false',
    '  const key = nodePath.join(target.real, ...target.suffix)',
    '  return READ_BASES.some((base) => key === base || key.startsWith(base + nodePath.sep))',
    '}',
    '',
    'function toPathString(target) {',
    "  if (typeof target === 'string') return target",
    '  return null',
    '}',
    '',
    'function assertAllowedPath(api, target) {',
    '  const p = toPathString(target)',
    "  if (p === null || !isPathAllowed(p)) {",
    "    throw sandboxError(`Sandbox: fs.${api}('${String(target)}') is outside declared readPaths`)",
    '  }',
    '}',
    '',
    '// ── 读 flags 限定（open 只放行只读打开）──────────────────────',
    '',
    'function isReadFlags(flags) {',
    "  if (flags === undefined || flags === null || flags === 'r' || flags === 'rs') return true",
    '  return flags === realFs.constants.O_RDONLY || flags === (realFs.constants.O_RDONLY | realFs.constants.O_SYNC)',
    '}',
    '',
    'function assertReadFlags(api, flags) {',
    "  if (!isReadFlags(flags)) {",
    "    throw sandboxError(`Sandbox: fs.${api} flags '${String(flags)}' is not a read flag (readonly subset)`)",
    '  }',
    '}',
    '',
  ]

  // fs 面先内嵌 promises 命名空间构建段（m.promises 数据源 = 同一 realFs.promises）
  if (!isPromises) {
    emitBuildLines(lines, 'pm', 'realFs.promises', true)
    lines.push('')
    emitBuildLines(lines, 'm', 'realFs', false)
    lines.push('m.promises = pm')
  } else {
    emitBuildLines(lines, 'm', 'realFs.promises', true)
  }

  lines.push('', 'export default m', '')
  for (const name of proxyExportNames(target)) {
    lines.push(`export const ${name} = m[${JSON.stringify(name)}]`)
  }
  lines.push('')
  return lines.join('\n')
}

/** 追加单面（fs 或 promises）代理对象的构建行（var = 目标变量名，ref = 真实 fs 表达式） */
function emitBuildLines(lines, varName, ref, isPromises) {
  lines.push(`const ${varName} = {}`)
  const readApis = isPromises ? PROMISES_READ_APIS : READ_PATH_APIS
  for (const api of readApis) {
    lines.push(
      `${varName}[${JSON.stringify(api)}] = function (...args) { assertAllowedPath(${JSON.stringify(api)}, args[0]); return ${ref}[${JSON.stringify(api)}].apply(${ref}, args) }`,
    )
  }

  if (isPromises) {
    // promises.open：读 flags 限定 + FileHandle 写方法 Proxy 拒绝
    lines.push(
      `${varName}.open = async function open(path, flags, ...rest) {`,
      "  assertAllowedPath('open', path)",
      "  assertReadFlags('open', flags)",
      '  const handle = await ' + ref + '.open(path, flags, ...rest)',
      '  return new Proxy(handle, {',
      '    get(targetHandle, prop) {',
      `      if (typeof prop === 'string' && ${JSON.stringify(HANDLE_DENIED_METHODS)}.includes(prop)) {`,
      '        return (...args) => Promise.reject(sandboxError(`Sandbox: FileHandle.${prop} is denied (readonly subset of fs.read-user-data)`))',
      '      }',
      '      const value = Reflect.get(targetHandle, prop, targetHandle)',
      "      return typeof value === 'function' ? value.bind(targetHandle) : value",
      '    },',
      '  })',
      '}',
      `${varName}.opendir = async function opendir(path, options) {`,
      "  assertAllowedPath('opendir', path)",
      "  if (options && typeof options === 'object' && 'flags' in options) assertReadFlags('opendir', options.flags)",
      '  return ' + ref + '.opendir(path, options)',
      '}',
    )
    for (const api of PROMISES_DENIED_APIS) {
      lines.push(
        `${varName}[${JSON.stringify(api)}] = () => Promise.reject(sandboxError(${JSON.stringify(`Sandbox: fs.promises.${api} is denied (readonly subset of fs.read-user-data)`)}))`,
      )
    }
    return
  }

  lines.push(
    `${varName}.createReadStream = function (...args) {`,
    "  assertAllowedPath('createReadStream', args[0])",
    '  const options = args[1]',
    "  if (options && typeof options === 'object' && 'flags' in options) assertReadFlags('createReadStream', options.flags)",
    `  return ${ref}.createReadStream.apply(${ref}, args)`,
    '}',
    `${varName}.open = function (...args) {`,
    "  assertAllowedPath('open', args[0])",
    "  assertReadFlags('open', args[1])",
    `  return ${ref}.open.apply(${ref}, args)`,
    '}',
    `${varName}.openSync = function (...args) {`,
    "  assertAllowedPath('openSync', args[0])",
    "  assertReadFlags('openSync', args[1])",
    `  return ${ref}.openSync.apply(${ref}, args)`,
    '}',
  )
  // fd 族读 API（fd 只能来自受 flags 检查的 open）
  for (const api of FD_READ_APIS) {
    lines.push(`${varName}[${JSON.stringify(api)}] = ${ref}[${JSON.stringify(api)}]`)
  }
  for (const api of DENIED_APIS) {
    lines.push(
      `${varName}[${JSON.stringify(api)}] = () => { throw sandboxError(${JSON.stringify(`Sandbox: fs.${api} is denied (readonly subset of fs.read-user-data)`)}) }`,
    )
  }
  // 类与常量透传（instanceof 语义）
  lines.push(`${varName}.constants = realFs.constants`)
  lines.push(`${varName}.Stats = realFs.Stats`)
  lines.push(`${varName}.Dirent = realFs.Dirent`)
  lines.push(`${varName}.Dir = realFs.Dir`)
}

// ── CJS 只读代理对象（plugin-bootstrap.ts initSandbox 的 Module._load patch 消费）──

/** 错误构造（与模板内联 sandboxError、loader/plugin-sandbox 的 errorWithCode 同形态：Error + code 字段） */
function sandboxError(message) {
  const err = new Error(message)
  err.code = 'PERMISSION_DENIED'
  return err
}

/**
 * 白名单判定（与模板 isPathAllowed 同语义）：目标 realpath 归一；不存在时逐级取
 * 最近存在祖先（ENOENT 语义保留），余下段拼回后与白名单前缀匹配（目录 readPath
 * 覆盖子树）。数据源 = inlineReadBases()（configure 后的运行时状态，每次调用
 * 现读）——调用方（initSandbox）必须先 configure 再产出代理对象。
 */
function isPathAllowed(targetPath) {
  const target = resolveForCheck(targetPath)
  if (target.broken) return false
  const key = entryKey(target)
  return inlineReadBases().some((base) => key === base || key.startsWith(base + NODE_PATH.sep))
}

/** 读 flags 判定（与模板 isReadFlags 同语义：'r' / 'rs' / O_RDONLY / O_RDONLY|O_SYNC） */
function isReadFlags(realFs, flags) {
  if (flags === undefined || flags === null || flags === 'r' || flags === 'rs') return true
  return flags === realFs.constants.O_RDONLY || flags === (realFs.constants.O_RDONLY | realFs.constants.O_SYNC)
}

/**
 * 构建 CJS 通道的只读代理对象（target = 'fs' | 'fs/promises'，realFs = 真实 fs 模块）。
 *
 * 行为语义与 buildProxyModuleSource 模板逐 API 对齐：READ_PATH_APIS /
 * PROMISES_READ_APIS 逐 API 路径边界检查（assertAllowedPath）；DENIED_APIS /
 * PROMISES_DENIED_APIS 逐 API 抛 PERMISSION_DENIED；open / openSync / promises.open
 * 只放读 flags，promises.open 返回的 FileHandle 经 Proxy 拒绝写方法
 * （HANDLE_DENIED_METHODS）；fs 面内嵌 promises 命名空间（同一 realFs.promises
 * 数据源）；constants / Stats / Dirent / Dir 透传原生引用（instanceof 语义）。
 * fd 族读 API 直接引用（fd 只能来自受 flags 检查的 open，同模板）。
 *
 * realFs 由调用方在 initSandbox patch 前捕获（顶部 import），保证是原生 fs——
 * 本函数绝不自行 require('fs')（patch 生效后该 require 会拿到代理对象自身）。
 */
function buildProxyObject(target, realFs) {
  const assertAllowedPath = function (api, value) {
    if (typeof value !== 'string' || !isPathAllowed(value)) {
      throw sandboxError(`Sandbox: fs.${api}('${String(value)}') is outside declared readPaths`)
    }
  }
  const assertReadFlags = function (api, flags) {
    if (!isReadFlags(realFs, flags)) {
      throw sandboxError(`Sandbox: fs.${api} flags '${String(flags)}' is not a read flag (readonly subset)`)
    }
  }

  /** 构建单面（fs 或 promises）代理对象（ref = 真实 fs / fs.promises 数据源） */
  const buildSurface = function (ref, isPromisesFace) {
    const surface = {}
    const readApis = isPromisesFace ? PROMISES_READ_APIS : READ_PATH_APIS
    for (const api of readApis) {
      surface[api] = function (...args) {
        assertAllowedPath(api, args[0])
        return ref[api].apply(ref, args)
      }
    }

    if (isPromisesFace) {
      // promises.open：读 flags 限定 + FileHandle 写方法 Proxy 拒绝（与模板同构）
      surface.open = async function open(path, flags, ...rest) {
        assertAllowedPath('open', path)
        assertReadFlags('open', flags)
        const handle = await ref.open(path, flags, ...rest)
        return new Proxy(handle, {
          get(targetHandle, prop) {
            if (typeof prop === 'string' && HANDLE_DENIED_METHODS.includes(prop)) {
              return () => Promise.reject(sandboxError(`Sandbox: FileHandle.${prop} is denied (readonly subset of fs.read-user-data)`))
            }
            const value = Reflect.get(targetHandle, prop, targetHandle)
            return typeof value === 'function' ? value.bind(targetHandle) : value
          },
        })
      }
      surface.opendir = async function opendir(path, options) {
        assertAllowedPath('opendir', path)
        if (options && typeof options === 'object' && 'flags' in options) assertReadFlags('opendir', options.flags)
        return ref.opendir(path, options)
      }
      for (const api of PROMISES_DENIED_APIS) {
        surface[api] = () => Promise.reject(sandboxError(`Sandbox: fs.promises.${api} is denied (readonly subset of fs.read-user-data)`))
      }
      return surface
    }

    surface.createReadStream = function (...args) {
      assertAllowedPath('createReadStream', args[0])
      const options = args[1]
      if (options && typeof options === 'object' && 'flags' in options) assertReadFlags('createReadStream', options.flags)
      return ref.createReadStream.apply(ref, args)
    }
    surface.open = function (...args) {
      assertAllowedPath('open', args[0])
      assertReadFlags('open', args[1])
      return ref.open.apply(ref, args)
    }
    surface.openSync = function (...args) {
      assertAllowedPath('openSync', args[0])
      assertReadFlags('openSync', args[1])
      return ref.openSync.apply(ref, args)
    }
    // fd 族读 API 直接引用（fd 只能来自受 flags 检查的 open）
    for (const api of FD_READ_APIS) {
      surface[api] = ref[api]
    }
    for (const api of DENIED_APIS) {
      surface[api] = () => {
        throw sandboxError(`Sandbox: fs.${api} is denied (readonly subset of fs.read-user-data)`)
      }
    }
    // 类与常量透传（instanceof 语义）
    surface.constants = realFs.constants
    surface.Stats = realFs.Stats
    surface.Dirent = realFs.Dirent
    surface.Dir = realFs.Dir
    return surface
  }

  if (target === 'fs/promises') return buildSurface(realFs.promises, true)

  const proxy = buildSurface(realFs, false)
  // fs 面内嵌 promises 命名空间（同一 realFs.promises 数据源，同模板 m.promises = pm）
  proxy.promises = buildSurface(realFs.promises, true)
  return proxy
}

/** 测试与 loader 侧共用：字符串数组形态 env 值的解码（非法/缺失 → 空数组 fail-closed） */
function parseStringArrayEnv(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

module.exports = {
  ENV_ALLOWED_MODULES_KEY,
  ENV_READ_PATHS_KEY,
  configure,
  inlineReadBases,
  proxyExportNames,
  buildProxyModuleSource,
  buildProxyObject,
  parseStringArrayEnv,
}
