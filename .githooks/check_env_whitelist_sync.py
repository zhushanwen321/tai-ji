#!/usr/bin/env python3
"""
ENV_WHITELIST_PREFIXES SSOT 单一性检查 + ENGINE_ENV_* 镜像相等断言

规则 1：`ENV_WHITELIST_PREFIXES` 的 `const ... = [...]` 定义只允许出现在
packages/shared/src/constants.ts（单一权威源）。main/ 和 runtime/ 层
禁止本地定义该常量，只能 `import` 自 shared。

[历史] 旧版（check_env_whitelist_sync.py）检查"两份独立常量同步"——基于
runtime-manager.ts 和 rpc-client.ts 各自定义 ENV_WHITELIST_PREFIXES 的假设。
commit 863f0704（Round 4 review 修复）将两份常量收敛到 shared SSOT 后，
旧正则匹配 `const ENV_WHITELIST_PREFIXES = [` 失效（两文件改为 import），
检查静默误报"未找到"。本版适配 SSOT 架构，改为验证定义点单一性。

精神仍保留：主进程可扩展（safe-env.ts: [...SSOT, 'ELECTRON_']），
子进程用全集（rpc-client.ts: = SSOT）。SSOT 化让"两处不同步"物理不可能，
剩余风险是 SSOT 退化（未来有人在 main/runtime 本地重新定义），本检查防此。

规则 2（W12，impl-plan §2.12）：ENGINE_ENV_PREFIXES / ENGINE_ENV_DENY_LIST 由
shared constants.ts SSOT 构建期生成为 @zhushanwen/subagent-engine-sdk
src/env.ts 的内联镜像（SDK 不得运行时 import @taiji/shared——F9）；本检查
断言镜像与 SSOT 逐项相等（含顺序），漂移即红。注意：SDK 的 env.ts 是镜像的
合法落点，不进 FORBIDDEN_DIRS（FORBIDDEN 只针对 ENV_WHITELIST_PREFIXES 本体）。

规则 3（2026-09-15 改名复查 R1-P1 补强）：env 名字面量镜像断言——SDK/引擎侧
除 env.ts 两常量外还有多处字面量镜像（engine-manifest RESERVED_ENV_PREFIXES、
relay-env 5 键、node-executor ENGINE_NODE_ENV、data-dir ×2、relay.mjs 零依赖
镜像、zcode turn-timeout 2 键、system-prompt-trace preset-fallback 2 键（2026-09-20 R1
评审补，shared PRESET_FALLBACK_ENV_KEYS ↔ extension types.ts 镜像 + deny 面不回退）），
此前无机器断言，单侧改名/改动即静默漂移。
A 类与权威侧（SSOT / shared paths.ts / SDK 同名常量）相等断言；B 类（无 SSOT
对应者）按 TAIJI_* 前缀形态断言，防旧名回退。

运行方式:
  python3 .githooks/check_env_whitelist_sync.py

退出码:
  0 — 通过
  2 — 违规（SSOT 退化或定义点丢失或镜像漂移）
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

SSOT_FILE = PROJECT_ROOT / 'packages/shared/src/constants.ts'
# 禁止本地定义 ENV_WHITELIST_PREFIXES 的目录（只能 import 自 shared）
FORBIDDEN_DIRS = [
    PROJECT_ROOT / 'apps/electron/main',
    PROJECT_ROOT / 'packages/runtime',
]
CONST_NAME = 'ENV_WHITELIST_PREFIXES'

# ENGINE_ENV_* 镜像相等断言（W12）
SDK_MIRROR_FILE = PROJECT_ROOT / 'packages/subagent-engine-sdk/src/env.ts'
ENGINE_ENV_CONSTS = ['ENGINE_ENV_PREFIXES', 'ENGINE_ENV_DENY_LIST']

# 规则 3：env 名字面量镜像断言（2026-09-15 改名复查 R1-P1 补强）
# SDK/引擎侧不得运行时 import @taiji/shared，env 名以字面量镜像存在；
# 此前仅 env.ts 两常量受断言，其余镜像单侧改动即静默漂移（engine_not_found 类）。
#   A 类（相等）：镜像值 === 权威侧对应值
#   B 类（形态）：无 SSOT 对应者，值必须以指定前缀开头（防旧名回退）
SDK_DIR = PROJECT_ROOT / 'packages/subagent-engine-sdk/src'
CORE_ENGINE_DIR = PROJECT_ROOT / 'packages/subagent-core/src/execution/engine'
RELAY_MJS = PROJECT_ROOT / 'extensions/universal/subagent-workflow/relay/relay.mjs'

STRING_CONST_RE_TMPL = r"(?:export\s+)?const\s+{name}(?:\s*:\s*string)?\s*=\s*['\"]([^'\"]+)['\"]"
LOOSE_ARRAY_RE_TMPL = r"const\s+{name}\s*=\s*\[(.*?)\]"


def _extract_string_const(text: str, name: str) -> str | None:
    no_comments = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    no_comments = re.sub(r'//[^\n]*', '', no_comments)
    m = re.search(STRING_CONST_RE_TMPL.format(name=name), no_comments)
    return m.group(1) if m else None


def _extract_loose_array(text: str, name: str) -> list[str] | None:
    no_comments = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    no_comments = re.sub(r'//[^\n]*', '', no_comments)
    m = re.search(LOOSE_ARRAY_RE_TMPL.format(name=name), no_comments, re.DOTALL)
    if not m:
        return None
    return ARRAY_ITEM_STR_RE.findall(m.group(1))

# 匹配 const ENV_WHITELIST_PREFIXES = ...（本地定义，非 import）
# 不匹配 import { ENV_WHITELIST_PREFIXES }、const ENV_WHITELIST = ENV_WHITELIST_PREFIXES
LOCAL_DEF_RE = re.compile(rf'\bconst\s+{CONST_NAME}\s*[:=]')

# 提取 export const NAME: ... = [ 'a', 'b', ... ] 的字符串条目（单/双引号）
ARRAY_ITEMS_RE_TMPL = (
    r'export\s+const\s+{name}\s*:\s*readonly\s+string\[\]\s*=\s*\[(.*?)\]'
)
ARRAY_ITEM_STR_RE = re.compile(r'''['"]([^'"]+)['"]''')


def extract_const_items(text: str, name: str) -> list[str] | None:
    """从 TS 源文本提取 export const NAME: readonly string[] = [...] 的条目列表。

    返回 None = 未找到定义。注释行会被 ARRAY_ITEM_STR_RE 误吞成条目（引号内文本），
    故先剥掉 // 与 /* */ 注释再提取——两处文件该常量块的注释均不含引号包裹的
    变量名形态，剥离后提取即纯条目。
    """
    no_comments = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    no_comments = re.sub(r'//[^\n]*', '', no_comments)
    m = re.search(ARRAY_ITEMS_RE_TMPL.format(name=name), no_comments, re.DOTALL)
    if not m:
        return None
    return ARRAY_ITEM_STR_RE.findall(m.group(1))


def check_engine_env_mirror() -> list[str]:
    """规则 2：SDK env.ts 镜像与 shared SSOT 逐项相等（含顺序）。"""
    errors = []
    ssot_text = SSOT_FILE.read_text(encoding='utf-8')
    if not SDK_MIRROR_FILE.exists():
        return [f'[ERROR] SDK 镜像文件不存在：{SDK_MIRROR_FILE.relative_to(PROJECT_ROOT)}']
    mirror_text = SDK_MIRROR_FILE.read_text(encoding='utf-8')
    for name in ENGINE_ENV_CONSTS:
        ssot_items = extract_const_items(ssot_text, name)
        if ssot_items is None:
            errors.append(
                f'[ERROR] {SSOT_FILE.relative_to(PROJECT_ROOT)} 未定义 `export const {name}`'
                f'（ENGINE_ENV SSOT 丢失）'
            )
            continue
        mirror_items = extract_const_items(mirror_text, name)
        if mirror_items is None:
            errors.append(
                f'[ERROR] {SDK_MIRROR_FILE.relative_to(PROJECT_ROOT)} 未定义镜像 `{name}`'
                f'（构建期生成物丢失，SSOT 改动须两处同批提交）'
            )
            continue
        if ssot_items != mirror_items:
            errors.append(
                f'[ERROR] {name} 镜像与 SSOT 漂移：\n'
                f'  SSOT ({SSOT_FILE.relative_to(PROJECT_ROOT)}): {ssot_items}\n'
                f'  镜像 ({SDK_MIRROR_FILE.relative_to(PROJECT_ROOT)}): {mirror_items}\n'
                f'  修复：两处同批提交（SDK 不得运行时 import @taiji/shared，只能镜像）'
            )
    return errors


def check_env_literal_mirrors() -> list[str]:
    """规则 3：SDK/引擎侧 env 名字面量镜像断言（相等类 + 形态类）。"""
    errors: list[str] = []

    def read(rel: Path) -> str:
        return rel.read_text(encoding='utf-8')

    def expect_value(file: Path, const_name: str, expected: str, source_desc: str) -> None:
        if not file.exists():
            errors.append(f'[ERROR] 镜像文件不存在：{file.relative_to(PROJECT_ROOT)}（{const_name}）')
            return
        actual = _extract_string_const(read(file), const_name)
        if actual is None:
            errors.append(
                f'[ERROR] {file.relative_to(PROJECT_ROOT)} 未定义 `{const_name}`'
                f'（镜像常量丢失，与权威源 {source_desc} 同批维护）'
            )
        elif actual != expected:
            errors.append(
                f'[ERROR] {file.relative_to(PROJECT_ROOT)} `{const_name}` 镜像漂移：'
                f'\n  期望（{source_desc}）：{expected}\n  实际：{actual}'
            )

    def expect_prefix(file: Path, const_name: str, prefix: str) -> None:
        if not file.exists():
            errors.append(f'[ERROR] 镜像文件不存在：{file.relative_to(PROJECT_ROOT)}（{const_name}）')
            return
        actual = _extract_string_const(read(file), const_name)
        if actual is None:
            errors.append(f'[ERROR] {file.relative_to(PROJECT_ROOT)} 未定义 `{const_name}`（镜像常量丢失）')
        elif not actual.startswith(prefix):
            errors.append(
                f'[ERROR] {file.relative_to(PROJECT_ROOT)} `{const_name}={actual}` 不带 `{prefix}` 前缀'
                f'（旧名回退或误改）'
            )

    ssot_text = read(SSOT_FILE)

    # A1 引擎 manifest 保留前缀表 ↔ SSOT ENGINE_ENV_PREFIXES 逐项相等
    manifest = CORE_ENGINE_DIR / 'engine-manifest.ts'
    ssot_prefixes = extract_const_items(ssot_text, 'ENGINE_ENV_PREFIXES')
    if ssot_prefixes is None:
        errors.append('[ERROR] SSOT 未定义 ENGINE_ENV_PREFIXES，规则 3 A1 无法锚定')
    elif manifest.exists():
        actual = _extract_loose_array(read(manifest), 'RESERVED_ENV_PREFIXES')
        if actual is None:
            errors.append(f'[ERROR] {manifest.relative_to(PROJECT_ROOT)} 未定义 `RESERVED_ENV_PREFIXES`')
        elif actual != ssot_prefixes:
            errors.append(
                f'[ERROR] engine-manifest RESERVED_ENV_PREFIXES 与 SSOT ENGINE_ENV_PREFIXES 漂移：\n'
                f'  SSOT：{ssot_prefixes}\n  镜像：{actual}'
            )

    # A2 deny 清单双成员 ↔ SDK relay-env.ts 两键
    deny_items = extract_const_items(ssot_text, 'ENGINE_ENV_DENY_LIST')
    relay_env = SDK_DIR / 'relay-env.ts'
    if deny_items is None:
        errors.append('[ERROR] SSOT 未定义 ENGINE_ENV_DENY_LIST，规则 3 A2 无法锚定')
    else:
        for const_name, expected in [
            ('RELAY_ENV_SESSION_ID', 'TAIJI_SUBAGENT_RELAY_SESSION_ID'),
            ('RELAY_ENV_RECORD_ID', 'TAIJI_SUBAGENT_RELAY_RECORD_ID'),
        ]:
            expect_value(relay_env, const_name, expected, 'SSOT ENGINE_ENV_DENY_LIST 成员')
            if expected not in deny_items:
                errors.append(f'[ERROR] SSOT ENGINE_ENV_DENY_LIST 缺 `{expected}`（deny 面回退）')

    # A3 引擎 node 执行器 env ↔ SSOT ENGINE_ENV NODE
    m = re.search(r"NODE:\s*'([^']+)'", re.sub(r'//[^\n]*', '', ssot_text))
    if m:
        expect_value(SDK_DIR / 'node-executor.ts', 'ENGINE_NODE_ENV', m.group(1), 'SSOT ENGINE_ENV.NODE')
    else:
        errors.append('[ERROR] SSOT 未定义 ENGINE_ENV NODE 键，规则 3 A3 无法锚定')

    # A6 引擎 roots 发现 env 镜像（subagent-core 依赖面无 shared，裸字面量镜像
    # SSOT ENGINE_LAUNCH_ENV_KEYS.ROOTS——单侧改名静默致打包态引擎不可见）
    m_roots = re.search(r"ROOTS:\s*'([^']+)'", re.sub(r'//[^\n]*', '', ssot_text))
    if m_roots:
        expect_value(
            CORE_ENGINE_DIR / 'engine-discovery-roots.ts',
            'ENGINE_ROOTS_ENV',
            m_roots.group(1),
            'SSOT ENGINE_LAUNCH_ENV_KEYS.ROOTS',
        )
    else:
        errors.append('[ERROR] SSOT 未定义 ENGINE_LAUNCH_ENV_KEYS ROOTS 键，规则 3 A6 无法锚定')

    # A7 zcode CLI 路径覆盖键双端（shared spawn-env-contract.ts 登记名 ↔
    # zcode registration.ts process.env 裸读——单侧改名静默回退缺省 /Applications 路径）
    contract_text = read(PROJECT_ROOT / 'packages/shared/src/spawn-env-contract.ts')
    m_cli = re.search(r"name:\s*'(TAIJI_ZCODE_CLI)'", contract_text)
    registration = PROJECT_ROOT / 'packages/zcode-subagent-cli/src/registration.ts'
    if m_cli and registration.exists():
        if f'"{m_cli.group(1)}"' not in read(registration):
            errors.append(
                f'[ERROR] {registration.relative_to(PROJECT_ROOT)} 未裸读 `"{m_cli.group(1)}"`'
                f'（与 spawn-env-contract.ts 登记名单侧漂移——cliPath 覆盖静默失效回退缺省路径）'
            )
    else:
        errors.append('[ERROR] spawn-env-contract.ts 未登记 TAIJI_ZCODE_CLI 或 registration.ts 缺失，规则 3 A7 无法锚定')

    # A8 模式回落 env 名 extension 镜像（shared PRESET_FALLBACK_ENV_KEYS 为权威；
    # system-prompt-trace 独立发布体系不依赖 @taiji/shared，types.ts 字面量镜像——
    # 单侧改名即 runtime 注入 ↔ extension 读取静默断链，presetFallback 披露面消失；
    # deny 面同步断言：ENGINE_ENV_DENY_LIST 两成员不回退，引擎出站剥除失效同害）
    m_preset = re.search(
        r"PRESET_FALLBACK_ENV_KEYS\s*=\s*\{(.*?)\}",
        re.sub(r'/\*.*?\*/', '', ssot_text, flags=re.DOTALL),
        re.DOTALL,
    )
    trace_types = PROJECT_ROOT / 'extensions/taiji/system-prompt-trace/src/types.ts'
    if m_preset is None:
        errors.append('[ERROR] SSOT 未定义 PRESET_FALLBACK_ENV_KEYS，规则 3 A8 无法锚定')
    elif trace_types.exists():
        m_from = re.search(r"FROM:\s*['\"]([^'\"]+)['\"]", m_preset.group(1))
        m_to = re.search(r"TO:\s*['\"]([^'\"]+)['\"]", m_preset.group(1))
        if not (m_from and m_to):
            errors.append('[ERROR] SSOT PRESET_FALLBACK_ENV_KEYS 缺 FROM/TO 键，规则 3 A8 无法锚定')
        else:
            mirror_text = re.sub(r'/\*.*?\*/', '', read(trace_types), flags=re.DOTALL)
            m_mirror = re.search(r"PRESET_FALLBACK_ENV_KEYS\s*=\s*\{(.*?)\}", mirror_text, re.DOTALL)
            if m_mirror is None:
                errors.append(
                    f'[ERROR] {trace_types.relative_to(PROJECT_ROOT)} 未定义 '
                    '`PRESET_FALLBACK_ENV_KEYS`（镜像常量丢失，与 shared SSOT 同批维护）'
                )
            else:
                for key, expected in [('FROM', m_from.group(1)), ('TO', m_to.group(1))]:
                    m_key = re.search(rf"{key}:\s*['\"]([^'\"]+)['\"]", m_mirror.group(1))
                    if m_key is None:
                        errors.append(
                            f'[ERROR] {trace_types.relative_to(PROJECT_ROOT)} '
                            f'`PRESET_FALLBACK_ENV_KEYS` 缓 {key} 键（镜像形状漂移）'
                        )
                    elif m_key.group(1) != expected:
                        errors.append(
                            f'[ERROR] {trace_types.relative_to(PROJECT_ROOT)} '
                            f'`PRESET_FALLBACK_ENV_KEYS.{key}` 镜像漂移：\n'
                            f'  期望（shared SSOT）：{expected}\n  实际：{m_key.group(1)}'
                        )
                deny_items = extract_const_items(ssot_text, 'ENGINE_ENV_DENY_LIST')
                for name in (m_from.group(1), m_to.group(1)):
                    if deny_items is not None and name not in deny_items:
                        errors.append(
                            f'[ERROR] SSOT ENGINE_ENV_DENY_LIST 缺 `{name}`'
                            f'（deny 面回退——引擎出站不再剥除，子 agent trace 记假披露）'
                        )

    # A4 数据目录 env 名三镜像（shared paths.ts 读 env.TAIJI_AGENT_DATA_DIR 为权威）
    for f in [SDK_DIR / 'data-dir.ts', CORE_ENGINE_DIR / 'common' / 'data-dir.ts']:
        expect_value(f, 'TAIJI_DATA_DIR_ENV', 'TAIJI_AGENT_DATA_DIR', 'shared/src/paths.ts 读取名')

    # A5 relay.mjs 零依赖镜像 ↔ SDK relay-env.ts 三键
    if relay_env.exists() and RELAY_MJS.exists():
        sdk_text = read(relay_env)
        for const_name in ['RELAY_ENV_SOCKET', 'RELAY_ENV_SESSION_ID', 'RELAY_ENV_RECORD_ID']:
            expected = _extract_string_const(sdk_text, const_name)
            if expected is None:
                errors.append(f'[ERROR] {relay_env.relative_to(PROJECT_ROOT)} 未定义 `{const_name}`')
            else:
                expect_value(RELAY_MJS, const_name, expected, 'SDK relay-env.ts 同名常量')

    # B 类形态断言（无 SSOT 对应，防旧名回退）
    for const_name in ['RELAY_ENV_SOCKET', 'RELAY_ENV_NODE', 'RELAY_ENV_SCRIPT']:
        expect_prefix(relay_env, const_name, 'TAIJI_SUBAGENT_RELAY_')
    zcode_consts = PROJECT_ROOT / 'packages/zcode-subagent-cli/src/constants.ts'
    for const_name in [
        'ZCODE_TURN_IDLE_TIMEOUT_ENV',
        'ZCODE_TURN_MAX_TIMEOUT_ENV',
        'ZCODE_APPSERVER_STOP_TIMEOUT_ENV',
        'ZCODE_APPSERVER_ABORT_GRACE_ENV',
    ]:
        expect_prefix(zcode_consts, const_name, 'TAIJI_ZCODE_')

    return errors


def check_ssot_exists() -> list[str]:
    """验证 SSOT 文件定义了该常量"""
    errors = []
    if not SSOT_FILE.exists():
        errors.append(f'[ERROR] SSOT 文件不存在：{SSOT_FILE.relative_to(PROJECT_ROOT)}')
        return errors
    text = SSOT_FILE.read_text(encoding='utf-8')
    # SSOT 应有 export const ENV_WHITELIST_PREFIXES = [
    if not re.search(rf'export\s+const\s+{CONST_NAME}\s*[:=]', text):
        errors.append(
            f'[ERROR] {SSOT_FILE.relative_to(PROJECT_ROOT)} 未定义 '
            f'`export const {CONST_NAME}`（SSOT 定义丢失）'
        )
    return errors


def scan_forbidden_local_defs() -> list[str]:
    """扫描 forbidden 目录下是否有本地定义"""
    errors = []
    for forbidden_dir in FORBIDDEN_DIRS:
        if not forbidden_dir.exists():
            continue
        for ts_file in forbidden_dir.rglob('*.ts'):
            # 跳过 node_modules / dist
            if 'node_modules' in ts_file.parts or 'dist' in ts_file.parts:
                continue
            text = ts_file.read_text(encoding='utf-8', errors='ignore')
            if LOCAL_DEF_RE.search(text):
                errors.append(
                    f'[ERROR] {ts_file.relative_to(PROJECT_ROOT)}: '
                    f'本地定义了 `{CONST_NAME}`，违反 SSOT 单一性'
                )
                errors.append(
                    f'  修复：删除本地定义，改用 '
                    f"`import {{ {CONST_NAME} }} from '@taiji/shared'`"
                )
    return errors


def main() -> int:
    errors = (
        check_ssot_exists()
        + scan_forbidden_local_defs()
        + check_engine_env_mirror()
        + check_env_literal_mirrors()
    )

    if errors:
        for e in errors:
            print(e)
        print()
        print()
        print('\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m')
        return 2

    print(f'[OK] {CONST_NAME} SSOT 单一性检查通过（定义点：shared/src/constants.ts）')
    print('[OK] ENGINE_ENV_PREFIXES / ENGINE_ENV_DENY_LIST SDK 镜像与 SSOT 逐项相等')
    print('[OK] env 名字面量镜像（engine-manifest/relay-env/node-executor/data-dir×2/relay.mjs/zcode）断言通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
