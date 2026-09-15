/**
 * Noop ESM loader fixture for sandbox fork tests.
 *
 * Production wiring injects plugin-esm-loader.cjs via execArgv --import. The MF-1 fork-boundary
 * assertion requires every sandbox fork to carry a --import entry. Tests use this noop loader
 * (a valid --import target that registers no hooks) so the assertion passes without pulling in
 * the real loader (whose initialize() would throw without a valid TAIJI_PLUGIN_SANDBOX_DIR).
 *
 * NOT shipped — test fixture only (referenced by PluginHostProcess sandbox fork tests).
 */
'use strict'

// Intentionally empty: a valid CommonJS module loaded via --import that registers no ESM hooks.
// The mock bootstrap (plugin-bootstrap-process.mock.cjs) controls all plugin behavior in tests.
module.exports = {}
