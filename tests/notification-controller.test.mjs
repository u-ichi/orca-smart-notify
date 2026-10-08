import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createController } from '../notification-controller.mjs'

const event = { worktreeId: 'workspace', paneKey: 'tab:leaf', state: 'done', receivedAt: 100 }
const snapshot = (extra = {}) => ({
  worktree: { id: 'workspace', displayName: 'Example' },
  agent: { paneKey: 'tab:leaf', agentType: 'codex', state: 'done', stateStartedAt: 90,
    lastAssistantMessage: '依頼された変更と確認を終えました。', ...extra },
  isWorker: false,
})

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function setup(overrides = {}, saved = new Map()) {
  const sent = [], records = []
  const deps = {
    readSnapshot: async () => snapshot(),
    classify: async () => ({ state: 'completed', classifier: 'fixture' }),
    getSettings: async () => ({ dryRun: false, quietMs: 0 }),
    wait: async () => {},
    load: async (key) => saved.get(key),
    save: async (key, value) => { saved.set(key, value) },
    deliver: async (value) => { sent.push(value); return { delivered: true } },
    log: (value) => records.push(value),
    ...overrides,
  }
  return { controller: createController(deps), deps, sent, records, saved }
}

test('leadの完了と判断待ちを通知し、担当の結果待ちは通知しない', async () => {
  for (const state of ['completed', 'needs_user', 'waiting']) {
    const s = setup({ classify: async () => ({ state }) })
    const result = await s.controller.handleEvent(event)
    assert.equal(s.sent.length, state === 'waiting' ? 0 : 1)
    assert.equal(result.notify, state !== 'waiting')
    if (state !== 'waiting') assert.equal(result.kind, state)
  }
})

test('利用者が選んだ通知種類だけを送る', async () => {
  for (const state of ['completed', 'needs_user', 'waiting']) {
    const s = setup({ getSettings: async () => ({ dryRun: false, notifyKinds: ['needs_user'] }),
      classify: async () => ({ state }) })
    const result = await s.controller.handleEvent(event)
    assert.equal(result.notify, state === 'needs_user')
    assert.equal(s.sent.length, state === 'needs_user' ? 1 : 0)
  }
})

test('比較試験の対象外worktreeは本文取得も外部AI分類もしない', async () => {
  const s = setup({ getSettings: async () => ({ dryRun: true, worktreeIds: ['other-workspace'] }),
    readSnapshot: async () => assert.fail('対象外の本文を取得した'),
    classify: async () => assert.fail('対象外の本文を外部送信した') })
  assert.equal((await s.controller.handleEvent(event)).reason, 'outside-worktree-scope')
  assert.equal(s.sent.length, 0)
})

test('workerとbackgroundを含むworkingは分類せず通知しない', async () => {
  for (const value of [{ ...snapshot(), isWorker: true }, snapshot({ parentPaneKey: 'parent' }), snapshot({ state: 'working' })]) {
    const s = setup({ readSnapshot: async () => value,
      classify: async () => assert.fail('通知対象外を外部分類した') })
    await s.controller.handleEvent(event)
    assert.equal(s.sent.length, 0)
  }
})

test('起動・clear・resumeは通知せず、本文のない実際の停止と失敗は通知する', async () => {
  for (const [extra, expected] of [
    [{ sessionBoundary: true }, 'session-boundary'],
    [{}, 'unclassified'],
    [{ sessionBoundary: true, mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 90 } }, 'failure'],
  ]) {
    const s = setup({ readSnapshot: async () => snapshot({ lastAssistantMessage: '', ...extra }),
      classify: async () => assert.fail('本文のない状態を外部分類した') })
    const result = await s.controller.handleEvent(event)
    assert.equal(result.reason ?? result.kind, expected)
    assert.equal(s.sent.length, expected === 'session-boundary' ? 0 : 1)
  }
})

test('親がworkingで子だけが承認待ちの場合は通知しない', async () => {
  const s = setup({ readSnapshot: async () => snapshot({ state: 'waiting', toolName: 'Bash',
    mainAgent: { state: 'working', stateStartedAt: 10 } }) })
  assert.equal((await s.controller.handleEvent({ ...event, state: 'waiting' })).reason, 'child-waiting')
  assert.equal(s.sent.length, 0)
})

test('承認待ちは本文分類をせず、再開した自動承認は通知しない', async () => {
  const s = setup({ readSnapshot: async () => snapshot({ state: 'waiting', toolName: 'Bash', toolInput: 'git status' }),
    classify: async () => assert.fail('承認待ちを外部分類した') })
  assert.equal((await s.controller.handleEvent({ ...event, state: 'waiting' })).kind, 'approval')
  assert.equal(s.sent.length, 1)
  const resumed = setup({ readSnapshot: async () => snapshot({ state: 'working' }) })
  await resumed.controller.handleEvent({ ...event, state: 'waiting' })
  assert.equal(resumed.sent.length, 0)
})

