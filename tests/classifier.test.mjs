import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, copyFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('分類helperを呼んでもインストール済みpluginの内容を変えない', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-notify-immutable-'))
  t.after(() => rm(dir, { recursive: true }))
  const files = ['classifier.mjs', 'classify.py', 'message_reader.py']
  for (const name of files) await copyFile(new URL(`../${name}`, import.meta.url), join(dir, name))
  const { classify } = await import(pathToFileURL(join(dir, 'classifier.mjs')))
  // Orca workerはこの変数を継承しない。repo用test環境の迂回先を試験内だけ外す。
  const cachePrefix = process.env.PYTHONPYCACHEPREFIX
  delete process.env.PYTHONPYCACHEPREFIX
  t.after(() => { if (cachePrefix !== undefined) process.env.PYTHONPYCACHEPREFIX = cachePrefix })
  // 読取不能の合成paneを使い、外部AIへ送信する前の経路を実Pythonで通す。
  const result = await classify({ agentType: 'codex', paneKey: 'invalid', structuredHostOwned: true,
    lastAssistantMessage: '合成メッセージ' }, undefined, { classificationEnabled: true })
  assert.equal(result.classifier, 'message-unavailable')
  assert.deepEqual((await readdir(dir)).sort(), files.sort())
})
