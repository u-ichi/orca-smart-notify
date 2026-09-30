import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function defaultPath() {
  // 動作確認済みのmacOS標準配置。他の配置ではlastStatusFilePathを指定する。
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/orca/agent-hooks/last-status.json')
}

export async function supplementStatus(agent, worktreeId, path = defaultPath()) {
  if (!path || !Number.isFinite(agent.updatedAt)) return agent
  let document
  try { document = JSON.parse(await readFile(path, 'utf8')) }
  catch { return agent }
  const entry = document?.version === 2 ? document.entries?.[agent.paneKey] : null
  if (!entry || entry.paneKey !== agent.paneKey || entry.worktreeId !== worktreeId ||
      entry.payload?.state !== agent.state ||
      (entry.evidenceObservedAt ?? entry.receivedAt) !== agent.updatedAt) return agent

  // 本文やセッション情報はコピーしない。同じ観測の境界・親agentの状態だけで補う。
  const extra = {}
  if (entry.payload.sessionBoundary === true ||
      (entry.source === 'claude' && entry.hookEventName === 'SessionStart')) extra.sessionBoundary = true
  if (!agent.mainAgent && entry.payload.mainAgent) extra.mainAgent = entry.payload.mainAgent
  return { ...agent, ...extra }
}
