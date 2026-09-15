#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Simple CLI — no build step needed
const { createPlugin } = require('../src/index.cjs')
createPlugin(process.argv.slice(2)).catch(err => {
  console.error(err.message)
  process.exit(1)
})
