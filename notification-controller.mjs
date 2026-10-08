import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const LABELS = { completed: '完了', needs_user: '判断待ち', approval: '承認待ち',
  failure: 'エラーで停止', unclassified: '停止（判定不能）' }
const STATES = new Set(['working', 'waiting', 'blocked', 'done'])
const QUESTION = /^(AskUserQuestion|ask_user_question|request_user_input)$/
// 本文分類でしか決まらない種類。どれも通知対象でなければ外部分類を省く。
const CLASSIFIED_KINDS = ['completed', 'needs_user', 'unclassified']

function includesWorktree(settings, event) {
  return settings.worktreeIds === undefined ||
    (Array.isArray(settings.worktreeIds) && settings.worktreeIds.includes(event.worktreeId))
}

// worktreeの表示名が前置きに一致した最初の規則。前置きと通知種類の両方が配列の規則だけを使う。
function worktreeRule(settings, worktree) {
  const name = worktree?.displayName
  if (!Array.isArray(settings.worktreeRules) || typeof name !== 'string') return null
  return settings.worktreeRules.find((rule) => rule && typeof rule === 'object' &&
    Array.isArray(rule.displayNamePrefixes) && Array.isArray(rule.notifyKinds) &&
    rule.displayNamePrefixes.some((prefix) => typeof prefix === 'string' && prefix.length > 0 && name.startsWith(prefix))) ?? null
}

// 本人へ送る通知種類。規則に一致すればその種類、なければ既定のnotifyKindsを使う。
function allowedKinds(settings, worktree) {
  const rule = worktreeRule(settings, worktree)
  const kinds = rule ? rule.notifyKinds : settings.notifyKinds
  return { scope: rule ? 'worktree-rule' : 'default',
    selected: (kind) => kinds === undefined || (Array.isArray(kinds) && kinds.includes(kind)) }
}

function failure(row) {
  return row.mainAgent?.state === 'done' && row.mainAgent.outcome === 'failure'
}

function fingerprint(row) {
  // receivedAtは再配送でも変わるため、Orcaが持つ状態の開始時点を使う。
  const state = row.mainAgent?.state === 'done' ? row.mainAgent : row
  return createHash('sha256').update(JSON.stringify([state.state, state.stateStartedAt, state.outcome ?? null,
    row.state === 'waiting' ? [row.toolName, row.toolInput] : null])).digest('hex')
}

function exclusion(snapshot) {
  if (!snapshot) return 'unavailable'
  if (snapshot.isWorker || snapshot.agent.parentPaneKey) return 'worker'
  if (snapshot.agent.sessionBoundary === true && !failure(snapshot.agent)) return 'session-boundary'
  if (snapshot.agent.state === 'waiting' && snapshot.agent.mainAgent &&
      !['waiting', 'blocked'].includes(snapshot.agent.mainAgent.state) && !failure(snapshot.agent)) return 'child-waiting'
  if (snapshot.agent.state === 'working' && !failure(snapshot.agent)) return 'working'
  return null
}

function directKind(row) {
  if (failure(row)) return 'failure'
  if (row.state === 'blocked') return 'needs_user'
  if (row.state === 'waiting') {
    return row.toolName && !QUESTION.test(row.toolName) ? 'approval' : 'needs_user'
  }
  return null
}

