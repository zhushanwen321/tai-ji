// src/argv-mirror.ts
//
// 从主进程 argv 解析可镜像给子进程的 flag（W7 迁 pi 包，core engines/pi/
// argv-mirror.ts 逐字等价副本——纯函数，无 core 依赖）。

/**
 * 镜像 flag 集合：从主进程 argv 解析出的可透传给子进程的 flag。
 * 面向 buildSpawnArgs 的入参形态（解析后）。undefined 字段语义与解析为空一致。
 */
export interface MirrorFlags {
  noExtensions: boolean;
  approve: boolean;
  extensionPaths: string[];
  noContextFiles: boolean;
}

/**
 * 有值 flag 的解析规则表：成员是「后跟一个值」的 flag 名（含长短形式）。
 * 用于 parseMirrorFlagArgs 跳过其他 flag 的值时不误吃。
 */
const VALUED_FLAGS = new Set<string>([
  "--extension", "-e",
  "--skill",
  "--model", "--system-prompt", "--append-system-prompt",
  "--tools", "-t", "--exclude-tools", "-xt",
  "--fork", "--session-dir", "--mode",
  "--thinking", "--models",
]);

/** MirrorFlags 的布尔字段名（extensionPaths 数组字段单列，不进此表）。 */
type MirrorBooleanKey = "noExtensions" | "approve" | "noContextFiles";

/**
 * 布尔镜像 flag 表：token（长/短形式）→ MirrorFlags 布尔字段。
 * 用 Map 而非对象字面量查表——对象查表对 "__proto__"/"constructor" 等 token
 * 会命中原型链返回非 undefined，Map.get 无此陷阱。
 */
const BOOLEAN_FLAGS = new Map<string, MirrorBooleanKey>([
  ["--no-extensions", "noExtensions"],
  ["-ne", "noExtensions"],
  ["--approve", "approve"],
  ["-a", "approve"],
  ["--no-context-files", "noContextFiles"],
  ["-nc", "noContextFiles"],
]);

/** argv 中 flag 的起始索引：argv[0]=runtime, argv[1]=binary 路径。 */
const ARGV_FLAG_START = 2;

// [perf] 进程内 process.argv 引用恒定，解析结果按 argv 引用相等 memo。
// 测试传新数组引用不命中。
let memoArgv: readonly string[] | undefined;
let memoResult: MirrorFlags | undefined;

export function mirrorMainProcessFlags(argv: readonly string[]): MirrorFlags {
  if (memoResult !== undefined && memoArgv === argv) return memoResult;
  const result = parseMirrorFlagArgs(
    argv.length > ARGV_FLAG_START ? argv.slice(ARGV_FLAG_START) : [],
  );
  memoArgv = argv;
  memoResult = result;
  return result;
}

/** 纯解析：扫描 flag 区段（argv[2:]）构造 MirrorFlags，不做 memo。 */
function parseMirrorFlagArgs(flagArgs: readonly string[]): MirrorFlags {
  const flags: Record<MirrorBooleanKey, boolean> = {
    noExtensions: false,
    approve: false,
    noContextFiles: false,
  };
  const extensionPaths: string[] = [];

  for (let i = 0; i < flagArgs.length; i++) {
    const tok = flagArgs[i];
    const booleanKey = BOOLEAN_FLAGS.get(tok);
    if (booleanKey !== undefined) {
      flags[booleanKey] = true;
      continue;
    }
    // 等号形式 --extension=path / -e=path
    const eqMatch = /^(--extension|-e)=(.*)$/.exec(tok);
    if (eqMatch) {
      const val = eqMatch[2];
      if (val) extensionPaths.push(val);
      continue;
    }
    // 空格形式 --extension <path> / -e <path>：值在下一个 token
    // [MF-7a] flag 判定收窄为 startsWith("--")：单 - 开头的合法路径不误判为 flag。
    if (tok === "--extension" || tok === "-e") {
      const next = flagArgs[i + 1];
      if (next !== undefined && !next.startsWith("--") && next.length > 0) {
        extensionPaths.push(next);
        i++; // 跳过值
      }
      continue;
    }
    // 其他有值 flag：跳过其值，避免误吃（如 --skill /a 的 /a）
    if (VALUED_FLAGS.has(tok)) {
      i++;
      continue;
    }
    // 其他情况（未知 flag、--flag=val 形式、positional）忽略
  }

  return {
    noExtensions: flags.noExtensions,
    approve: flags.approve,
    extensionPaths,
    noContextFiles: flags.noContextFiles,
  };
}
