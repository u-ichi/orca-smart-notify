import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOrcaClient } from '../orca-client.mjs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const event = { worktreeId: 'workspace', paneKey: 'tab:leaf' }
const worktree = { worktreeId: 'workspace', displayName: 'Example', agents: [
  { paneKey: 'tab:leaf', state: 'done', stateStartedAt: 1, lastAssistantMessage: '完了' },
] }

test('全Runのworker一覧をページ送りし、対象paneのterminalと照合する', async () => {
  const calls = []
  const client = createOrcaClient('orca', async (args) => {
    calls.push(args)
    if (args[0] === 'worktree') return { worktrees: [worktree] }
    if (args[0] === 'terminal') return { terminals: [{ tabId: 'tab', leafId: 'leaf', handle: 'target' }] }
    return args.includes('--cursor')
      ? { workers: [{ agentTerminalHandle: 'target' }], scope: { source: 'all' }, page: {} }
      : { workers: [{ agentTerminalHandle: 'another' }], scope: { source: 'all' }, page: { nextCursor: 'page2' } }
  })
  assert.equal((await client.readSnapshot(event)).isWorker, true)
  assert.ok(calls.some((args) => args.includes('page2')))
})

test('worker読取失敗や一部Runだけの応答をworker不存在にしない', async () => {
  for (const response of [null, { workers: [], scope: { source: 'bound' } }]) {
    const client = createOrcaClient('orca', async (args) => {
      if (args[0] === 'worktree') return { worktrees: [worktree] }
      if (args[0] === 'terminal') return { terminals: [{ tabId: 'tab', leafId: 'leaf', handle: 'target' }] }
      return response
    })
    await assert.rejects(client.readSnapshot(event))
  }
})

test('TUIの対応端末が不明な場合をleadにしない', async () => {
  const client = createOrcaClient('orca', async (args) => args[0] === 'worktree'
    ? { worktrees: [worktree] } : { terminals: [] })
  await assert.rejects(client.readSnapshot(event), /Target terminal unavailable/)
})

test('構造化chatの親なしpaneはPTYなしの状態として扱う', async () => {
  const client = createOrcaClient('orca', async (args) => args[0] === 'worktree'
    ? { worktrees: [{ ...worktree, agents: [{ ...worktree.agents[0], parentPaneKey: null, structuredHostOwned: true }] }] }
    : { terminals: [] })
  assert.equal((await client.readSnapshot(event)).isWorker, false)
})

test('構造化sessionのworkerはparentPaneKeyで除外できる', async () => {
  const client = createOrcaClient('orca', async (args) => {
    assert.equal(args[0], 'worktree')
    return { worktrees: [{ ...worktree, agents: [{ ...worktree.agents[0], parentPaneKey: 'parent' }] }] }
  })
  assert.equal((await client.readSnapshot(event)).isWorker, true)
})

test('psが省略したmainAgentは同じ観測時点のイベントだけで補う', async () => {
  const mainAgent = { state: 'done', outcome: 'failure', stateStartedAt: 1 }
  for (const updatedAt of [10, 11]) {
    const client = createOrcaClient('orca', async () => ({ worktrees: [{ ...worktree,
      agents: [{ ...worktree.agents[0], parentPaneKey: 'parent', updatedAt }] }] }))
    const result = await client.readSnapshot({ ...event, state: 'done', receivedAt: 10, mainAgent })
    assert.deepEqual(result.agent.mainAgent, updatedAt === 10 ? mainAgent : undefined)
  }
})

test('既存の状態記録で同じ観測のSessionStartだけを補い、古い境界を停止へ持ち越さない', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-status-test-'))
  t.after(() => rm(dir, { recursive: true }))
  const path = join(dir, 'last-status.json')
  const entry = { paneKey: event.paneKey, worktreeId: event.worktreeId, source: 'claude',
    hookEventName: 'SessionStart', receivedAt: 10, evidenceObservedAt: 10,
    payload: { state: 'done', lastAssistantMessage: 'この本文は補わない',
      mainAgent: { state: 'done', stateStartedAt: 1 } } }
  for (const [change, expected] of [[{}, true], [{ evidenceObservedAt: 9 }, false],
    [{ worktreeId: 'other' }, false], [{ payload: { state: 'working' } }, false],
    [{ hookEventName: 'Stop' }, false], [{ hookEventName: 'Stop', payload: { state: 'done', sessionBoundary: true } }, true]]) {
    await writeFile(path, JSON.stringify({ version: 2, entries: { [event.paneKey]: { ...entry, ...change } } }))
    const client = createOrcaClient('orca', async () => ({ worktrees: [{ ...worktree,
      agents: [{ ...worktree.agents[0], parentPaneKey: 'parent', updatedAt: 10 }] }] }), path)
    const result = await client.readSnapshot(event)
    assert.equal(result.agent.sessionBoundary === true, expected)
    assert.equal(result.agent.lastAssistantMessage, '完了')
  }
})
