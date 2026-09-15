// fake-engine-capabilities.ts —— fake 引擎的 capabilities 常量（与
// __fixtures__/engine-protocol/smoke-run.fixture.json 的 initialize.result.capabilities
// 同源；EngineClient 仅把它作 manifest 诊断比对源，不参与判据）。

import type { EngineCapabilities } from "../../types.ts";

export const FAKE_CAPABILITIES: EngineCapabilities = {
  schemaEnforcement: "emulated",
  steer: "unsupported",
  conversation: "native",
  personaInjection: "prompt",
  eventGranularity: "stream",
  sandbox: "none",
  sessionRead: "full",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "ignored",
  maxTurns: true,
};
