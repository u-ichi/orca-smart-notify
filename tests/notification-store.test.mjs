import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotificationStore } from '../notification-store.mjs'

test('長期利用でも記録上限内に収まり、最近の停止は再起動後も重複防止に使える', async () => {
  const values = new Map()
  const key = (n) => n.toString(16).padStart(64, '0')
  for (let n = 0; n < 1024; n++) values.set(key(n), { recordedAt: n, fingerprint: String(n) })
  const call = async (method, params) => {
    if (method === 'storage.keys') return { keys: [...values.keys()] }
    if (method === 'storage.get') return { value: values.get(params.key) ?? null }
    if (method === 'storage.delete') { values.delete(params.key); return { ok: true } }
    assert.ok(values.has(params.key) || values.size < 1024, 'Orcaの保存件数上限を超えた')
    values.set(params.key, params.value)
    return { ok: true }
  }
  const store = createNotificationStore(call)
  await Promise.all([1024, 1025].map((n) => store.save(key(n), { recordedAt: n, fingerprint: String(n) })))
  assert.ok(values.size <= 512)
  assert.equal(await store.load(key(0)), null)
  const restarted = createNotificationStore(call)
  assert.equal((await restarted.load(key(1025))).fingerprint, '1025')
  assert.equal((await restarted.load(key(1023))).fingerprint, '1023')
})
