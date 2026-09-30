"""公開状態のpreviewで失われる末尾を、同じ停止の記録からだけ補う。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("message_reader", Path(__file__).resolve().parents[1] / "message_reader.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MessageReaderTests(unittest.TestCase):
    def test_tui_long_reply_is_restored_only_from_matching_session_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "transcript.jsonl"
            message = "確認事項です。" * 1200 + "\n最後の選択はAとBのどちらにしますか？"
            for agent, record in [
                ("claude", {"type": "assistant", "sessionId": "session", "message": {"stop_reason": "end_turn", "content": [{"type": "thinking", "thinking": "送らない内部情報"}, {"type": "text", "text": message}]}}),
                ("codex", {"type": "response_item", "payload": {"type": "message", "role": "assistant", "phase": "final", "content": [{"type": "output_text", "text": message}]}}),
                ("grok", {"type": "assistant", "content": [{"type": "text", "text": message}]}),
            ]:
                records = [record]
                if agent == 'codex':
                    records = [{"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}}, record,
                               {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<hook_prompt>停止時の確認</hook_prompt>"}]}},
                               {"type": "response_item", "payload": {"type": "message", "role": "assistant", "phase": "final_answer", "content": []}},
                               {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn", "last_agent_message": None}}]
                path.write_text("\n".join(json.dumps(value) for value in records) + "\n")
                row = {"agentType": agent, "worktreeId": "workspace", "paneKey": "tab:leaf", "state": "done", "updatedAt": 20,
                       "lastAssistantMessage": module.preview(message)}
                entry = {"paneKey": row["paneKey"], "worktreeId": row["worktreeId"], "source": agent, "evidenceObservedAt": 20,
                         "providerSession": {"id": "session", "transcriptPath": str(path)}, "payload": {"state": "done"}}
                status = Path(directory) / "last-status.json"
                status.write_text(json.dumps({"version": 2, "entries": {row["paneKey"]: entry}}))
                text, source = module.read_message(row, {"lastStatusFilePath": str(status)})
                self.assertEqual(text, message)
                self.assertEqual(source, "transcript")
                with self.assertRaises(ValueError):
                    module.read_message({**row, "updatedAt": 30}, {"lastStatusFilePath": str(status)})

    def test_native_latest_revision_keeps_child_identity_and_latest_user_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            sid, wid = "codex_example", "workspace"
            digest = hashlib.sha256(sid.encode()).hexdigest()
            leaf = f"{digest[:8]}-{digest[8:12]}-4{digest[13:16]}-a{digest[17:20]}-{digest[20:32]}"
            path = Path(directory) / "agent-session-journal" / hashlib.sha256(wid.encode()).hexdigest()[:32] / digest[:32] / "journal.db"
            path.parent.mkdir(parents=True)
            db = sqlite3.connect(path)
            db.executescript("PRAGMA user_version=2; CREATE TABLE journal_sessions(session_id TEXT, epoch TEXT); CREATE TABLE journal_rows(session_id TEXT, epoch TEXT, seq INTEGER, ts INTEGER, row_json TEXT); CREATE TABLE journal_repairs(session_id TEXT);")
            db.execute("INSERT INTO journal_sessions VALUES (?,?)", (sid, "current"))
            # Orcaは先頭1664単位だけを走査するため、200文字未満でも末尾が欠ける。
            message = "確認を終えました。" + "\n" * 2000 + "最後に利用者の選択が必要です。どちらにしますか？"
            def body(role, text):
                return {"kind": "message", "role": role, "blocks": [{"type": "text", "text": text}]}
            rows = [
                {"kind": "epoch"},
                *[{"kind": "item", "itemId": f"history-{n}", "revision": 1, "body": body("assistant", "過去の応答です。")}
                  for n in range(10010)],
                {"kind": "item", "itemId": "old", "revision": 1, "body": body("assistant", "古い回答")},
                {"kind": "item", "itemId": "user", "revision": 1, "body": body("user", "確認して")},
                {"kind": "item", "itemId": "turn", "revision": 1, "body": {"kind": "turn", "state": "running", "turnId": "turn", "startedAt": 100}},
                {"kind": "item", "itemId": "answer", "revision": 1, "body": body("assistant", "途中")},
                {"kind": "item", "itemId": "child", "revision": 1, "agentId": "child", "body": body("assistant", "子の結果")},
                {"kind": "item", "itemId": "answer", "revision": 2, "body": body("assistant", message)},
                {"kind": "item", "itemId": "child", "revision": 2, "agentId": None, "body": body("assistant", "子の完了")},
                {"kind": "lifecycle-batch", "settlementId": "end", "mutations": [{"kind": "item", "itemId": "turn", "revision": 2, "body": {"kind": "turn", "turnId": "turn", "state": "completed", "completedAt": 300}}]},
            ]
            for seq, row in enumerate(rows, 1):
                row.update(v=3, seq=seq, ts=seq * 10, epoch="current", fence=1)
                db.execute("INSERT INTO journal_rows VALUES (?,?,?,?,?)", (sid, "current", seq, seq * 10, json.dumps(row)))
            db.commit()
            row = {"paneKey": f"structured-agent-session-{sid}:{leaf}", "worktreeId": wid,
                   "structuredHostOwned": True, "state": "done", "stateStartedAt": 300,
                   "updatedAt": 310, "lastAssistantMessage": "確認を終えました。"}
            text, source = module.read_message(row, {"orcaDataPath": directory})
            self.assertEqual(text, message)
            self.assertEqual(source, "orca-journal")
            with self.assertRaises(ValueError):
                module.read_message({**row, "stateStartedAt": 400}, {"orcaDataPath": directory})
            with self.assertRaises(ValueError):
                module.read_message({**row, "lastAssistantMessage": "別の回答"}, {"orcaDataPath": directory})
            db.close()


if __name__ == "__main__":
    unittest.main()
