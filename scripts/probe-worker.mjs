import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 実Orcaのworkerを使用し、host APIとCLIの入出力だけを試験用に置き換える。
// アプリへの登録、既存設定変更、実通知、外部AI呼出しは行わない。
const entry = process.argv[2]
if (!entry) throw new Error('Usage: node scripts/probe-worker.mjs <Orca plugin-host-entry.js>')
const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(pluginRoot, 'orca-plugin.json'), 'utf8'))
const directory = await mkdtemp(join(tmpdir(), 'orca-notify-worker-'))
const statePath = join(directory, 'state.json')
const cliPath = join(directory, 'orca-fixture.mjs')
const storage = new Map(), notifications = [], records = []
const settings = { quietMs: 0, orcaCommand: cliPath }
let child

async function setState(state, started) {
  await writeFile(statePath, JSON.stringify({ worktrees: [{
    worktreeId: 'workspace', displayName: 'Prototype fixture', agents: [{
      paneKey: 'tab:leaf', agentType: 'codex', state, stateStartedAt: started,
      lastAssistantMessage: '合成した試験メッセージです。', toolName: state === 'waiting' ? 'Bash' : null,
    }],
  }] }))
}

async function start() {
  const queued = [], waiters = []
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TEMP', 'TMP', 'USERPROFILE', 'SystemRoot'].includes(key)))
  env.ELECTRON_RUN_AS_NODE = '1'
  child = fork(resolve(entry), [], { env, execArgv: [], serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let errors = ''
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-3000) })
  child.stdout.resume()
  child.on('message', async (message) => {
    if (message.type === 'hostCall') {
      let value
      switch (message.method) {
        case 'settings.get': value = { settings }; break
        case 'settings.set': settings[message.params.key] = message.params.value; value = { ok: true }; break
        case 'storage.get': value = { value: storage.get(message.params.key) ?? null }; break
        case 'storage.keys': value = { keys: [...storage.keys()] }; break
        case 'storage.delete': storage.delete(message.params.key); value = { ok: true }; break
        case 'storage.set': storage.set(message.params.key, message.params.value); value = { ok: true }; break
        case 'notifications.show': notifications.push(message.params); value = { delivered: true }; break
        default: throw new Error(`Unexpected host method ${message.method}`)
      }
      child.send({ type: 'hostResult', callId: message.callId, ok: true, value })
      return
    }
    if (message.type === 'log') {
      try { records.push(JSON.parse(message.message)) } catch {}
    }
    const index = waiters.findIndex((waiter) => waiter.match(message))
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message)
    else queued.push(message)
  })
  const wait = (match) => {
    const index = queued.findIndex(match)
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0])
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker receipt timeout: ${errors}`)), 15000)
      waiters.push({ match, resolve: (message) => { clearTimeout(timer); resolveWait(message) } })
    })
  }
  child.send({ type: 'init', pluginId: `${manifest.publisher}.${manifest.id}`, pluginRoot,
    mainEntry: manifest.main, grantedCapabilities: manifest.capabilities.map((item) => item.kind) })
  const ready = await wait((message) => message.type === 'ready' || message.type === 'fatal')
  assert.equal(ready.type, 'ready', ready.error)
  assert.deepEqual(ready.commands.sort(), manifest.contributes.commands.map((item) => item.id).sort())
  return {
    command(id, commandId) {
      child.send({ type: 'invokeCommand', callId: id, commandId })
      return wait((message) => message.type === 'commandResult' && message.callId === id)
    },
    event(id, state) {
      child.send({ type: 'deliverEvent', eventId: id, event: 'agent.status.changed',
        payload: { worktreeId: 'workspace', paneKey: 'tab:leaf', state, receivedAt: Date.now() } })
      return wait((message) => message.type === 'eventAck' && message.eventId === id)
    },
    async close() {
      const exiting = new Promise((resolveExit) => child.once('exit', resolveExit))
      child.send({ type: 'shutdown' })
      assert.equal(await exiting, 0)
      child = null
    },
  }
}

try {
  await writeFile(cliPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const result = args[0] === 'worktree' ? JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'))
  : args[0] === 'terminal' ? { terminals: [{ tabId: 'tab', leafId: 'leaf', handle: 'terminal' }] }
  : { workers: [], scope: { source: 'all' }, page: {} }
process.stdout.write(JSON.stringify({ ok: true, result }))
`, { mode: 0o700 })
  await setState('done', 1)
  let worker = await start()
  await worker.event(1, 'done')
  assert.equal(records.at(-1).dryRun, true)
  assert.equal(records.at(-1).classifier, 'disabled')
  assert.equal(notifications.length, 0)
  assert.equal(storage.size, 1)
  await worker.close()

  const observed = records.length
  worker = await start()
  await worker.event(2, 'done')
  assert.equal(records.length, observed)
  assert.equal(notifications.length, 0)
  assert.equal((await worker.command(1, 'u-ichi.orca-smart-notify.notify')).ok, true)
  await setState('waiting', 2)
  await worker.event(3, 'waiting')
  assert.equal(notifications.length, 1)
  assert.deepEqual(notifications[0].target, { worktreeId: 'workspace', paneKey: 'tab:leaf' })
  await worker.event(4, 'waiting')
  assert.equal(notifications.length, 1)

  settings.quietMs = 50
  await setState('done', 3)
  const stopping = worker.event(5, 'done')
  const resuming = worker.event(6, 'working')
  await Promise.all([stopping, resuming])
  assert.equal(notifications.length, 1)
  await setState('waiting', 4)
  const approving = worker.event(7, 'waiting')
  assert.equal((await worker.command(2, 'u-ichi.orca-smart-notify.observe')).ok, true)
  await approving
  assert.equal(notifications.length, 1)
  await worker.close()
  console.log(JSON.stringify({ ok: true, runtime: 'Orca plugin-host-entry',
    checks: ['activate', 'default-observe', 'classification-disabled', 'worker-restart-deduplication',
      'approval-notification-boundary', 'duplicate-event', 'resume-cancellation', 'settings-cancellation', 'shutdown'],
    realNotifications: 0, externalClassifications: 0 }, null, 2))
} finally {
  if (child) child.kill()
  await rm(directory, { recursive: true })
}