export function createController(deps) {
  const pending = new Map()
  let stopped = false

  const record = (event, result) => {
    // 本文、toolInput、資格情報は記録しない。
    deps.log({ paneKey: event.paneKey, ...result })
    return result
  }

  async function evaluate(event, signal) {
    try {
      let settings = await deps.getSettings()
      if (!includesWorktree(settings, event)) return { notify: false, reason: 'outside-worktree-scope' }
      await (deps.wait ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(settings.quietMs ?? 5000, signal)
      if (signal.aborted) return { notify: false, reason: 'resumed' }
      const before = await deps.readSnapshot(event, signal)
      const excluded = exclusion(before)
      if (excluded) return record(event, { notify: false, reason: excluded })
      const row = before.agent
      if (row.state !== event.state && !failure(row)) return record(event, { notify: false, reason: 'resumed' })
      const identity = fingerprint(row)
      settings = await deps.getSettings()
      if (!includesWorktree(settings, event)) return { notify: false, reason: 'outside-worktree-scope' }
      let dryRun = settings.dryRun !== false
      const key = createHash('sha256').update(JSON.stringify([event.worktreeId, event.paneKey, dryRun,
        settings.classificationEnabled === true])).digest('hex')
      if ((await deps.load(key))?.fingerprint === identity) {
        return { notify: false, reason: 'duplicate' }
      }
      if (signal.aborted) return { notify: false, reason: 'resumed' }

      let kind = directKind(row)
      let classification = {}
      if (!kind) {
        settings = await deps.getSettings()
        if (!includesWorktree(settings, event)) return { notify: false, reason: 'outside-worktree-scope' }
        if (!CLASSIFIED_KINDS.some(allowedKinds(settings, before.worktree).selected)) {
          // 分類結果がどれも通知対象にならないworktreeでは、本文を外部へ送らない。
          classification = { classifier: 'skipped-kinds', state: null }
        } else if (row.lastAssistantMessage?.trim()) {
          try { classification = await deps.classify(row, signal, settings) }
          catch { classification = { classifier: 'failed', state: null } }
        } else {
          classification = { classifier: 'no-message', state: null }
        }
        kind = ['completed', 'needs_user', 'waiting'].includes(classification.state)
          ? classification.state : 'unclassified'
      }
      if (signal.aborted) return { notify: false, reason: 'resumed' }
      const after = await deps.readSnapshot(event, signal)
      if (signal.aborted || exclusion(after) || fingerprint(after.agent) !== identity) {
        return record(event, { notify: false, reason: 'resumed' })
      }
      settings = await deps.getSettings()
      if (!includesWorktree(settings, event)) return { notify: false, reason: 'outside-worktree-scope' }
      dryRun = settings.dryRun !== false
      if (signal.aborted) return { notify: false, reason: 'resumed' }
      const allowed = allowedKinds(settings, after.worktree)
      const selected = allowed.selected(kind)
      const result = { notify: kind !== 'waiting' && selected, kind, dryRun, notifyScope: allowed.scope,
        classifier: classification.classifier ?? 'status',
        messageLength: classification.messageLength ?? row.lastAssistantMessage?.length ?? 0,
        messageSource: classification.messageSource ?? 'status',
        missingFields: ['sessionBoundary', 'background_tasks', 'mainAgent']
          .filter((field) => !Object.hasOwn(row, field)) }
      if (kind === 'waiting') result.reason = 'waiting'
      else if (!selected) result.reason = 'disabled-kind'
      if (classification.messageReadError) result.messageReadError = classification.messageReadError
      if (result.notify && !dryRun) {
        let body = kind === 'approval' ? row.toolInput || row.toolName : row.lastAssistantMessage
        if (classification.classifier === 'skipped-secret') body = ''
        const delivered = await deps.deliver({
          title: `${before.worktree.displayName} - ${row.agentType ?? 'Agent'} ${LABELS[kind]}`.slice(0, 120),
          body: (body || 'ユーザーの操作を待っています').replace(/\s+/g, ' ').slice(0, 300),
          target: { worktreeId: event.worktreeId, paneKey: event.paneKey },
        })
        if (delivered?.delivered !== true) {
          return record(event, { notify: false, reason: 'delivery-failed' })
        }
      }
      // API失敗は送信済みにせず、次の状態イベントで再試行できるようにする。
      await deps.save(key, { fingerprint: identity, ...result, recordedAt: Date.now() })
      return record(event, result)
    } catch (error) {
      if (signal.aborted) return { notify: false, reason: 'resumed' }
      return record(event, { notify: false, reason: 'unavailable', error: error.code ?? error.name })
    }
  }

  return {
    handleEvent(event) {
      if (stopped) return Promise.resolve({ notify: false, reason: 'stopped' })
      if (!event || typeof event.worktreeId !== 'string' || typeof event.paneKey !== 'string' || !STATES.has(event.state)) {
        return Promise.resolve({ notify: false, reason: 'invalid-event' })
      }
      const key = JSON.stringify([event.worktreeId, event.paneKey])
      const previous = pending.get(key)
      if (event.state === 'working' && !failure(event)) {
        previous?.abort.abort()
        pending.delete(key)
        return Promise.resolve({ notify: false, reason: 'working' })
      }
      const signature = JSON.stringify([event.state, event.mainAgent ?? null])
      if (previous?.signature === signature) return previous.promise
      previous?.abort.abort()
      const item = { abort: new AbortController(), signature }
      pending.set(key, item)
      item.promise = evaluate(event, item.abort.signal).finally(() => {
        if (pending.get(key) === item) pending.delete(key)
      })
      return item.promise
    },
    cancelPending() {
      for (const item of pending.values()) item.abort.abort()
      pending.clear()
    },
    stop() {
      stopped = true
      for (const item of pending.values()) item.abort.abort()
      pending.clear()
    },
  }
}
