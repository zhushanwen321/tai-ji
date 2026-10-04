import { describe, expect, it } from 'vitest';

import {
  RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET,
  RELAY_EXIT_CODES,
  RELAY_PROTOCOL_VERSION,
  isRelayActive,
} from '../relay-env.js';

describe('relay env SSOT', () => {
  it('激活判定：三 env 同时非空', () => {
    expect(isRelayActive({ [RELAY_ENV_SOCKET]: '/x.sock', [RELAY_ENV_NODE]: '/node', [RELAY_ENV_SCRIPT]: '/relay.mjs' })).toBe(true);
  });

  it('任一缺失即不激活（全有或全无）', () => {
    const full = {
      [RELAY_ENV_SOCKET]: '/x.sock',
      [RELAY_ENV_NODE]: '/node',
      [RELAY_ENV_SCRIPT]: '/relay.mjs',
    };
    expect(isRelayActive({ ...full, [RELAY_ENV_SOCKET]: '' })).toBe(false);
    expect(isRelayActive({ ...full, [RELAY_ENV_NODE]: undefined })).toBe(false);
    expect(isRelayActive({})).toBe(false);
    // [验收门修复] 宿主（pi 子进程链）可能注入 RELAY env——断言对象改为「清空 RELAY
    // 键后的副本」：保留真实环境形态意图的同时对泄漏免疫（与 pi-invocation.test.ts
    // 的 beforeEach 清理同病同修，不依赖 runner 环境）。
    const sanitized: Record<string, string | undefined> = {
      ...process.env,
      [RELAY_ENV_SOCKET]: undefined,
      [RELAY_ENV_NODE]: undefined,
      [RELAY_ENV_SCRIPT]: undefined,
      [RELAY_ENV_SESSION_ID]: undefined,
      [RELAY_ENV_RECORD_ID]: undefined,
    };
    expect(isRelayActive(sanitized)).toBe(false);
  });

  it('env 名与退出码稳定（relay.mjs 镜像一致性由 conformance relay 断言锁定）', () => {
    expect(RELAY_ENV_SESSION_ID).toBe('TAIJI_SUBAGENT_RELAY_SESSION_ID');
    expect(RELAY_ENV_RECORD_ID).toBe('TAIJI_SUBAGENT_RELAY_RECORD_ID');
    expect(RELAY_PROTOCOL_VERSION).toBe(1);
    expect(RELAY_EXIT_CODES).toEqual({
      VERSION_MISMATCH: 10,
      SOCKET_UNREACHABLE: 11,
      SOCKET_CLOSED: 12,
      MISSING_IDENTITY: 13,
    });
  });

  // 代理启动键（自壳 contract.relay.test.ts「SSOT 导出面」describe 迁入并升级为字面量断言）：
  // NODE/SCRIPT 由 runtime（注入）与 extension（激活判定 + spawn 组装）消费，代理零消费、
  // 不进 relay.mjs 内嵌镜像——字面量锁定防静默改名；与 SOCKET 键的防呆断言保证
  // 启动键不会被误改同名（否则 isRelayActive 三 env 全有或全无判定被单键击穿）。
  it('代理启动键 RELAY_ENV_NODE / RELAY_ENV_SCRIPT 字面量稳定，且不与 SOCKET 键混同', () => {
    expect(RELAY_ENV_NODE).toBe('TAIJI_SUBAGENT_RELAY_NODE');
    expect(RELAY_ENV_SCRIPT).toBe('TAIJI_SUBAGENT_RELAY_SCRIPT');
    expect(RELAY_ENV_NODE).not.toBe(RELAY_ENV_SOCKET);
    expect(RELAY_ENV_SCRIPT).not.toBe(RELAY_ENV_SOCKET);
  });
});
