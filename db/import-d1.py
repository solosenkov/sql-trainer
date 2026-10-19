#!/usr/bin/env python3
"""Импорт db/d1-seed.sql в Cloudflare D1 батчами.

D1 не принимает файл целиком через --file (ломается на ';' внутри
строковых литералов), поэтому режем дамп на стейтменты с учётом
одинарных кавычек и шлём батчами через `wrangler d1 execute --command`.
Только стандартная библиотека.
"""
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DUMP_PATH = BASE_DIR / "d1-seed.sql"
DB_NAME = "sql-trainer-db"
# D1 выполняет ровно один стейтмент за вызов, поэтому шлём по одному.
# Дамп d1-seed.sql специально сгенерирован компактно: 7 CREATE + 7 многострочных INSERT.


def split_statements(sql: str):
    """Разбить SQL на стейтменты по ';' вне строковых литералов ('...' с ''-эскейпом)."""
    stmts, buf = [], []
    in_str = False
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if in_str:
            buf.append(ch)
            if ch == "'":
                if i + 1 < n and sql[i + 1] == "'":
                    buf.append("'")
                    i += 2
                    continue
                in_str = False
            i += 1
        else:
            if ch == "'":
                in_str = True
                buf.append(ch)
                i += 1
            elif ch == ";":
                stmt = "".join(buf).strip()
                if stmt:
                    stmts.append(stmt)
                buf = []
                i += 1
            else:
                buf.append(ch)
                i += 1
    tail = "".join(buf).strip()
    if tail:
        stmts.append(tail)
    return stmts


def main() -> None:
    sql = DUMP_PATH.read_text(encoding="utf-8")
    stmts = split_statements(sql)
    print(f"Стейтментов: {len(stmts)}")
    for n, stmt in enumerate(stmts, 1):
        first = stmt.split("\n", 1)[0][:60]
        print(f"[{n}/{len(stmts)}] {first}...", flush=True)
        r = subprocess.run(
            ["wrangler", "d1", "execute", DB_NAME, "--remote", "--command", stmt],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            print(f"ОШИБКА в стейтменте {n}:\n{r.stdout}\n{r.stderr}", file=sys.stderr)
            sys.exit(1)
    print("Импорт завершён.")


if __name__ == "__main__":
    main()
