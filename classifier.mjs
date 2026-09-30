import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./classify.py', import.meta.url))

export async function classify(row, signal, settings = {}) {
  // 観測を始めただけで本文を外部送信しない。利用者が明示的に有効化する。
  if (settings.classificationEnabled !== true) return { classifier: 'disabled', state: null }
  if (signal?.aborted) return { classifier: 'cancelled', state: null }
  return new Promise((resolve, reject) => {
    const child = execFile(settings.pythonCommand ?? 'python3', ['-B', helper], {
      timeout: 55000, maxBuffer: 128 * 1024, signal,
    }, (error, stdout) => {
      if (error) return reject(new Error('Classification helper failed'))
      try {
        const value = JSON.parse(stdout)
        if (!value || ![null, 'completed', 'needs_user', 'waiting'].includes(value.state)) {
          throw new Error('Invalid classifier response')
        }
        resolve(value)
      } catch (failure) { reject(failure) }
    })
    child.stdin.on('error', () => {})
    const options = Object.fromEntries(['classifierBackends', 'jevModel', 'geminiModel', 'codexModel',
      'agyCommand', 'codexCommand', 'typesafeKeyFile', 'orcaDataPath', 'lastStatusFilePath'].filter((key) => settings[key] !== undefined)
      .map((key) => [key, settings[key]]))
    child.stdin.end(JSON.stringify({ agent: row.agentType ?? 'agent', message: row.lastAssistantMessage,
      row: Object.fromEntries(['agentType', 'paneKey', 'worktreeId', 'structuredHostOwned', 'state',
        'stateStartedAt', 'updatedAt', 'lastAssistantMessage'].map((key) => [key, row[key]])), settings: options }))
  })
}
