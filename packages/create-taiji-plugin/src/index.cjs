/* eslint-disable @typescript-eslint/no-require-imports */
const readline = require('readline')
const fs = require('fs')
const path = require('path')

async function prompt(questions) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answers = {}
  for (const q of questions) {
    answers[q.name] = await new Promise(resolve => {
      rl.question(`${q.message} `, answer => {
        resolve(answer || q.default)
      })
    })
  }
  rl.close()
  return answers
}

async function createPlugin(args) {
  const targetDir = args[0] || '.'

  console.log('taiji Plugin Scaffolder')
  console.log('─'.repeat(30))

  const answers = await prompt([
    { name: 'name', message: 'Plugin name (kebab-case):', default: 'my-taiji-plugin' },
    { name: 'displayName', message: 'Display name:', default: 'My Plugin' },
    { name: 'description', message: 'Description:', default: 'A taiji plugin' },
    { name: 'trustLevel', message: 'Trust level (sandbox/trusted):', default: 'sandbox' },
  ])

  const outputDir = path.resolve(targetDir, answers.name)
  if (fs.existsSync(outputDir)) {
    throw new Error(`Directory ${outputDir} already exists`)
  }

  fs.mkdirSync(outputDir, { recursive: true })
  fs.mkdirSync(path.join(outputDir, 'src'), { recursive: true })

  // package.json
  const pkgJson = {
    name: answers.name,
    version: '0.1.0',
    description: answers.description,
    displayName: answers.displayName,
    main: 'src/index.js',
    scripts: {},
    engines: { 'taiji': '*' },
    taijiPlugin: {
      manifestVersion: 1,
      main: 'src/index.js',
      trustLevel: answers.trustLevel || 'sandbox',
      activationEvents: ['onStartupFinished'],
      contributes: {},
      permissions: [],
    },
  }
  fs.writeFileSync(path.join(outputDir, 'package.json'), JSON.stringify(pkgJson, null, 2))

  // src/index.js
  const entryContent = `/**
 * ${answers.displayName} — taiji Plugin
 */
const plugin = {
  activate(context) {
    console.log('[${answers.name}] activated')
  },
  deactivate() {
    console.log('[${answers.name}] deactivated')
  },
}

module.exports = plugin
`
  fs.writeFileSync(path.join(outputDir, 'src/index.js'), entryContent)

  // README.md
  const readme = `# ${answers.displayName}

${answers.description}

## Usage

1. Copy this directory to \`~/.taiji/plugins/${answers.name}/\`
2. Restart taiji sidecar
3. Plugin activates on startup

## API

\`\`\`js
const { agentAPI } = context
agentAPI.ui.notify('info', 'Hello from plugin!')
\`\`\`
`
  fs.writeFileSync(path.join(outputDir, 'README.md'), readme)

  console.log(`\nPlugin created at ${outputDir}`)
  console.log('\nNext steps:')
  console.log(`  cd ${answers.name}`)
  console.log('  # Copy to ~/.taiji/plugins/ or symlink')
}

module.exports = { createPlugin }