test('mainAgentが失敗していれば子がworkingでも失敗通知の候補にする', async () => {
  const mainAgent = { state: 'done', outcome: 'failure', stateStartedAt: 95 }
  const s = setup({ readSnapshot: async () => snapshot({ state: 'working', mainAgent }) })
  const result = await s.controller.handleEvent({ ...event, state: 'working', mainAgent })
  assert.equal(result.kind, 'failure')
  assert.equal(s.sent.length, 1)
})

test('子の状態だけが変わっても同じmainAgentの失敗を再通知しない', async () => {
  const mainAgent = { state: 'done', outcome: 'failure', stateStartedAt: 95 }
  let row = snapshot({ state: 'working', mainAgent })
  const s = setup({ readSnapshot: async () => row })
  await s.controller.handleEvent({ ...event, state: 'working', mainAgent })
  row = snapshot({ state: 'done', stateStartedAt: 200, mainAgent })
  await s.controller.handleEvent({ ...event, receivedAt: 200, mainAgent })
  assert.equal(s.sent.length, 1)
})

test('分類中の再開イベントは古い通知を取り消す', async () => {
  const started = deferred(), classification = deferred()
  const s = setup({ classify: async () => { started.resolve(); return classification.promise } })
  const pending = s.controller.handleEvent(event)
  await started.promise
  await s.controller.handleEvent({ ...event, state: 'working' })
  classification.resolve({ state: 'completed' })
  await pending
  assert.equal(s.sent.length, 0)
})

test('再開イベントを受け損ねても分類後の状態再確認で取り消す', async () => {
  let calls = 0
  const s = setup({ readSnapshot: async () => ++calls === 1 ? snapshot() : snapshot({ state: 'working', stateStartedAt: 200 }) })
  await s.controller.handleEvent(event)
  assert.equal(s.sent.length, 0)
})

test('同じ停止は並行イベントとworker再起動の後も重複通知しない', async () => {
  const s = setup()
  await Promise.all([s.controller.handleEvent(event), s.controller.handleEvent({ ...event, receivedAt: 120 })])
  assert.equal(s.sent.length, 1)
  const restarted = setup({}, s.saved)
  await restarted.controller.handleEvent({ ...event, receivedAt: 200 })
  assert.equal(restarted.sent.length, 0)
  const next = setup({ readSnapshot: async () => snapshot({ stateStartedAt: 300 }) }, s.saved)
  await next.controller.handleEvent({ ...event, receivedAt: 301 })
  assert.equal(next.sent.length, 1)
})

test('CLI失敗はleadとみなさず、判定不能として記録する', async () => {
  const s = setup({ readSnapshot: async () => { throw new Error('CLI unavailable') } })
  const result = await s.controller.handleEvent(event)
  assert.equal(result.reason, 'unavailable')
  assert.equal(s.sent.length, 0)
  assert.ok(s.records.some((r) => r.reason === 'unavailable'))
})

test('分類失敗時は現行と同じく判定不能の停止を通知する', async () => {
  const s = setup({ classify: async () => { throw new Error('classifier unavailable') } })
  assert.equal((await s.controller.handleEvent(event)).kind, 'unclassified')
  assert.equal(s.sent.length, 1)
})

test('通知API失敗を成功として保存せず、次のイベントで再試行できる', async () => {
  let calls = 0
  const s = setup({ deliver: async () => ({ delivered: ++calls > 1 }) })
  assert.equal((await s.controller.handleEvent(event)).reason, 'delivery-failed')
  assert.equal(s.saved.size, 0)
  assert.equal((await s.controller.handleEvent(event)).notify, true)
  assert.equal(calls, 2)
})

test('観測モードは通知せず、本文やコマンドをログへ残さない', async () => {
  const s = setup({ getSettings: async () => ({ dryRun: true, quietMs: 0 }) })
  const result = await s.controller.handleEvent(event)
  assert.equal(result.kind, 'completed')
  assert.equal(result.dryRun, true)
  assert.equal(s.sent.length, 0)
  assert.ok(s.records.length > 0)
  assert.equal(JSON.stringify(s.records).includes('依頼された変更'), false)
})

test('承認待ちのcommand本文を重複防止の保存先にも残さない', async () => {
  const s = setup({ readSnapshot: async () => snapshot({ state: 'waiting', toolName: 'Bash', toolInput: 'synthetic-private-command' }) })
  await s.controller.handleEvent({ ...event, state: 'waiting' })
  assert.equal(JSON.stringify([...s.saved.values()]).includes('synthetic-private-command'), false)
})

