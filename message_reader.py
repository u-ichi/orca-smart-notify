"""Orcaのpreviewで省略された、対象sessionの最終本文だけを読む。"""
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
import time

ECMA_SPACE = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
class MessageReadError(ValueError):
    """本文を含まない固定の取得失敗理由。"""


LINKAGE = ("agentId", "parentAgentId", "providerParentRef", "producerKind", "attempt")


def preview(text, native=False):
    """v1.4.216の状態投影と同じ改行・UTF-16上限で比較する。"""
    limit = 200 if native else 8000
    if native:
        raw = text.encode("utf-16-le")[:(limit * 8 + 64) * 2]
        value = raw.decode("utf-16-le", errors="surrogatepass").lstrip(ECMA_SPACE)
        value = re.sub(r"[\r\n\u2028\u2029]+", " ", value)
        if len(value.encode("utf-16-le", errors="surrogatepass")) < limit * 2:
            value = value.rstrip(ECMA_SPACE)
    else:
        value = re.sub(r"\n{3,}", "\n\n", re.sub(r"\r\n?|[\u2028\u2029]", "\n", text.strip(ECMA_SPACE)))
    return value.encode("utf-16-le", errors="surrogatepass")[:limit * 2].decode("utf-16-le", errors="ignore")


def data_path(settings):
    if settings.get("orcaDataPath"):
        return Path(settings["orcaDataPath"]).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/orca"
    raise MessageReadError("orcaDataPath required")


def reduce_messages(rows):
    """本文・turn・利用者境界だけを復元する。tool出力は通知分類に使わない。"""
    items, revisions, aliases, settlements = {}, {}, {}, set()
    active_bodies, boundary = set(), -1
    row_factory = rows if callable(rows) else lambda: iter(rows)
    for row in row_factory():
        if row["kind"] == "dispatch" and row.get("state") == "accepted" and row.get("providerItemId"):
            aliases[row["providerItemId"]] = "@" + row["clientMessageId"]

    def apply(item, outer):
        nonlocal boundary
        key = aliases.get(item["itemId"], item["itemId"])
        revision = item["revision"]
        if revision <= revisions.get(key, -1):
            return
        revisions[key] = revision
        if item["kind"] == "tombstone":
            items.pop(key, None)
            active_bodies.discard(key)
            return
        old = items.get(key, {})
        def linkage_of(value):
            return {field: value[field] for field in LINKAGE if
                    (type(value.get(field)) is int if field == 'attempt' else
                     isinstance(value.get(field), str) and bool(value[field]))}
        linkage = linkage_of(item) or linkage_of(outer)
        if not linkage:
            linkage = old.get("linkage", {})
        items[key] = {"body": old["body"] if key.startswith("@") and old else item["body"],
                      "sequence": old.get("sequence", outer["seq"]), "linkage": linkage,
                      "recoveredAt": outer["ts"] if outer.get("recovered") else None}
        current = items[key]
        if current['body'].get('kind') == 'message':
            if current['body'].get('role') == 'user' and current['linkage'].get('agentId') is None:
                boundary = max(boundary, current['sequence'])
                for previous in list(active_bodies):
                    if previous in items and items[previous]['sequence'] < boundary:
                        items[previous]['body'] = {**items[previous]['body'], 'blocks': []}
                        active_bodies.discard(previous)
            if current['sequence'] < boundary:
                current['body'] = {**current['body'], 'blocks': []}
            else:
                active_bodies.add(key)

    for row in row_factory():
        if row.get("v") not in (1, 2, 3):
            raise MessageReadError("unsupported journal row")
        kind = row["kind"]
        if kind in ("item", "tombstone"):
            apply(row, row)
        elif kind == "submission":
            apply({"kind": "item", "itemId": "@" + row["clientMessageId"], "revision": 0, "body": row["body"]}, row)
        elif kind == "lifecycle-batch" and row["settlementId"] not in settlements:
            settlements.add(row["settlementId"])
            for mutation in row["mutations"]:
                apply(mutation, row)
        elif kind not in ("epoch", "dispatch", "lifecycle-batch"):
            raise MessageReadError("unsupported journal kind")
    return sorted(items.values(), key=lambda item: item["sequence"])


