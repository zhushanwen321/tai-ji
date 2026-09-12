# ADR-0011: Bundled extensions via direct copy (supersede ADR-0007)

- 状态：Accepted

## Context

ADR-0007 规划使用 git submodule 管理外部 extension/skill 依赖。实际实施中，submodule 方案增加了 CI 复杂度（需 submodule init + copy 步骤），且 extension 源码变更频率低、体量小（~60 个 TS 文件，总计约 400KB）。

## Decision

直接将 extension 源码复制到 `src-electron/resources/pi/agent/extensions/` 目录，纳入项目 git 跟踪。更新 extension 时重新从源仓库 rsync。Supersedes ADR-0007。

## Reason

1. 体量小：6 个 extension + 1 个共享模块，总计 ~60 个文件、~400KB。不值得 submodule 基础设施
2. 零 CI 改动：不需要 submodule init/update 步骤，现有 extraResources 配置已覆盖
3. Dev 体验简化：不需要 clone 时 `--recurse-submodules`
4. 版本管理：通过 rsync 时间戳和 commit message 记录更新来源
