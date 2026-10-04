#!/usr/bin/env python3
"""
runtime 子进程 env 出站契约静态守卫（约束 C-proc-09）

扫描 packages/runtime/src 与 apps/electron/main 的 *.ts 中所有 child-process 进程创建
调用点（spawn / execFile / execFileSync / fork / pty.spawn / new Worker /
utilityProcess.fork），要求每个调用点的实参区窗口内出现出站契约构建器
（buildOutboundChildEnv / composeChildEnvBase）的调用形态，否则按调用点逐一报错并
给出修复指引；间接组装（包装函数/外部注入/类型契约）与无 env 出站面的调用点在
本脚本 EXEMPT_CALLSITES 内逐条注明理由豁免。

设计依据与背景：docs/architecture/env-propagation-boundary.md
（§3.5 D2/D3 deny 清单最小起步 · §3.6 R1-R5 红线 · §5 U7 · AC8 演练场景）
约束登记：docs/constraints.json C-proc-09；与入站白名单（C-proc-07）正交共存——
入站白名单管「外部环境哪些准许进来」，本契约管「自身变量哪些允许跟随 spawn 出去」。

判定模型（逐调用点判定，2026-09-20 RT-8#9 事故后由文件级白名单改造）：
1. 对每个检测到的进程创建调用点，要求其窗口内出现契约构建器
   （buildOutboundChildEnv / composeChildEnvBase / buildEngineChildEnv 任一）的
   import 或调用形态。窗口 = 调用行向前回看 BACKWARD_LINES 行（覆盖
   「const env = builder(...) 预组装」「const childOpts = { env: builder(...) }」
   形态），向后到「调用行 + FORWARD_LINES 行」与「自调用括号起点按配对括号延伸的
   实参区终点（FORWARD_MAX_LINES 封顶）」的较大者（覆盖 env 内联在长实参区中段的
   形态，如 git-executor 的 execFile options）。旧「文件内出现构建器即整文件通过」
   的文件级白名单已废弃——relay-registry `ps` 与 terminal `dscl` 两点未传 env
   （继承全量父环境含 TAIJI_RUNTIME_TOKEN），却因同文件其他调用点 import/调用了
   构建器而整文件搭便车放行（审计 RT-8#9）；逐调用点判定消除该盲区。
   已知局限：相邻两调用点距离落在窗口内时，前一调用点的构建器调用可能让后一未武装
   调用点搭 12 行内的短程便车——窗口取值以覆盖全部真实武装形态的最小值为准，
   这是文本级守卫接受的残余风险（豁免指纹与逐条人工复核兜底）；
2. 调用点检测的激活条件不变：仅在文件确实 import 了对应符号时才激活对应模式
   （node:child_process 的 spawn/execFile/execFileSync/fork、node-pty 命名空间的
   .spawn()、node:worker_threads 的 new Worker()、electron 的 utilityProcess.fork），
   外加显式 port 注入形态 deps.spawn()/deps.execFile()——规避 `ctx.xxx.spawn(...)`
   这类业务方法调用的误报；
   promisify 产物名追踪：`const execFileAsync = promisify(execFile)` 的产物调用
   写作 execFileAsync(，不命中裸 API 名正则（形态逃逸，process-probe.ts 实例）。
   对非注释行上的 promisify 绑定提取「产物名 → 被包裹 API」，被包裹 API 确已
   import 时把产物名注册为等价调用点模式（label 沿用被包裹 API 名）；
3. 窗口内无构建器形态的调用点查 EXEMPT_CALLSITES（file 后缀 + 行内稳定子串指纹）：
   命中则放行并计入豁免统计。用行内容子串而非行号做指纹，代码平移不会让豁免
   静默漂移到新位置；豁免失效时宁可重新报警人工复核，不允许静默放行。
   豁免两类：无 env 出站面（只读探测 / kill / Worker 同进程线程），与间接组装
   （env 经本文件包装函数 / 跨包注入 / SDK 类型契约收口，豁免理由须指向组装点）。

退出码：0=通过；2=存在违规；1=脚本自身异常。
豁免/范围调整须同步 docs/architecture/env-propagation-boundary.md §3.6 R5 并过评审。
"""

