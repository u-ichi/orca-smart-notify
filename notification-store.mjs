export function createNotificationStore(call) {
  let pending = Promise.resolve()
  const load = async (key) => (await call('storage.get', { key }))?.value
  async function save(key, value) {
    const { keys } = await call('storage.keys')
    // 判定記録だけを整理し、Orcaの1024件上限に達する前に余裕を作る。
    const records = keys.filter((candidate) => /^[a-f0-9]{64}$/.test(candidate) && candidate !== key)
    if (records.length >= 512) {
      const dated = await Promise.all(records.map(async (candidate) => [candidate, (await load(candidate))?.recordedAt ?? 0]))
      dated.sort((a, b) => a[1] - b[1])
      for (const [oldKey] of dated.slice(0, records.length - 447)) await call('storage.delete', { key: oldKey })
    }
    return call('storage.set', { key, value })
  }
  return {
    load,
    save(key, value) {
      const result = pending.then(() => save(key, value))
      pending = result.catch(() => {})
      return result
    },
  }
}