def journal_message(row, settings):
    match = re.fullmatch(r"structured-agent-session-([^:]+):([a-f0-9-]+)", row["paneKey"])
    if not match:
        raise MessageReadError("invalid structured pane")
    session = match[1]
    digest = hashlib.sha256(session.encode()).hexdigest()
    leaf = f"{digest[:8]}-{digest[8:12]}-4{digest[13:16]}-a{digest[17:20]}-{digest[20:32]}"
    if match[2] != leaf:
        raise MessageReadError("session identity mismatch")
    workspace = hashlib.sha256(row["worktreeId"].encode()).hexdigest()[:32]
    path = data_path(settings) / "agent-session-journal" / workspace / digest[:32] / "journal.db"
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=2) as db:
        db.execute("BEGIN")
        if db.execute("PRAGMA user_version").fetchone()[0] != 2:
            raise MessageReadError("unsupported journal database")
        if db.execute("SELECT 1 FROM journal_repairs WHERE session_id=?", (session,)).fetchone():
            raise MessageReadError("journal repair pending")
        epoch = db.execute("SELECT epoch FROM journal_sessions WHERE session_id=?", (session,)).fetchone()
        if not epoch:
            raise MessageReadError("session unavailable")
        # 同一session・現epochだけを読む。本文に関係しないtool出力はSQL境界で除く。
        deadline = time.monotonic() + 5
        def rows():
            cursor = db.execute("""SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=?
                AND (json_extract(row_json,'$.kind') != 'item'
                  OR json_extract(row_json,'$.v') NOT IN (1,2,3)
                  OR json_extract(row_json,'$.body.kind') IN ('message','turn','status')) ORDER BY seq""", (session, epoch[0]))
            while page := cursor.fetchmany(128):
                if time.monotonic() > deadline:
                    raise MessageReadError("journal read timeout")
                for record in page:
                    yield json.loads(record[0])
        # 行数で利用寿命を制限しない。短いpageと実時間で読取を区切る。
        items = reduce_messages(rows)
    turns = [item for item in items if item["body"].get("kind") == "turn" or item["body"].get("turnLifecycle")]
    if not turns:
        raise MessageReadError("turn unavailable")
    last = turns[-1]
    turn = last["body"].get("turnLifecycle", last["body"])
    if turn.get("state") == "running" or (last["recoveredAt"] or turn.get("completedAt")) != row.get("stateStartedAt"):
        raise MessageReadError("turn changed")
    for item in reversed(items):
        body = item["body"]
        if item["linkage"].get("agentId") is not None or body.get("kind") != "message":
            continue
        if body.get("role") == "user":
            break
        if body.get("role") == "assistant":
            text = "\n".join(block["text"] for block in body["blocks"] if block.get("type") == "text")
            if text.strip():
                if preview(text, True) != row.get("lastAssistantMessage", ""):
                    raise MessageReadError("preview mismatch")
                return text
    raise MessageReadError("message unavailable")


def prose(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(block["text"] for block in content if isinstance(block, dict)
                         and block.get("type") in ("text", "Text", "output_text", "input_text")
                         and isinstance(block.get("text"), str))
    return ""


def transcript_message(row, settings):
    path = Path(settings["lastStatusFilePath"]).expanduser() if settings.get("lastStatusFilePath") else data_path(settings) / "agent-hooks/last-status.json"
    document = json.loads(path.read_text())
    entry = document.get("entries", {}).get(row["paneKey"], {})
    if document.get("version") != 2 or entry.get("paneKey") != row["paneKey"] or entry.get("worktreeId") != row["worktreeId"] or entry.get("source") != row["agentType"] or entry.get("payload", {}).get("state") != row["state"] or entry.get("evidenceObservedAt", entry.get("receivedAt")) != row["updatedAt"]:
        raise MessageReadError("status observation mismatch")
    session = entry.get("providerSession", {})
    if not session.get("id") or not session.get("transcriptPath"):
        raise MessageReadError("transcript identity unavailable")
    transcript = Path(session["transcriptPath"])
    if not transcript.is_absolute():
        raise MessageReadError("invalid transcript path")
    # Orcaが対象paneへ結び付けた単一ファイルの末尾だけを読む。履歴探索はしない。
    with transcript.open("rb") as stream:
        stream.seek(0, 2)
        offset = max(0, stream.tell() - 2 * 1024 * 1024)
        stream.seek(offset)
        if offset:
            stream.readline()
        lines = stream.read().decode("utf-8").splitlines()
    candidate = ""
    for line in lines:
        if not line.strip():
            continue
        record = json.loads(line)
        kind, text = record.get("type"), ""
        if row["agentType"] == "claude":
            if record.get("sessionId") not in (None, session["id"]):
                raise MessageReadError("transcript session mismatch")
            content = record.get("message", {}).get("content")
            if kind == "user" and prose(content) and not any(record.get(flag) for flag in ("isMeta", "isSynthetic", "isCompactSummary")):
                candidate = ""
            if kind == "assistant":
                text = prose(content)
        elif row["agentType"] == "codex":
            payload = record.get("payload", {})
            if kind == "session_meta" and payload.get("id") != session["id"]:
                raise MessageReadError("transcript session mismatch")
            if kind == "event_msg" and payload.get("type") in ("task_started", "user_message"):
                candidate = ""
            if kind == "response_item" and payload.get("type") == "message":
                # response_itemのuserにはStop hookも入る。新規依頼の境界は上の実イベントで取る。
                if payload.get("role") == "assistant":
                    text = prose(payload.get("content"))
            if kind == "event_msg" and payload.get("type") == "agent_message":
                text = payload.get("message", "")
            if kind == "event_msg" and payload.get("type") == "item_completed":
                item = payload.get("item", {})
                if item.get("type") == "AgentMessage":
                    text = prose(item.get("content"))
        elif row["agentType"] == "grok":
            if kind == "user" and not record.get("synthetic_reason") and not prose(record.get("content")).startswith("<user_info>"):
                candidate = ""
            if kind == "assistant":
                text = prose(record.get("content"))
        else:
            raise MessageReadError("unsupported transcript provider")
        if isinstance(text, str) and text.strip():
            candidate = text
    if not candidate or preview(candidate) != row["lastAssistantMessage"]:
        raise MessageReadError("transcript preview mismatch")
    return candidate

def read_message(row, settings):
    try:
        if row.get("structuredHostOwned"):
            return journal_message(row, settings), "orca-journal"
        # UTF-16の境界でサロゲートを落とす場合、上限到達時でも7999文字になる。
        if len(row.get("lastAssistantMessage", "").encode("utf-16-le")) >= 7999 * 2:
            return transcript_message(row, settings), "transcript"
    except sqlite3.Error as error:
        raise MessageReadError("journal unavailable") from error
    return row.get("lastAssistantMessage", ""), "preview"
