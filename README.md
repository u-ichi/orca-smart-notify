# Orca Smart Notify

Get notified when work is finished or your input is needed. Keep background
waits, worker activity, session startup and repeated status updates quiet.

An independent community plugin for [Orca](https://github.com/stablyai/orca).
**No additional agent hooks.** It uses Orca's existing status events, CLI and
local session records. It does not edit Claude, Codex or Grok settings.

## What it notifies

| Situation | Default decision |
|---|---|
| Work completed | Notify |
| An answer, decision or other user action is needed | Notify |
| Tool permission is waiting for approval | Notify after the quiet period |
| The main agent reports a failure | Notify |
| The agent is waiting for a worker or background result | Stay quiet |
| A worker or child agent stops | Stay quiet |
| Work resumes during the quiet period or classification | Cancel the pending notification |
| A session starts, clears or reconnects | Ignore a confirmed session boundary |
| Classification or full-message retrieval fails | Notify as unclassified; do not pretend it completed |

The quiet period is five seconds. The plugin checks the current state again
before sending. Recent stop identities survive plugin restarts; old records
are pruned to keep private storage below Orca's limit.

Use **Notify only when input is needed** to omit ordinary completion alerts.
Use **Include completed work** to restore the default notification types.

## Requirements

- **macOS and local Orca sessions**, tested with Orca **1.4.216**. The plugin
  system and Orca's standard agent status collection must be enabled.
- The `orca` CLI on the plugin worker's PATH, and Python 3. No Python packages
  or npm dependencies are required at runtime.
- At least one classifier: a Typesafe/Jev API key, authenticated Antigravity
  CLI (`agy`), or authenticated Codex CLI (`codex`). You choose which to use.
- Node.js is only needed separately if you want to run the tests.

Claude and Codex terminal sessions, Grok terminal sessions, and Orca's native
Codex chat have been exercised. Other agents can use the shared classifier
input, but their status behavior has not been verified. Linux, Windows and
SSH/remote session storage are not verified in this release.

## Install and enable

1. Open **Orca Settings → Plugins → Install plugin** and enter
   `https://github.com/u-ichi/orca-smart-notify#v0.1.0` as the Git source.
2. Review and enable **Orca Smart Notify**, identifier
   `u-ichi.smart-notify`.
3. Configure an available classifier below. Run **Orca Smart Notify: Enable
   AI classification of final replies** from Orca's command palette.
4. Inspect the plugin logs during a normal task. Initial mode is observation:
   decisions are recorded and notifications are not sent.
5. Disable any previous notifier for the same events, including Orca's built-in
   Agent Task Complete notification if enabled. Then run **Orca Smart Notify:
   Enable notifications**. This prevents duplicate notifications.

**Observe without notifications** stops delivery while retaining classification.
**Disable AI classification** stops new external classification requests; eligible
stops then use the unclassified fallback. Disable the plugin to stop both.
Mode commands cancel pending decisions; requests already sent cannot be recalled.

Notifications use Orca's own delivery system, including Orca Mobile when paired
and configured. OS permissions, focus suppression and Mobile delivery settings
still apply. An API acceptance is not proof that a device displayed an alert.
Click/tap navigation depends on [Orca PR #24041](https://github.com/stablyai/orca/pull/24041)
and is not claimed for Orca 1.4.216.

## Classifiers and settings

The default order is **Jev → Gemini → Codex**, stopping on the first valid result.
Defaults are `jev-1.13.0`, `gemini-3.8-flash-low` and `gpt-5.6-luna`.
Gemini and Codex use their existing CLI sign-in. The Gemini agent definition is
bundled and loaded from a temporary workspace; no global agent installation is needed.

Jev reads `~/.config/typesafe/api-key`, a private file with mode `600`, or
`TYPESAFE_API_KEY` when available. Orca does not generally forward arbitrary
environment variables to plugin workers. No key is included in this repository.

Advanced settings are stored in the plugin's own JSON file on macOS:
`~/Library/Application Support/orca/plugins-data/u-ichi.smart-notify/settings.json`.
Disable the plugin before editing this file, preserve any settings you want to
keep, and enable it again afterwards. For example, use only your Codex sign-in:

```json
{
  "classificationEnabled": true,
  "dryRun": false,
  "classifierBackends": ["codex"],
  "notifyKinds": ["completed", "needs_user", "approval", "failure", "unclassified"]
}
```

| Setting | Purpose |
|---|---|
| `dryRun` | Defaults to `true`; set `false` to deliver |
| `classificationEnabled` | Defaults to `false`; opt in to sending final replies for classification |
| `classifierBackends` | Any nonempty selection of `jev`, `gemini`, `codex`; Jev, if included, must be first |
| `notifyKinds` | Selected notification types from the example above; omit for all, or use `[]` for none |
| `worktreeIds` | Optional exact worktree IDs to observe; omitted means all. Get IDs with `orca worktree list --json` |
| `worktreeRules` | Optional per-worktree notification types selected by display-name prefix; see below |
| `quietMs` | Quiet period, default `5000` milliseconds |
| `jevModel`, `geminiModel`, `codexModel` | Override the corresponding classifier model |
| `typesafeKeyFile` | Alternate private key file; `~` is expanded |
| `orcaCommand`, `pythonCommand`, `agyCommand`, `codexCommand` | Executable name or absolute path; shell command strings are not accepted |
| `orcaDataPath`, `lastStatusFilePath` | Override the standard local Orca data directory or status snapshot path |

`worktreeIds` can limit a comparison trial. Remove it to cover all worktrees.
Orca's `worktree ps` command returns rows for all worktrees; this plugin only
classifies and notifies matching worktrees and does not persist those row bodies.

### Per-worktree notification types

Sessions started by another system (for example a task dispatcher that creates
the worktree and sends the prompts itself) stop at every turn, but that stop is
addressed to the dispatcher, not to you. `worktreeRules` keeps your own sessions
unchanged and limits such worktrees to the types you list:

```json
{
  "worktreeRules": [
    { "displayNamePrefixes": ["Dots: "], "notifyKinds": ["approval"] }
  ]
}
```

- A rule applies when the Orca worktree display name starts with one of the
  listed prefixes. The match is exact and case-sensitive: with the example above,
  `Dots: review PR 42` matches, while `Dots session notes` or `dots: old` do not.
  Add further prefixes only for worktrees that already exist under an older name.
- The first matching rule replaces `notifyKinds` for that worktree. Worktrees
  without a match use the top-level `notifyKinds` as before.
- A rule without both `displayNamePrefixes` and `notifyKinds` arrays is ignored.
- `approval` is produced from Orca's status alone: state `waiting` with a tool
  name that is not a question tool. The plugin cannot tell from that input
  whether a hook had already allowed the command. The distinction comes from the
  agent side: Claude only runs its PermissionRequest/Notification hooks, which
  Orca's hook script forwards, when a permission prompt is actually open, and a
  command allowed by a PreToolUse hook never opens one, so Orca keeps reporting
  `working`. This is read from the current hook scripts and verified in this
  repository with synthetic status fixtures; it has not been confirmed against a
  live permission prompt and notification delivery.
- When none of the classification-only types (`completed`, `needs_user`,
  `unclassified`) are selected for a worktree, the final reply is not sent to
  any classifier. The decision is still logged with classifier `skipped-kinds`.

This setting only filters the notifications this plugin shows to you. It does not
change, acknowledge or consume Orca's `agent.status.changed` events, the agent
status files, the orchestration task/run/dispatch records or any worker
completion evidence, so a dispatcher that reads completion or failure from Orca
keeps receiving them. The plugin does not implement a dispatcher's reconciliation
or state machine, and one of its notifications is not an authorization for a
dispatcher's next step. Whether that dispatcher reports a failure back to you is
its own responsibility; suppressing `failure` here is only appropriate once that
reporting path is connected and confirmed.

## Data handling and compatibility

AI classification sends roughly the first 1,500 and last 4,500 characters of a
long final assistant reply to the selected service. Short replies are sent whole.
The helper checks for obvious secret patterns before sending. This is not a
complete sensitive-data detector. Classifier CLIs and services have their own
logging and retention policies.

Notification bodies may include up to 300 characters of a reply or approval
command. The plugin's logs and private deduplication storage contain hashes,
decision types, classifier names, lengths and timestamps, not reply/command bodies.

Orca 1.4.216 omits session-boundary information from its public event/CLI output.
The plugin reads the existing `agent-hooks/last-status.json` only when pane,
worktree, state and observation time match. It adds no status hook of its own.

Native chat provides only a 200-character preview; terminal status allows up to
8,000 UTF-16 characters. For classification, the plugin reads the identified
native session's SQLite journal, or the exact terminal transcript supplied by a
matching status record when a long reply was clipped. It checks the native turn
completion time and regenerates the preview before accepting the full reply.
It does not scan history directories or include reasoning/tool output.

These readers are compatibility code for Orca 1.4.216's internal storage formats.
Unknown formats, mismatched records and unavailable remote files fall back to
unclassified. A future public full-message API would remove this dependency.
Grok transcripts lack a reliable turn timestamp; their additional checks rely
on the matched status record, final assistant entry and state recheck.

Delivery and storage are not atomic. A crash between delivery and saving can
duplicate an alert; a pending event lost in a crash is not recovered immediately.
The plugin does not claim exactly-once delivery.

## Remove

Disable and uninstall `u-ichi.smart-notify` in Orca Settings → Plugins.
There are no agent-hook registrations or global Gemini definitions to remove.
Orca may retain this plugin's private settings/storage; remove only its own data
directory if you also want to erase preferences and notification history.
Other plugins and agent settings are not changed.

## Development

```sh
npm test
node scripts/probe-worker.mjs "<installed Orca plugin-host-entry.js>"
```

Tests use synthetic sessions and mocked external-provider boundaries. The worker
probe runs Orca's installed worker entry with fixture host/CLI responses; it sends
no real notifications or AI requests. Live classification checks were performed
separately on 2026-09-30, including Gemini and Codex fallbacks and native-chat
message restoration.

Licensed under [MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md)
for Orca compatibility references.