test('待機中に設定を無効にすると外部分類と通知を行わない', async () => {
  let settings = { dryRun: false, classificationEnabled: true, quietMs: 0 }
  const s = setup({ getSettings: async () => settings,
    wait: async () => { settings = { ...settings, dryRun: true, classificationEnabled: false } },
    classify: async (_row, _signal, current) => {
      assert.equal(current.classificationEnabled, false)
      return { state: null, classifier: 'disabled' }
    } })
  await s.controller.handleEvent(event)
  assert.equal(s.sent.length, 0)
  assert.equal(s.records.at(-1).dryRun, true)
})

test('設定コマンドによる取消後は遅い分類結果を通知しない', async () => {
  const started = deferred(), classification = deferred()
  const s = setup({ classify: async () => { started.resolve(); return classification.promise } })
  const pending = s.controller.handleEvent(event)
  await started.promise
  s.controller.cancelPending()
  classification.resolve({ state: 'completed' })
  await pending
  assert.equal(s.sent.length, 0)
})

const ruled = (displayName, extra = {}) => ({ ...snapshot(extra), worktree: { id: 'workspace', displayName } })
const ruleSettings = { dryRun: false, quietMs: 0, classificationEnabled: true,
  worktreeRules: [{ displayNamePrefixes: ['Dots: '], notifyKinds: ['approval'] }] }

test('worktree規則に一致した名前では実際の承認待ちだけ通知し、本文は外部分類しない', async () => {
  const s = setup({ getSettings: async () => ruleSettings,
    readSnapshot: async () => ruled('Dots: lifecycle design', { state: 'waiting', toolName: 'Bash', toolInput: 'rm -r build' }),
    classify: async () => assert.fail('規則対象の本文を外部送信した') })
  const result = await s.controller.handleEvent({ ...event, state: 'waiting' })
  assert.equal(result.kind, 'approval')
  assert.equal(result.notifyScope, 'worktree-rule')
  assert.equal(s.sent.length, 1)
})

test('worktree規則に一致した名前の完了・質問・失敗は本人へ送らず、判定記録と重複防止の保存は残す', async () => {
  for (const [extra, kind] of [
    [{}, 'unclassified'],
    [{ state: 'waiting', toolName: 'AskUserQuestion' }, 'needs_user'],
    [{ state: 'blocked' }, 'needs_user'],
    [{ state: 'done', mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 90 } }, 'failure'],
  ]) {
    const s = setup({ getSettings: async () => ruleSettings,
      readSnapshot: async () => ruled('Dots: lifecycle design', extra),
      classify: async () => assert.fail('通知しない停止の本文を外部送信した') })
    const result = await s.controller.handleEvent({ ...event, state: extra.state ?? 'done' })
    assert.equal(result.notify, false)
    assert.equal(result.reason, 'disabled-kind')
    assert.equal(result.kind, kind)
    assert.equal(s.sent.length, 0)
    assert.equal(s.saved.size, 1)
    assert.ok(s.records.some((r) => r.kind === kind && r.notifyScope === 'worktree-rule'))
  }
})

test('worktree規則は表示名の前置き一致だけに適用し、既定の名前と語を含むだけの名前は従来どおり通知する', async () => {
  for (const displayName of ['Example', 'Dots session notification routing', 'dots: legacy', 'Fix dots approval flow']) {
    let classified = 0
    const s = setup({ getSettings: async () => ruleSettings,
      readSnapshot: async () => ruled(displayName),
      classify: async () => { classified += 1; return { state: 'completed', classifier: 'fixture' } } })
    const result = await s.controller.handleEvent(event)
    assert.equal(result.notify, true, displayName)
    assert.equal(result.notifyScope, 'default')
    assert.equal(classified, 1)
    assert.equal(s.sent.length, 1)
  }
})

test('worktree規則に一致しても、自動承認のworkingと再開した承認待ちは通知しない', async () => {
  const working = setup({ getSettings: async () => ruleSettings,
    readSnapshot: async () => assert.fail('workingイベントで状態を読み直した') })
  assert.equal((await working.controller.handleEvent({ ...event, state: 'working' })).reason, 'working')
  const resumed = setup({ getSettings: async () => ruleSettings,
    readSnapshot: async () => ruled('Dots: lifecycle design', { state: 'working' }) })
  assert.equal((await resumed.controller.handleEvent({ ...event, state: 'waiting' })).reason, 'working')
  assert.equal(working.sent.length + resumed.sent.length, 0)
})

test('worktree規則で抑止した停止も同じ停止として重複判定し、再分類しない', async () => {
  const s = setup({ getSettings: async () => ruleSettings, readSnapshot: async () => ruled('Dots: lifecycle design'),
    classify: async () => assert.fail('抑止済みの停止を外部分類した') })
  assert.equal((await s.controller.handleEvent(event)).reason, 'disabled-kind')
  assert.equal((await s.controller.handleEvent({ ...event, receivedAt: 200 })).reason, 'duplicate')
  assert.equal(s.sent.length, 0)
})

