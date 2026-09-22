# @zhushanwen/zcode-session-source

zcode subagent 会话库（SQLite）的唯一只读读取基座。三个消费面：session-reader 扩展
（bun 宿主）、runtime 会话导入薄包装（node 侧）、未来新增的 coding-agent source。

## 内容

- **sqlite-driver**（D3 双驱动）：运行时探测 bun/node，动态 import 经变量间接
  （esbuild 规约防护）；适配层只暴露 `open / prepare / all / get / close` 公共子集。
- **四级恢复阶梯**（设计 §3.5 单一规格，全网唯一）：
  - L1 直开（readonly，`-wal` 在场正常工作）
  - L2 immutable 逃逸（常态恢复，零拷贝；仅当开库前确认 `-wal` 不存在——有内容
    `-wal` 下 immutable 静默丢行，必须门控）
  - L3 小库快照兜底（db 拷 mkdtemp 固定前缀 `taiji-zcode-snap-` + 自建 0 字节
    `-wal` → 开库后验证 `sqlite_master` 表集合含 `session/message/part`；规模门
    256MB 拒拷；读后 finally 清理）
  - L4 错误面（`SqliteUnreadableError`，`attempted` 记录已尝试级别，供上层映射
    消费侧错误码——本包不私建错误码词表）
  - 拷贝集唯一定义：db only + 自建 0 字节 `-wal`；`-wal`/`-shm` 在场绝不自动拷贝
    （防静默回滚），`-shm` 永不进拷贝集。
- **sqlite-access**：行集查询（`getSessionTranscript`：session → message → part
  三级表，联合序）、schema 版本已知集闸门（`KNOWN_ZCODE_SCHEMA_VERSIONS`）、
  库路径投影与白名单集合（路径段常量同源 `@zhushanwen/subagent-engine-sdk`，
  `dataDir` 由调用方传入，本包不做宿主路径推导）。

## 测试（D3 源级双跑）

```bash
pnpm vitest run        # node 趟（node:sqlite 驱动路径）
bunx vitest run        # bun 趟（bun:sqlite 驱动路径，挂 pre-commit/CI）
```

同一断言集双趟执行，分别覆盖两条驱动路径；fixture 建库同样经变量间接取当前
运行时的可写连接（bun 下 `node:sqlite` 不可用）。测试只写删 `os.tmpdir()` 下
自建自删目录，不触真实数据目录。
