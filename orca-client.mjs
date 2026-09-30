import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { supplementStatus } from './orca-status-file.mjs'

const execute = promisify(execFile)
const STATES = new Set(['working', 'waiting', 'blocked', 'done'])

export function createOrcaClient(command = process.platform === 'linux' ? 'orca-ide' : 'orca', run, lastStatusFilePath) {
  const call = run ?? (async (args, signal) => {
    const { stdout } = await execute(command, [...args, '--json'], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024, signal,
      // AgentのRunへの暗黙bindを避ける。plugin workerは元々この情報を継承しない。
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))),
    })
    const receipt = JSON.parse(stdout)
    if (receipt.ok !== true) throw new Error('Orca command failed')
    return receipt.result
  })

  return {
    call,
    async readSnapshot(event, signal) {
      const status = await call(['worktree', 'ps', '--limit', '1000'], signal)
      if (!Array.isArray(status?.worktrees)) throw new Error('Invalid worktree response')
      const worktree = status.worktrees.find((row) => row.worktreeId === event.worktreeId)
      let agent = worktree?.agents?.find((row) => row.paneKey === event.paneKey)
      if (!agent) return null
      if (!STATES.has(agent.state) || !Number.isFinite(agent.stateStartedAt) ||
          (agent.lastAssistantMessage != null && typeof agent.lastAssistantMessage !== 'string')) {
        throw new Error('Invalid agent state')
      }
      // v1.4.216のpsはmainAgentを落とす。同じ観測時点と確認できるイベントだけで補う。
      if (!agent.mainAgent && event.mainAgent && event.state === agent.state &&
          Number.isFinite(agent.updatedAt) && agent.updatedAt === event.receivedAt) {
        agent = { ...agent, mainAgent: event.mainAgent }
      }
      agent = await supplementStatus(agent, worktree.worktreeId, lastStatusFilePath)
      agent = { ...agent, worktreeId: worktree.worktreeId }
      const found = { worktree: { id: worktree.worktreeId, displayName: worktree.displayName }, agent, isWorker: !!agent.parentPaneKey }
      if (found.isWorker || (agent.state === 'working' && agent.mainAgent?.outcome !== 'failure')) return found

      const terminals = await call(['terminal', 'list', '--worktree', `id:${event.worktreeId}`], signal)
      if (!Array.isArray(terminals?.terminals)) throw new Error('Invalid terminal response')
      const handles = new Set(terminals.terminals
        .filter((terminal) => `${terminal.tabId}:${terminal.leafId}` === event.paneKey)
        .map((terminal) => terminal.handle))
      // 構造化chatはPTYを持たず、Orcaが付けた親paneでworkerを判断する。
      // TUIの対応端末が見つからない場合は、workerではないと推測しない。
      if (handles.size === 0) {
        if (agent.structuredHostOwned === true && Object.hasOwn(agent, 'parentPaneKey')) return found
        throw new Error('Target terminal unavailable')
      }
      let cursor
      const seen = new Set()
      do {
        const args = ['orchestration', 'worker-list', '--limit', '100']
        if (cursor) args.push('--cursor', cursor)
        const result = await call(args, signal)
        if (!Array.isArray(result?.workers) || result.scope?.source !== 'all') throw new Error('Incomplete worker scope')
        found.isWorker = result.workers.some((worker) => handles.has(worker.agentTerminalHandle) || handles.has(worker.resource?.terminalHandle))
        if (found.isWorker) break
        cursor = result.page?.nextCursor
        if (cursor && seen.has(cursor)) throw new Error('Repeated worker cursor')
        if (cursor) seen.add(cursor)
      } while (cursor)
      return found
    },
  }
}