test('設定で明示した旧前置きdot: も一致し、列挙しない表記は一致しない', async () => {
  const settings = { ...ruleSettings, worktreeRules: [{ displayNamePrefixes: ['Dots: ', 'dot: '], notifyKinds: ['approval'] }] }
  for (const [displayName, scope] of [['dot: main同期実装', 'worktree-rule'], ['Dot: other', 'default'], ['dot-runtime-recovery', 'default']]) {
    const s = setup({ getSettings: async () => settings, readSnapshot: async () => ruled(displayName) })
    const result = await s.controller.handleEvent(event)
    assert.equal(result.notifyScope, scope, displayName)
    assert.equal(result.notify, scope === 'default', displayName)
  }
})

test('承認待ちと失敗を選んだ規則では失敗通知を保持し、完了は送らない', async () => {
  const settings = { ...ruleSettings, worktreeRules: [{ displayNamePrefixes: ['Dots: '], notifyKinds: ['approval', 'failure'] }] }
  const failed = setup({ getSettings: async () => settings,
    readSnapshot: async () => ruled('Dots: lifecycle design', { mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 90 } }),
    classify: async () => assert.fail('失敗を外部分類した') })
  const failure = await failed.controller.handleEvent(event)
  assert.equal(failure.kind, 'failure')
  assert.equal(failure.notify, true)
  assert.equal(failed.sent.length, 1)
  assert.match(failed.sent[0].title, /エラーで停止/)
  const completed = setup({ getSettings: async () => settings, readSnapshot: async () => ruled('Dots: lifecycle design'),
    classify: async () => assert.fail('通知しない完了を外部分類した') })
  assert.equal((await completed.controller.handleEvent(event)).reason, 'disabled-kind')
  assert.equal(completed.sent.length, 0)
})

test('規則の通知種類は既定のnotifyKindsへの追加ではなく置換になる', async () => {
  // 既定はcompleted、規則はapprovalだけ。規則が追加なら完了も通知され、置換なら通知されない。
  const settings = { dryRun: false, quietMs: 0, classificationEnabled: true, notifyKinds: ['completed'],
    worktreeRules: [{ displayNamePrefixes: ['Dots: '], notifyKinds: ['approval'] }] }
  const plain = setup({ getSettings: async () => settings, readSnapshot: async () => ruled('Example') })
  assert.equal((await plain.controller.handleEvent(event)).notify, true)
  const ruledOnly = setup({ getSettings: async () => settings, readSnapshot: async () => ruled('Dots: lifecycle design'),
    classify: async () => assert.fail('置換後に通知対象外の本文を外部分類した') })
  const result = await ruledOnly.controller.handleEvent(event)
  assert.equal(result.reason, 'disabled-kind')
  assert.equal(ruledOnly.sent.length, 0)
  // 既定に無いapprovalが規則では通知される。
  const approval = setup({ getSettings: async () => settings,
    readSnapshot: async () => ruled('Dots: lifecycle design', { state: 'waiting', toolName: 'Bash', toolInput: 'make' }) })
  assert.equal((await approval.controller.handleEvent({ ...event, state: 'waiting' })).notify, true)
})

test('前置きか通知種類が配列でない規則は無視し、既定の通知種類を使う', async () => {
  const s = setup({ getSettings: async () => ({ dryRun: false, quietMs: 0, notifyKinds: ['completed'],
    worktreeRules: [{ displayNamePrefixes: 'Dots: ', notifyKinds: ['approval'] }, { displayNamePrefixes: ['Dots: '] }, null] }),
    readSnapshot: async () => ruled('Dots: lifecycle design') })
  const result = await s.controller.handleEvent(event)
  assert.equal(result.notify, true)
  assert.equal(result.notifyScope, 'default')
})

test('既定の通知種類が分類結果を含まなければ外部分類を省く', async () => {
  const s = setup({ getSettings: async () => ({ dryRun: false, quietMs: 0, classificationEnabled: true, notifyKinds: ['approval', 'failure'] }),
    classify: async () => assert.fail('通知対象外の本文を外部送信した') })
  const result = await s.controller.handleEvent(event)
  assert.equal(result.reason, 'disabled-kind')
  assert.equal(result.classifier, 'skipped-kinds')
})

test('plugin停止後に遅い分類が戻っても通知しない', async () => {
  const started = deferred(), classification = deferred()
  const s = setup({ classify: async () => { started.resolve(); return classification.promise } })
  const pending = s.controller.handleEvent(event)
  await started.promise
  s.controller.stop()
  classification.resolve({ state: 'completed' })
  await pending
  assert.equal(s.sent.length, 0)
})
