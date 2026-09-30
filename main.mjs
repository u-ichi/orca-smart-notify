import { createController } from './notification-controller.mjs'
import { createOrcaClient } from './orca-client.mjs'
import { classify } from './classifier.mjs'
import { createNotificationStore } from './notification-store.mjs'

let controller

export default async function activate(orca) {
  const settings = async () => (await orca.host.call('settings.get'))?.settings ?? {}
  const initial = await settings()
  const client = createOrcaClient(initial.orcaCommand, undefined, initial.lastStatusFilePath)
  const store = createNotificationStore((...args) => orca.host.call(...args))
  controller = createController({
    getSettings: settings,
    readSnapshot: client.readSnapshot,
    classify,
    load: store.load,
    save: store.save,
    deliver: (params) => orca.host.call('notifications.show', params),
    log: (record) => orca.log(JSON.stringify(record)),
  })
  // Promiseを返し、判定中にOrcaがworkerをidle終了しないようにする。
  orca.events.on('agent.status.changed', (event) => controller.handleEvent(event))
  orca.commands.register('u-ichi.smart-notify.status', async () => ({
    ...(await settings()), defaultMode: 'observe',
  }))
  const update = async (key, value) => {
    controller.cancelPending()
    try { return await orca.host.call('settings.set', { key, value }) }
    finally { controller.cancelPending() }
  }
  orca.commands.register('u-ichi.smart-notify.observe', () => update('dryRun', true))
  orca.commands.register('u-ichi.smart-notify.notify', () => update('dryRun', false))
  orca.commands.register('u-ichi.smart-notify.classify', () => update('classificationEnabled', true))
  orca.commands.register('u-ichi.smart-notify.no-classify', () => update('classificationEnabled', false))
  orca.commands.register('u-ichi.smart-notify.attention-only', () => update('notifyKinds', ['needs_user', 'approval', 'failure', 'unclassified']))
  orca.commands.register('u-ichi.smart-notify.all-stops', () => update('notifyKinds', ['completed', 'needs_user', 'approval', 'failure', 'unclassified']))
  orca.log('Orca Smart Notify ready: notification and classification are opt-in; no agent hooks installed')
}

export function deactivate() {
  controller?.stop()
}