import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------------------
# 扫描范围
# ---------------------------------------------------------------------------
SCAN_ROOTS = [
    "packages/runtime/src",
    "apps/electron/main",
    # [历史注记] W12 主时点扩展（impl-plan §2.12 / §7.1 拖尾清单第 4 项）仅加入 SDK 与
    # 两个引擎 CLI 包——出生即经 SDK 原语（buildEngineChildEnv / spawnEngineChild），
    # 无存量违规面；包未创建时 iter_ts_files 对缺目录 root 打 [WARN] 后 continue
    # （容错行为，勿改）。packages/subagent-core/src 条目已由 W11 收口批
    # （W12 拖尾子项④执行）加入——终态口径见下条注释。
    "packages/subagent-engine-sdk/src",
    "packages/zcode-subagent-cli",
    "packages/pi-subagent-cli",
    # [W11 收口 / W12 拖尾子项④，终态口径] engines/ 内建目录已删、壳侧裸 spawn 已消
    # （唯一 spawn 面 = EngineClient（buildEngineChildEnv）/ worktree git
    # （buildOutboundChildEnv）/ relay-env 探针（豁免通道兜底））——core/src 已入扫描；
    # 收口判据 = 「迁移期临时豁免清零」（engines/zcode 相关临时条目随目录删除消失），
    # 现存 6 条 core 侧永久类豁免（pid-file/reaper/pi-engine/session-runner×2/worker-host
    # 的只读探测/kill/Worker 场景，EXEMPT_CALLSITES 逐条附理由，语义合理非泄漏面）；
    # 豁免申请仍走既有 EXEMPT_CALLSITES 通道。
    "packages/subagent-core/src",
]

# 目录名成分或文件名后缀排除（测试文件不代表生产进程拓扑）
EXCLUDED_DIR_PARTS = {"__tests__", "test"}
EXCLUDED_FILE_SUFFIXES = (".test.ts", ".spec.ts", ".d.ts")

# 构建器符号（判定对象）：调用点窗口内出现以下任一符号的 import 或调用形态即视为
# 已武装。裸子串匹配（`b in source`）会让仅注释提及构建器的行静默放行，故必须用
# 形态化正则：import {...} 花括号内出现符号名，或紧跟 ( 的调用形态。
CONTRACT_BUILDER_SYMBOLS = (
    "buildOutboundChildEnv",
    "composeChildEnvBase",
    # W12：SDK 引擎 env 三层契约构建器（与 shared 版构建器并列的可接受符号——
    # F9：SDK 消费面不可依赖 shared，自持同语义构建器）
    "buildEngineChildEnv",
)
CONTRACT_BUILDER_USAGE_RE = re.compile(
    r"(?:import\s+(?:type\s+)?\{[^}]*\b(?:%s)\b[^}]*\}|\b(?:%s)\s*\()"
    % ("|".join(CONTRACT_BUILDER_SYMBOLS), "|".join(CONTRACT_BUILDER_SYMBOLS))
)

# ---------------------------------------------------------------------------
# 逐调用点判定窗口（取值依据 = 覆盖仓内全部真实武装形态的最小值，见文件头判定模型）
# ---------------------------------------------------------------------------
# 向后回看：覆盖「const env = builder(...) 预组装后传入」与「预组装 options 对象」
# 形态（实测最远：trash.ts childOpts 距构建器调用 11 行、engine-client.ts env 变量
# 距 buildEngineChildEnv 调用 11 行，取 12 留 1 行余量）。
BACKWARD_LINES = 12
# 向前固定兜底：覆盖 env 内联在调用实参区中段的形态（实测最远 git-executor.ts
# execFile options 的 env 在调用行后第 12 行，取 15）。
FORWARD_LINES = 15
# 向前括号延伸封顶：自调用括号起点按净未闭合括号数延伸实参区，防字符串/正则内的
# 括号使计数失真导致窗口无界飞出。
FORWARD_MAX_LINES = 30

