#!/usr/bin/env python3
"""Count internal-text leaks on tool-card error rows in explicit SQLite DBs.

Each messages row with role='tool' has model-facing results in content and full
results in tool_results, paired by toolCallId. Only results with success ===
false and a non-empty error are scanned. A row contributes at most one hit per
category. visible_text is the full result's userMessage when that field is
defined, otherwise result.error; raw_error_hits always uses result.error from
content. DBs are opened read-only and paths below the default data dirs
(~/.code-agent and ~/.code-agent-dev) are refused before opening SQLite.
"""

import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import quote


CATEGORIES = ("internal_tool_name", "raw_json", "injected_prompt")


def build_rules(patterns_path):
    with open(patterns_path, encoding="utf-8") as source:
        patterns = json.load(source)

    # These three category definitions are copied from the 2026-11-14 audit's
    # code-agent-private-archive/docs/research/2026-11-14-neo-human-language-corpus-audit/scan.py.
    names = patterns["internalToolNames"]
    ext = [
        "task_status", "delegate_task", "spawn_agent", "propose_role", "reminders_create", "delegate_session",
        "cancel_task", "list_session_candidates", "list_experts", "calendar_create_event", "mail_draft",
        "browser_action", "docx_generate", "wake_noop", "request_directory", "calendar_delete_event", "steer_task",
        "screenshot_page", "read_pdf", "excel_generate", "terminal_write", "terminal_open", "recommend_capability",
        "ppt_generate", "image_generate", "calendar_update_event", "mail_send", "attempt_completion",
        "ProposeProjectMemory", "ReadDocument", "ExcelAutomate", "ListDirectory", "MemoryRead", "MemoryWrite",
        "MCPUnified", "DocEdit",
    ]
    all_names = sorted(set(names + ext), key=len, reverse=True)
    internal_tool_name = [
        re.compile(patterns["internalToolPrefix"]),
        re.compile(r"(?<![A-Za-z0-9_/-])(?:" + "|".join(all_names) + r")(?![A-Za-z0-9_/-])"),
        re.compile(r"`(?:Bash|Glob|Grep|Read|Write|Edit|MultiEdit|Task|WebFetch|WebSearch|TodoWrite)`"),
        re.compile(r"(?:调用|使用|通过|运行|执行)了?\s*(?:Bash|Glob|Grep|WebFetch|WebSearch|TodoWrite)\s*(?:工具)?"),
    ]
    raw_json = [
        re.compile(r"\{(?:\s*" + patterns["rawJsonKeyValue"] + r"\s*,?){1,}\}"),
        re.compile(r'^\s*\[?\{"[A-Za-z_]+":'),
    ]
    injected_prompt = [
        re.compile(expression)
        for expression in [
            r"<(?:repeated_workarounds|background_capability_stats|failed-run-continuation-context|system-reminder|task-notification|user-directives|session[-_]context|available[-_]skills)>",
            r"你已经在一个独立后台任务槽里", r"禁止调用、搜索或建议 Task", r"\[\[LOOP_WAIT\]\]", r"【循环模式 · 第\d+轮】",
            r"上一轮 agent 运行在完成最终回复前失败", r"^\s*<(?!tool_call)[a-z][a-z_-]{3,}>",
        ]
    ]
    return {
        "internal_tool_name": internal_tool_name,
        "raw_json": raw_json,
        "injected_prompt": injected_prompt,
    }


def resolved(path):
    return Path(path).expanduser().resolve(strict=False)


def is_under(path, directory):
    return path == directory or directory in path.parents


def scan_db(db_path, rules, totals):
    uri = "file:" + quote(str(db_path), safe="/") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        connection.execute("PRAGMA query_only=ON")
        for content, stored_results in connection.execute("SELECT content, tool_results FROM messages WHERE role='tool'"):
            try:
                results = json.loads(content or "")
                display_results = json.loads(stored_results or "[]")
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(results, list):
                continue
            display_by_call = {
                result.get("toolCallId"): result
                for result in display_results
                if isinstance(result, dict)
            } if isinstance(display_results, list) else {}
            for result in results:
                if not isinstance(result, dict) or result.get("success") is not False:
                    continue
                error = result.get("error")
                if not isinstance(error, str) or not error.strip():
                    continue
                display_result = display_by_call.get(result.get("toolCallId"), result)
                visible_text = display_result["userMessage"] if "userMessage" in display_result else error
                totals["rows_scanned"] += 1
                for category in CATEGORIES:
                    category_totals = totals["categories"][category]
                    category_totals["rows_scanned"] += 1
                    if any(rule.search(error) for rule in rules[category]):
                        category_totals["raw_error_hits"] += 1
                    if isinstance(visible_text, str) and any(rule.search(visible_text) for rule in rules[category]):
                        category_totals["visible_hits"] += 1
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--patterns", required=True)
    parser.add_argument("--db", action="append", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    home = Path.home()
    forbidden = [resolved(home / ".code-agent"), resolved(home / ".code-agent-dev")]
    db_paths = [resolved(path) for path in args.db]
    for db_path in db_paths:
        if any(is_under(db_path, directory) for directory in forbidden):
            parser.exit(2, "refusing to open a DB under a default data dir: " + str(db_path) + os.linesep)

    totals = {
        "rows_scanned": 0,
        "categories": {
            category: {"rows_scanned": 0, "raw_error_hits": 0, "visible_hits": 0}
            for category in CATEGORIES
        },
    }
    rules = build_rules(args.patterns)
    for db_path in db_paths:
        scan_db(db_path, rules, totals)

    rendered = json.dumps(totals, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with open(args.out, "w", encoding="utf-8") as output:
        output.write(rendered)
    sys.stdout.write(rendered)


if __name__ == "__main__":
    main()
