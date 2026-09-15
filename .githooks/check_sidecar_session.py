#!/usr/bin/env python3
"""
Sidecar session 隔离检查

规则 A: sendError 必须带 sessionId（parse_error 除外）
规则 B: session 级别的 this.send() 调用的 payload 必须包含 sessionId

运行方式:
  python3 .githooks/check_sidecar_session.py [files...]
  不传参数时检查默认路径 apps/electron/sidecar/src/server.ts

退出码:
  0 — 通过
  2 — 有违规
"""

import re
import sys
from pathlib import Path

# session 级别的 ServerMessageType，这些事件的 payload 必须包含 sessionId
SESSION_SCOPED_TYPES = {
    'session.deleted',
    'session.history',
    'session.renamed',
    'session.compacting',
    'session.compacted',
    'message.status',
    'message.message_start',
    'message.text_delta',
    'message.thinking_start',
    'message.thinking_delta',
    'message.thinking_end',
    'message.tool_call_start',
    'message.tool_call_end',
    'message.tool_call_pending',
    'message.complete',
    'message.error',
    'context.update',
}

# sendError 不需要 sessionId 的例外（消息解析前无 payload）
SENDERROR_NO_SID_WHITELIST = {'parse_error'}

RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[1;33m'
NC = '\033[0m'


def check_senderror_session_id(lines: list[str], filepath: str) -> list[str]:
    """规则 A: sendError 必须传 sessionId（白名单除外）"""
    violations = []
    for i, line in enumerate(lines, 1):
        m = re.search(r'this\.sendError\(\s*ws,\s*\'([^\']+)\',\s*([^\)]+)\)', line)
        if not m:
            # 可能跨行，看下一行
            if i < len(lines):
                combined = line.rstrip() + ' ' + lines[i].strip()
                m = re.search(r'this\.sendError\(\s*ws,\s*\'([^\']+)\',\s*([^\)]+)\)', combined)
            if not m:
                continue

        code = m.group(1)
        if code in SENDERROR_NO_SID_WHITELIST:
            continue

        args_str = m.group(2)
        # sendError(ws, code, message, id?, sessionId?)
        # 至少需要 5 个参数才算有 sessionId
        # 简单检查：参数中是否包含 sessionId 变量
        remaining_args = args_str.split(',')
        # 去掉前两个（code, message），看是否有第 5 个参数
        if len(remaining_args) < 4:
            # 少于 5 个参数，没有 sessionId
            # 但也可能是跨行参数，检查后续行
            context = ''.join(lines[i-1:i+3])
            arg_count = context.count(',')
            if arg_count < 4:
                violations.append(
                    f"  {filepath}:{i}  sendError('{code}', ...) 缺少 sessionId 参数"
                )

    return violations


def check_send_session_scope(lines: list[str], filepath: str) -> list[str]:
    """规则 B: session 级别的 this.send 调用必须包含 sessionId"""
    violations = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # 匹配 this.send(ws, { type: 'xxx', ...
        m = re.search(r"this\.send\(ws,\s*\{\s*type:\s*'([^']+)'", line)
        if not m:
            i += 1
            continue

        msg_type = m.group(1)
        if msg_type not in SESSION_SCOPED_TYPES:
            i += 1
            continue

        # 这是一个 session 级别的 send 调用，检查 payload 中是否有 sessionId
        # 收集完整的 this.send(...) 调用（可能跨多行）
        depth = 0
        call_text = ''
        j = i
        while j < len(lines) and j < i + 10:
            call_text += lines[j]
            depth += lines[j].count('(') - lines[j].count(')')
            if depth <= 0 and '(' in call_text:
                break
            j += 1

        if 'sessionId' not in call_text:
            violations.append(
                f"  {filepath}:{i+1}  this.send(type='{msg_type}', ...) payload 缺少 sessionId"
            )

        i = j + 1

    return violations


def check_file(filepath: str) -> list[str]:
    path = Path(filepath)
    if not path.exists():
        return []

    lines = path.read_text(encoding='utf-8').splitlines()
    violations = []
    violations.extend(check_senderror_session_id(lines, filepath))
    violations.extend(check_send_session_scope(lines, filepath))
    return violations


def main():
    files = sys.argv[1:] if len(sys.argv) > 1 else [
        'apps/electron/sidecar/src/server.ts',
    ]

    all_violations = []
    for f in files:
        all_violations.extend(check_file(f))

    if all_violations:
        print(f'{RED}[ERROR] Sidecar session 隔离检查失败{NC}')
        print(f'{YELLOW}以下调用缺少 sessionId，会导致消息路由到错误的 session panel:{NC}')
        print()
        for v in all_violations:
            print(f'{RED}{v}{NC}')
        print()
        print(f'{YELLOW}规则: session 级别事件必须带 sessionId{NC}')
        print('\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m')
        sys.exit(2)

    print(f'{GREEN}[OK] Sidecar session 隔离检查通过{NC}')
    sys.exit(0)


if __name__ == '__main__':
    main()