# ---------------------------------------------------------------------------
# API 调用点模式
# ---------------------------------------------------------------------------
# 阶段 A：import 侧提取「本文件启用的 API」。只有真 import 了对应符号才启用对应
# 调用点模式，从而天然排除注释提及与方法式误报（ctx.terminalService.spawn 等）。
IMPORT_CHILD_PROCESS_RE = re.compile(
    r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+[\"'](?:node:)?child_process[\"']",
    re.DOTALL,
)
CHILD_PROCESS_APIS = (
    "spawn", "spawnSync",
    "execFile", "execFileSync",
    "exec", "execSync",
    "fork",
)
IMPORT_NODE_PTY_RE = re.compile(
    r"import\s+(?:\*\s+as\s+(\w+)|(\w+))\s+from\s+[\"']node-pty[\"']"
)
IMPORT_WORKER_THREADS_RE = re.compile(
    r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+[\"'](?:node:)?worker_threads[\"']",
    re.DOTALL,
)
IMPORT_ELECTRON_RE = re.compile(
    r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+[\"']electron[\"']", re.DOTALL
)

# 阶段 B：调用点模式（在非注释行上逐行匹配）。
# 裸标识符调用：(?<![\w.$]) 排除属性访问（obj.spawn(）与非词前缀；
# deps.spawn/deps.execFile 是 runtime 手动 DI 的 port 注入惯例——此类文件自身不
# import child_process（如 shell-runner.ts），若仅在解析到 import 时才启用会成盲区，
# 故无条件兜底（业务代码几乎无 .deps.spawn 命名，误报率天然低）。
CALL_PATTERNS = {
    "spawn": re.compile(r"(?<![\w.$])spawn\s*\("),
    "spawnSync": re.compile(r"(?<![\w.$])spawnSync\s*\("),
    "execFile": re.compile(r"(?<![\w.$])execFile\s*\("),
    "execFileSync": re.compile(r"(?<![\w.$])execFileSync\s*\("),
    # exec/execSync 是 shell-string 形态（经 /bin/sh -c），env 面与 spawn 等价，
    # 纳入同一边界；(?<![\w.$]) 排除 obj.exec( 方法式调用（regex.exec 等）。
    "exec": re.compile(r"(?<![\w.$])exec\s*\("),
    "execSync": re.compile(r"(?<![\w.$])execSync\s*\("),
    "fork": re.compile(r"(?<![\w.$])fork\s*\("),
}
DEPS_PATTERNS = [
    ("deps.spawn", re.compile(r"deps\.spawn\s*\(")),
    ("deps.execFile", re.compile(r"deps\.execFile\s*\(")),
]
# promisify 绑定形态：捕获（产物名, 被包裹符号）。仅追踪赋值绑定形态
# （`const execFileAsync = promisify(execFile)`），内联 `promisify(execFile)(...)`
# 本身即含裸 API 名、天然命中既有模式，无需追踪。
PROMISIFY_BIND_RE = re.compile(r"(\w+)\s*=\s*promisify\s*\(\s*(\w+)\s*\)")
PTY_SPAWN_TMPL = r"\b{ns}\.spawn\s*\("
WORKER_RE = re.compile(r"\bnew\s+Worker\s*\(")
UTILITY_FORK_RE = re.compile(r"\butilityProcess\.fork\s*\(")

# 注释行剥离：行首空白后以 // 、 * 、 /* 开头的行不参与调用点匹配
COMMENT_LINE_RE = re.compile(r"^\s*(?://|/\*|\*)")

# ---------------------------------------------------------------------------
# 豁免名单（file_suffix, line_snippet, reason）
# file_suffix 以路径后缀唯一定位文件；line_snippet 必须是违规行的真实子串。
# ---------------------------------------------------------------------------

EXEMPT_CALLSITES = [
    # --- packages/subagent-engine-sdk ---
    (
        "engine-sdk/src/spawn.ts",
        "spawn(opts.command",
        "SDK 引擎任务子进程唯一 spawn 原语 spawnEngineChild：env 形态由类型契约收口"
        "（SpawnEngineChildOptions.env: EngineChildEnv = ReturnType<typeof "
        "buildEngineChildEnv>，非构建器输出无法通过编译），原语自身不经手 env 组装"
        "——类型契约形态豁免（RT-8#9 守卫逐调用点化登记 2026-09-20）",
    ),
    (
        "node-executor.ts",
        'spawn(execPath, ["--eval", "process.exit(0)"]',
        "引擎执行器可用性探针（W9，与 runtime relay-env 探针同款语义的 SDK 复刻）："
        "手工构造的白名单最小 env（仅 PATH/HOME/ELECTRON_RUN_AS_NODE）探测执行器可运行性，"
        "父 env 全量不继承，deny 键零暴露——语义强于构建器（全量继承 + deny 剥离），"
        "改用构建器反而放宽 env 面，故按白名单显式构造豁免（db-isolation/protocolization W9 登记 2026-09-09）",
    ),
    # --- packages/runtime/src ---
    (
        "infra/relay/relay-env.ts",
        "spawn(execPath",
        "relay 可用性探针：手工构造的最小 env（PATH 指向候选执行体目录）探测 pi "
        "可执行性，非父 env 继承型调用，不存在产品变量外泄面（设计文档 §3.6 R5 点名）",
    ),
    (
        "services/reap-orphan-pi.ts",
        "execFile(",
        "孤儿 pi 进程回收前的 ps 只读探测：数组参数不经 shell、显式 timeout，"
        "仅读系统进程表，不向下游传递任何数据（设计文档 §3.6 R5 点名）",
    ),
    (
        "infra/crash-correlation.ts",
        "execFileSync(",
        "崩溃时刻机器面 pi 快照的 ps 只读探测（crash-forensics D10）：数组参数不经 "
        "shell、显式 timeout，仅读系统进程表回读 stdout，无 env 传播意图"
        "（与 reap-orphan-pi.ts ps 探测先例同构）",
    ),
    (
        "infra/crash-correlation.ts",
        "execFile(",
        "崩溃关联的统一日志只读查询（`log show` ±5s 窗取证，crash-forensics D10）："
        "数组参数不经 shell、显式 timeout + maxBuffer，仅读系统日志回读 stdout，"
        "无 env 传播意图（与 reap-orphan-pi.ts ps 探测先例同构）",
    ),
    (
        "services/background-task/process-probe.ts",
        "execFileAsync(",
        "D6 进程 start time 按需现测（promisify(execFile) 产物 execFileAsync，"
        "powershell Get-Process / ps -o lstart 两调用点）：pid 复用防御，数组参数"
        "不经 shell、显式 1s timeout，仅读系统进程表回读 stdout，无 env 传播意图"
        "（与 reap-orphan-pi.ts / background-task-reaper.ts ps 探测先例同构，"
        "设计文档 §3.6 R5 同源场景）；powershell 分支调用参数跨行，snippet 只能"
        "锚定产物名本身，该产物在本文件的全部调用均属本条裁决范围",
    ),
    (
        "services/session/background-task-reaper.ts",
        "spawnSync('ps'",
        "后台任务收殓的进程 start time 只读探测（pid 复用防御，判定逻辑移植自 "
        "extension reaper）：数组参数不经 shell、显式 timeout，仅读系统进程表，"
        "不向下游传递任何数据（与 reap-orphan-pi.ts ps 探测先例同构，"
        "设计文档 §3.6 R5 同源场景）",
    ),
    (
        "services/session/background-task-reaper.ts",
        "spawnSync('pgrep'",
        "收殓补杀的子孙 pid 只读枚举（kill 树兜底残留清理）：数组参数不经 shell，"
        "仅读进程表，无 env 出站面（与 reap-orphan-pi.ts 先例同构）",
    ),
    (
        "services/session/background-task-reaper.ts",
        "taskkill",
        "Windows 进程树终止（孤儿任务补杀）：数组参数不经 shell、stdio ignore，"
        "kill 处置无数据回流通路（与 supervisor/windows-process.ts taskkill.exe 先例同构）",
    ),
    (
        "services/plugin-service/plugin-host-process.ts",
        "fork(bootstrapPath",
        "插件宿主 fork 的 env 由本文件导出的 buildPluginHostChildEnv(process.env) 组装"
        "（buildOutboundChildEnv pass-all 拷贝 + deny 兜底 + ELECTRON_RUN_AS_NODE 注入，"
        "唯一组装点、导出供单测直验），fork 前按需附加 sandbox 目录键——间接组装形态，"
        "非裸继承（RT-8#9 守卫逐调用点化登记 2026-09-20）",
    ),
    (
        "services/plugin-service/plugin-host.ts",
        "new Worker(bootstrapPath",
        "node:worker_threads 的 Worker 是同进程线程而非 OS 子进程，不存在 env 出站边界；"
        "trusted 插件域真正跨进程出站统一收敛于 plugin-host-process.ts 的 fork 接线点"
        "（该文件经 buildOutboundChildEnv 组装）",
    ),
    (
        "infra/relay/relay-registry.ts",
        "spawn(this.piCommand",
        "relay 子进程 spawn 的 env 内联经本文件导出包装 buildChildEnv(frame) 组装"
        "（内部即 buildOutboundChildEnv：帧 env 全量拷贝基座 + relay 五键剥离 + deny"
        "兜底，B8 出站接线，导出供单测直验）——间接组装形态，非裸继承"
        "（RT-8#9 守卫逐调用点化登记 2026-09-20）",
    ),
    (
        "infra/pi/rpc-client.ts",
        "spawn(piCmd, args",
        "pi 长驻进程 spawn 的 env 在 start() 内经 buildPiOutboundEnv 组装"
        "（@zhushanwen/pi-rpc env 模块单源，B3 出站契约收口），底层白名单构建器以"
        "buildChildEnv: buildOutboundChildEnv 参数注入——间接组装形态，非裸继承"
        "（RT-8#9 守卫逐调用点化登记 2026-09-20）",
    ),
    (
        "services/terminal/terminal-service.ts",
        "pty.spawn(shell",
        "用户终端 PTY spawn 的 env 内联经本文件 buildEnv() 组装（buildOutboundChildEnv "
        "pass-all 全量拷贝 + TERM fallback + ELECTRON 三键显式删除，B7 出站接线，"
        "D5 决策：终端身份跟随用户最小剥离）——间接组装形态，非裸继承"
        "（RT-8#9 守卫逐调用点化登记 2026-09-20）",
    ),
    # --- packages/subagent-core/src（W11 收口批加入 SCAN_ROOTS；以下均为永久类，
    # 非迁移期临时豁免——迁移期临时条目已随 engines/zcode 删除清零） ---
    (
        "engine/client/pid-file.ts",
        'spawnSync("ps"',
        "引擎 pidfile 清扫的 pid cmdline/start time 只读探测（R9-3/R9-3b：pid 复用"
        "防御），数组参数不经 shell、显式 timeout，仅读进程表，无 env 传播意图"
        "（与 reap-orphan-pi.ts ps 探测先例同构）",
    ),
    (
        "engine/client/reaper.ts",
        "taskkill",
        "Windows 进程树终止（引擎崩溃收割 kill 处置，无数据回流通路；与 "
        "supervisor/windows-process.ts taskkill.exe 先例同构）",
    ),
    (
        "engine/client/engine-client.ts",
        'spawn("taskkill"',
        "Windows 进程树终止 kill 处置（崩溃/超时收割补杀），stdio ignore、无数据回流"
        "通路，无 env 出站面（与 engine/client/reaper.ts taskkill 先例同构）"
        "（RT-8#9 守卫逐调用点化登记 2026-09-20）",
    ),
    (
        "engine/engines/pi/pi-engine.ts",
        "execFile(",
        "pi 可执行入口版本探测（`<command> --version` 只读探测、显式 timeout、"
        "仅回读 stdout 版本串，无 env 传播意图；chat 域 inproc 保留面，W7 包内"
        "等价物同形态）",
    ),
    (
        "engine/engines/pi/session-runner.ts",
        'spawnSync("ps"',
        "后代 pid cmdline 只读探测（身份校验/收割判定），数组参数不经 shell、显式"
        " timeout，仅读进程表（chat 域 inproc 保留面）",
    ),
    (
        "engine/engines/pi/session-runner.ts",
        'execFile(\n          "git"',
        "git rev-parse --abbrev-ref HEAD 只读探测（子进程 env block 的 branch 行数据"
        "源），cwd 限定、显式 timeout、仅回读 stdout，无 env 传播意图（chat 域 "
        "inproc 保留面）",
    ),
    (
        "orchestration/worker-host.ts",
        "new Worker(workerCode",
        "node:worker_threads 的 Worker 是同进程线程而非 OS 子进程，不存在 env 出站"
        "边界（与 plugin-host.ts new Worker 先例同构）",
    ),
    # --- apps/electron/main ---
    (
        "supervisor/process-control.ts",
        "spawn(cmd",
        "B2 main->runtime 注入点本体：child env 由 supervisor/safe-env.ts "
        "buildSafeEnv（composeChildEnvBase 白名单基座）构建；B2 是产品内部边界，"
        "出站 deny 兜底由下游 runtime 出站接线承担（safe-env.ts 头注释「为何走 "
        "composeChildEnvBase 而非 buildOutboundChildEnv」：直调含 deny 的完整构建器会在"
        "打包态剥掉 runtime 自身合法消费的 TAIJI_AGENT_PACKAGED，瘫痪 isPackaged() 六处判定）",
    ),
    (
        "supervisor/process-control.ts",
        "pgrep",
        "子孙 pid 探测 pgrep 只读（clearProcessTree 语义，无 env 传播意图）",
    ),
    (
        "gateway/sound-handlers.ts",
        "afplay",
        "macOS 音效播放 detached + stdio ignore，面向 OS 工具无数据回流通路",
    ),
    (
        "gateway/sound-handlers.ts",
        "spawn(cmd",
        "跨平台音效 open/xdg-open 打开媒体文件，同上无 env 传播意图",
    ),
    (
        "update/platform-updater.ts",
        "UPDATER_SCRIPT_PATH",
        "自更新拉起 bash 更新脚本（mac/linux 两条路径共用 snippet 匹配）detached + "
        "stdio ignore；env 已经 buildOutboundChildEnv 组装，本条豁免仅兜底未来新增"
        "spawn 形态漂移时的误报复核入口",
    ),
    (
        "update/orchestrator.ts",
        "ref.installerPath",
        "更新包安装器执行 detached + stdio ignore，同 platform-updater 裁决",
    ),
    (
        "supervisor/port-discoverer.ts",
        "execFileSync(",
        "netstat.exe 端口探测只读，同步等待直接返回输出，无 env 传播意图",
    ),
    (
        "supervisor/port-discoverer.ts",
        "ps -p",
        "子孙 pid 探测 ps 只读（clearProcessTree 语义，无 env 传播意图）",
    ),
    (
        "supervisor/port-discoverer.ts",
        "lsof -n -P",
        "unix 监听 pid 探测 lsof 只读，无 env 传播意图",
    ),
    (
        "supervisor/shell-env.ts",
        "spawnSync(shell",
        "登录 shell env 采集探针（入站白名单机制自身的实现）：shell 需要完整登录"
        "环境才能还原用户 env，输出仅用于白名单过滤后的回写，无数据外泄面",
    ),
    (
        "gateway/sound-handlers.ts",
        "spawnSync(cmd",
        "音效播放器存在性探测（cmd --version）：只读探测、stdio ignore，"
        "无 env 传播意图",
    ),
    (
        "supervisor/windows-process.ts",
        "taskkill.exe",
        "Windows 终止进程树的 kill 操作，数组参数不经 shell，无 env 传播意图",
    ),
]


def iter_ts_files():
    for root in SCAN_ROOTS:
        base = os.path.join(REPO_ROOT, root)
        if not os.path.isdir(base):
            print(f"[WARN] 扫描根不存在: {root}", file=sys.stderr)
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_PARTS]
            for name in filenames:
                if not name.endswith(".ts"):
                    continue
                if name.endswith(EXCLUDED_FILE_SUFFIXES):
                    continue
                yield os.path.join(dirpath, name)


def _extract_brace_names(group):
    """从 import {...} 花括号内容提取符号名（剥离内联 type 修饰）。不用
    lstrip("type ")——它是字符集语义会把 execFile 的首字母 e 当作可剥字符剥掉
    （实际踩过：execFile→xecFile 漏检）。"""
    names = set()
    for item in group.split(","):
        name = item.strip()
        if name.startswith("type "):
            name = name[len("type "):].strip()
        if name:
            names.add(name)
    return names


def active_call_patterns(source):
    """根据本文件的 import 提取启用的调用点检测器列表 [(label, compiled_re)]。
    只有真 import 了对应符号才激活对应模式，天然排除注释提及与方法式误报
    （ctx.terminalService.spawn 等）；deps.* 兕底模式无条件启用。"""
    patterns = []
    imported_apis = set()
    for m in IMPORT_CHILD_PROCESS_RE.finditer(source):
        imported_apis |= _extract_brace_names(m.group(1))
    for api in CHILD_PROCESS_APIS:
        if api in imported_apis:
            patterns.append((api, CALL_PATTERNS[api]))
    # promisify 产物名追踪：绑定提取跳过注释行（防注释示例激活），且仅当被包裹
    # API 确已 import 才注册——与阶段 A「真 import 才激活」同哲学。
    for line in source.splitlines():
        if COMMENT_LINE_RE.match(line):
            continue
        for m in PROMISIFY_BIND_RE.finditer(line):
            alias, wrapped = m.group(1), m.group(2)
            if wrapped in imported_apis:
                patterns.append(
                    (wrapped, re.compile(r"(?<![\w.$])%s\s*\(" % re.escape(alias)))
                )
    patterns.extend(DEPS_PATTERNS)
    m = IMPORT_NODE_PTY_RE.search(source)
    if m:
        ns = m.group(1) or m.group(2) or "pty"
        patterns.append(("pty.spawn", re.compile(PTY_SPAWN_TMPL.format(ns=ns))))
    if any(
        "Worker" in n.strip()
        for m in IMPORT_WORKER_THREADS_RE.finditer(source)
        for n in m.group(1).split(",")
    ):
        patterns.append(("new Worker", WORKER_RE))
    if any(
        "utilityProcess" in n.strip()
        for m in IMPORT_ELECTRON_RE.finditer(source)
        for n in m.group(1).split(",")
    ):
        patterns.append(("utilityProcess.fork", UTILITY_FORK_RE))
    return patterns


def exempted(rel_path, line_text):
    for suffix, snippet, _reason in EXEMPT_CALLSITES:
        if rel_path.endswith(suffix) and snippet in line_text:
            return True
    return False


def callsite_armed(lines, call_idx, match_col):
    """判定调用点窗口内是否出现契约构建器形态（窗口定义见文件头判定模型）。

    lines 0 基；call_idx 为调用行下标；match_col 为 API 名匹配起点列。窗口 =
    [call_idx - BACKWARD_LINES, max(固定前向终点, 括号延伸终点))，窗口内任一行命中
    CONTRACT_BUILDER_USAGE_RE 即视为已武装。括号计数按字符粗算（不剥字符串/正则/
    注释），靠 FORWARD_MAX_LINES 封顶保证失真有界。
    """
    lo = max(0, call_idx - BACKWARD_LINES)
    fixed_hi = min(len(lines), call_idx + 1 + FORWARD_LINES)
    paren_end = call_idx + 1
    depth = 0
    for i in range(call_idx, min(len(lines), call_idx + FORWARD_MAX_LINES)):
        seg = lines[i][match_col:] if i == call_idx else lines[i]
        depth += seg.count("(") - seg.count(")")
        paren_end = i + 1
        if depth <= 0:
            break
    hi = min(len(lines), max(fixed_hi, paren_end))
    for j in range(lo, hi):
        if CONTRACT_BUILDER_USAGE_RE.search(lines[j]):
            return True
    return False


FIX_HINT = """[fix] 子进程 env 须经出站契约构建器组装（deny 清单剥 TAIJI_AGENT_PACKAGED / TAIJI_RUNTIME_TOKEN）:
      runtime 包内:   import { buildOutboundChildEnv } from '<相对路径>/infra/spawn-env.js'
      跨包直连 SSOT:  import { buildOutboundChildEnv } from '@taiji/shared'
      设计依据: docs/architecture/env-propagation-boundary.md (§3.5 D2/D3 · §3.6 R1-R5 · §5 U1/U7)
      豁免申请: .githooks/check_spawn_env_boundary.py EXEMPT_CALLSITES 注明理由后过评审"""


def main():
    violations = []             # (rel_path, lineno, api_label, line)
    scanned_with_calls = set()  # 发现调用点的文件
    armed_callsites = []        # 窗口内构建器证据通过的调用点
    exempt_hits = []            # (rel_path, lineno)

    files = sorted(iter_ts_files())
    for path in files:
        rel_path = os.path.relpath(path, REPO_ROOT)
        try:
            with open(path, encoding="utf-8") as f:
                source = f.read()
        except OSError as e:
            print(f"[ERROR] 无法读取 {rel_path}: {e}", file=sys.stderr)
            return 1

        patterns = active_call_patterns(source)
        if not patterns:
            continue

        lines = source.splitlines()
        call_sites = []
        for idx, line in enumerate(lines):
            if COMMENT_LINE_RE.match(line):
                continue
            for label, pat in patterns:
                m = pat.search(line)
                if m:
                    # 一行多模式命中只记首个（label 仅用于违规展示）
                    call_sites.append((idx, label, line, m.start()))
                    break

        if not call_sites:
            continue

        scanned_with_calls.add(rel_path)
        for idx, label, line, col in call_sites:
            lineno = idx + 1
            if exempted(rel_path, line):
                exempt_hits.append((rel_path, lineno))
            elif callsite_armed(lines, idx, col):
                armed_callsites.append((rel_path, lineno))
            else:
                violations.append((rel_path, lineno, label, line))

    # ---------------- 输出 ----------------
    stats = (
        f"[spawn-env-boundary] 扫描 ts 文件 {len(files)} | "
        f"含进程创建调用点 {len(scanned_with_calls)} 个文件 "
        f"(窗口内构建器武装 {len(armed_callsites)} 处 / 调用点豁免 {len(exempt_hits)} 处) | "
        f"违规 {len(violations)}"
    )
    print(stats)

    if violations:
        print("")
        print("[FAIL] 以下进程创建调用点未经出站契约构建器组装 env:")
        by_file = {}
        for rel_path, lineno, label, line in violations:
            by_file.setdefault(rel_path, []).append((lineno, label, line))
        for rel_path in sorted(by_file):
            for lineno, label, line in by_file[rel_path]:
                print(f"  {rel_path}:{lineno} [{label}]")
                print(f"    > {line.strip()[:120]}")
        print("")
        print(FIX_HINT)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 守卫自身崩溃不能静默放行
        print(f"[ERROR] 守卫脚本异常: {exc}", file=sys.stderr)
        sys.exit(1)
