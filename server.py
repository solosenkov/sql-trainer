#!/usr/bin/env python3
"""SQL-тренажёр — единый сервер на стандартной библиотеке.

Раздаёт статику из frontend/ и реализует API /api/*.
Только stdlib: http.server, sqlite3, json, urllib, re, os, sys, argparse.
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --- Пути относительно расположения server.py ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "db", "trainer.db")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

# --- Константы уровней (названия + fallback количества) ---
LEVELS_META = [
    {"level": 1, "title": "Уровень 1: Основы SELECT", "fallback": 15},
    {"level": 2, "title": "Уровень 2: JOIN и агрегаты", "fallback": 17},
    {"level": 3, "title": "Уровень 3: Подзапросы и оконные функции", "fallback": 13},
]

TABLE_NAMES = ["products", "orders", "employees", "categories", "customers", "reviews"]

# Слова, запрещённые в пользовательском SQL (только SELECT/WITH разрешены)
FORBIDDEN_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|"
    r"REPLACE|TRUNCATE|GRANT|REVOKE|CALL|EXECUTE|HANDLER|LOAD_EXTENSION)\b",
    re.IGNORECASE,
)
LIMIT_RE = re.compile(r"\bLIMIT\b", re.IGNORECASE)
ORDER_BY_RE = re.compile(r"\bORDER\s+BY\b", re.IGNORECASE)


# ---------- Вспомогательные функции для SQL ----------

def strip_comments(sql: str) -> str:
    """Убрать -- комментарии и /* ... */ с учётом строковых литералов."""
    res = []
    i, n = 0, len(sql)
    state = None  # None, "'", '"', '`'
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if state is None:
            if ch == "-" and nxt == "-":
                # до конца строки
                while i < n and sql[i] != "\n":
                    i += 1
                continue
            if ch == "/" and nxt == "*":
                i += 2
                while i < n and not (sql[i] == "*" and i + 1 < n and sql[i + 1] == "/"):
                    i += 1
                i += 2
                continue
            if ch in ("'", '"', "`"):
                state = ch
                res.append(ch)
                i += 1
                continue
            res.append(ch)
            i += 1
        else:
            res.append(ch)
            if ch == state:
                # в SQL '' внутри '...' — экранирование удвоением кавычки
                if i + 1 < n and sql[i + 1] == state and state == "'":
                    res.append(state)
                    i += 2
                    continue
                state = None
            i += 1
    return "".join(res)


def sql_code(sql):
    return re.sub(r"'(''|[^'])*'|\"(\"\"|[^\"])*\"|`[^`]*`", lambda m: " " * len(m.group()), sql)


def check_safety(sql: str):
    if not isinstance(sql, str) or len(sql) > 16000:
        return False, "Запрос должен быть текстом не длиннее 16000 символов."
    cleaned = strip_comments(sql).strip().removesuffix(";").strip()
    code = sql_code(cleaned)
    if not re.match(r"^\s*(SELECT|WITH)\b", code, re.I) or ";" in code or FORBIDDEN_RE.search(code) or re.search(r"\b(RECURSIVE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b", code, re.I):
        return False, "Разрешён один SELECT или WITH ... SELECT, без изменения данных и рекурсии."
    return True, ""


def ordered(sql):
    code = sql_code(strip_comments(sql))
    depth = 0
    for i, ch in enumerate(code):
        if ch == "(": depth += 1
        if ch == ")": depth -= 1
        if depth == 0 and (i == 0 or not (code[i-1].isalnum() or code[i-1] == "_")) and re.match(r"ORDER\s+BY\b", code[i:], re.I): return True
    return False


def ensure_limit(sql: str) -> str:
    """Обрезать user SQL до 100 строк, если нет LIMIT.

    Возвращает обёрнутый запрос вида SELECT * FROM (<sql>) LIMIT 100.
    """
    cleaned = strip_comments(sql).strip()
    if cleaned.endswith(";"):
        cleaned = cleaned[:-1].strip()
    if LIMIT_RE.search(cleaned):
        return cleaned
    return f"SELECT * FROM ({cleaned}) AS _user_wrapped LIMIT 100"


def get_ro_connection():
    """Read-only соединение с БД."""
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5.0)


def execute_limited(conn: sqlite3.Connection, sql: str, timeout_sec: float = 5.0):
    """Выполнить SQL с таймаутом ~5с. Возвращает (columns, rows)."""
    deadline = time.time() + timeout_sec

    def _handler():
        if time.time() > deadline:
            return 1
        return 0

    try:
        conn.set_progress_handler(_handler, 1000)
    except Exception:
        pass
    try:
        cur = conn.cursor()
        cur.execute(sql)
        columns = [d[0] for d in cur.description] if cur.description else []
        rows = cur.fetchall()
        return columns, rows
    finally:
        try:
            conn.set_progress_handler(None, 0)
        except Exception:
            pass


def canonical_value(v):
    """Каноническое представление значения для сравнения."""
    if v is None:
        return ("null", 0)
    if isinstance(v, bool):
        return ("num", float(int(v)))
    if isinstance(v, (int, float)):
        return ("num", round(float(v), 6))
    s = str(v).strip()
    # Числовые строки сравниваем как числа (допуск на float)
    try:
        # пробуем int, затем float
        if re.fullmatch(r"[+-]?\d+", s):
            return ("num", round(float(s), 6))
        f = float(s)
        return ("num", round(f, 6))
    except (ValueError, OverflowError):
        return ("str", s)


def values_equal(a, b) -> bool:
    """Сравнение двух значений: None строго, числа с допуском 1e-6, иначе как строки."""
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    ca, cb = canonical_value(a), canonical_value(b)
    if ca[0] == "num" and cb[0] == "num":
        return abs(ca[1] - cb[1]) < 1e-6
    return ca == cb


def rows_equal(expected_rows, user_rows, strict_order: bool) -> bool:
    """Сравнить наборы строк. Мягко к именам колонок: сравниваем только данные."""
    if len(expected_rows) != len(user_rows):
        return False
    if not expected_rows and not user_rows:
        return True
    if strict_order:
        for er, ur in zip(expected_rows, user_rows):
            if len(er) != len(ur):
                return False
            if not all(values_equal(a, b) for a, b in zip(er, ur)):
                return False
        return True
    # Без ORDER BY — как мультимножества
    def _key(row):
        parts = []
        for v in row:
            c = canonical_value(v)
            parts.append(f"{c[0]}:{c[1]}")
        return "\x1f".join(parts)

    exp_keys = sorted(_key(r) for r in expected_rows)
    usr_keys = sorted(_key(r) for r in user_rows)
    if len(exp_keys) != len(usr_keys):
        return False
    # Числа уже округлены до 6 знаков в ключе, строковое сравнение ключей достаточно.
    # Для надёжности допуска перепроверим попарно через values_equal жадным матчингом.
    used = [False] * len(user_rows)
    for er in expected_rows:
        found = False
        for j, ur in enumerate(user_rows):
            if used[j]:
                continue
            if len(er) != len(ur):
                continue
            if all(values_equal(a, b) for a, b in zip(er, ur)):
                used[j] = True
                found = True
                break
        if not found:
            return False
    return True


# ---------- HTTP-обработчик ----------

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml; charset=utf-8",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "SQLTrainer/1.0"

    # --- Утилиты ответа ---

    def log_message(self, fmt, *args):
        # Логи в консоль на русском
        sys.stdout.write("Запрос: %s - %s\n" % (self.address_string(), fmt % args))

    def send_json(self, obj, status: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text: str, status: int = 400):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- Маршрутизация ---

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        print(f"GET {self.path}")
        if path == "/":
            # Редирект / на /index.html
            self.send_response(302)
            self.send_header("Location", "/index.html")
            self.end_headers()
            return
        if path.startswith("/api/"):
            self.handle_api_get(path, query)
            return
        self.serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        print(f"POST {self.path}")
        if path == "/api/query":
            self.handle_query()
            return
        if path == "/api/check":
            self.handle_check()
            return
        self.send_json({"error": "Неизвестный API-метод"}, status=404)

    # --- Статика ---

    def serve_static(self, path: str):
        rel = urllib.parse.unquote(path.lstrip("/"))
        # Защита от выхода за пределы frontend/
        safe = os.path.normpath(rel)
        if safe.startswith("..") or os.path.isabs(safe):
            self.send_json({"error": "Файл не найден"}, status=404)
            return
        full = os.path.join(FRONTEND_DIR, safe)
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            self.send_json({"error": "Файл не найден"}, status=404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        if ctype.startswith("text/") or ctype.startswith("application/"):
            if "charset" not in ctype:
                ctype += "; charset=utf-8"
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            self.send_json({"error": "Не удалось прочитать файл"}, status=500)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- API: GET ---

    def handle_api_get(self, path: str, query: dict):
        if path == "/api/levels":
            self.api_levels()
        elif path == "/api/exercises":
            level = query.get("level", [None])[0]
            self.api_exercises_list(level)
        elif path.startswith("/api/exercises/"):
            try:
                ex_id = int(path.rsplit("/", 1)[-1])
            except ValueError:
                self.send_json({"error": "Некорректный id задания"}, status=400)
                return
            self.api_exercise_detail(ex_id)
        elif path == "/api/schema":
            self.api_schema()
        else:
            self.send_json({"error": "Неизвестный API-метод"}, status=404)

    def api_levels(self):
        """Три уровня с подсчётом заданий (COUNT по exercises, fallback 10/12/8)."""
        try:
            conn = get_ro_connection()
            try:
                cur = conn.cursor()
                counts = {}
                try:
                    cur.execute("SELECT level, COUNT(*) FROM exercises GROUP BY level")
                    for lvl, cnt in cur.fetchall():
                        counts[int(lvl)] = int(cnt)
                except sqlite3.Error:
                    counts = {}
                # Если БД пуста — fallback на константы
                total = sum(counts.values())
                result = []
                for meta in LEVELS_META:
                    c = counts.get(meta["level"], 0)
                    if total == 0:
                        c = meta["fallback"]
                    result.append({"level": meta["level"], "title": meta["title"], "count": c})
                self.send_json(result)
            finally:
                conn.close()
        except sqlite3.Error as e:
            self.send_json({"error": f"Ошибка базы данных: {e}"}, status=500)

    def api_exercises_list(self, level):
        if level is None:
            self.send_json({"error": "Параметр level обязателен"}, status=400)
            return
        try:
            level_n = int(level)
        except ValueError:
            self.send_json({"error": "Параметр level должен быть числом"}, status=400)
            return
        try:
            conn = get_ro_connection()
            try:
                conn.row_factory = sqlite3.Row
                cur = conn.cursor()
                try:
                    cur.execute(
                        "SELECT id, level, order_in_level, title, is_active "
                        "FROM exercises WHERE level = ? ORDER BY order_in_level, id",
                        (level_n,),
                    )
                    rows = [dict(r) for r in cur.fetchall()]
                except sqlite3.Error as e:
                    # Нет таблицы — пустой список
                    print(f"Ошибка списка заданий: {e}")
                    rows = []
                self.send_json(rows)
            finally:
                conn.close()
        except sqlite3.Error as e:
            self.send_json({"error": f"Ошибка базы данных: {e}"}, status=500)

    def table_info(self, conn, name: str):
        """Описание таблицы: columns + sample (первые 3 строки)."""
        cur = conn.cursor()
        cur.execute(f'PRAGMA table_info("{name}")')
        cols = [{"name": r[1], "type": r[2] or ""} for r in cur.fetchall()]
        sample = []
        if cols:
            cur.execute(f'SELECT * FROM "{name}" LIMIT 3')
            sample = [list(r) for r in cur.fetchall()]
        return {"name": name, "columns": cols, "sample": sample}

    def api_exercise_detail(self, ex_id: int):
        try:
            conn = get_ro_connection()
            try:
                conn.row_factory = sqlite3.Row
                cur = conn.cursor()
                cur.execute("SELECT * FROM exercises WHERE id = ?", (ex_id,))
                row = cur.fetchone()
                if row is None:
                    self.send_json({"error": "Задание не найдено"}, status=404)
                    return
                obj = dict(row)
                # Только таблицы, упомянутые в эталонном запросе (иначе — все).
                # Так экран задания не перегружен лишними схемами.
                expected = obj.get("expected_sql") or ""
                mentioned = [
                    t for t in TABLE_NAMES
                    if re.search(r"\b" + re.escape(t) + r"\b", expected, re.IGNORECASE)
                ]
                tables = []
                for t in mentioned or TABLE_NAMES:
                    try:
                        tables.append(self.table_info(conn, t))
                    except sqlite3.Error as e:
                        print(f"Не удалось прочитать таблицу {t}: {e}")
                obj["tables"] = tables
                self.send_json(obj)
            finally:
                conn.close()
        except sqlite3.Error as e:
            self.send_json({"error": f"Ошибка базы данных: {e}"}, status=500)

    def api_schema(self):
        try:
            conn = get_ro_connection()
            try:
                cur = conn.cursor()
                result = []
                for t in TABLE_NAMES:
                    try:
                        cur.execute(f'PRAGMA table_info("{t}")')
                        cols = [{"name": r[1], "type": r[2] or ""} for r in cur.fetchall()]
                        if not cols:
                            continue
                        cur.execute(f'SELECT COUNT(*) FROM "{t}"')
                        cnt = cur.fetchone()[0]
                        result.append({"name": t, "columns": cols, "sampleCount": int(cnt)})
                    except sqlite3.Error as e:
                        print(f"Не удалось прочитать схему {t}: {e}")
                self.send_json(result)
            finally:
                conn.close()
        except sqlite3.Error as e:
            self.send_json({"error": f"Ошибка базы данных: {e}"}, status=500)

    # --- API: POST /api/check ---

    def handle_query(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 24000: raise ValueError("Слишком большой запрос")
            data = json.loads(self.rfile.read(length))
            sql = data.get("sql", "")
            ok, message = check_safety(sql)
            if not ok: raise ValueError(message)
            sql = strip_comments(sql).strip().removesuffix(";").strip()
            conn = get_ro_connection()
            try:
                cur = conn.execute("SELECT * FROM (" + sql + ") LIMIT 101")
                columns = [c[0] for c in cur.description]
                rows = [list(row) for row in cur.fetchall()]
                self.send_json({"success": True, "columns": columns, "rows": rows[:100], "row_count": min(len(rows),100), "truncated": len(rows)>100})
            finally: conn.close()
        except (ValueError, sqlite3.Error, AttributeError) as error:
            self.send_json({"success": False, "message": str(error)}, status=400)

    def handle_check(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            data = json.loads(raw.decode("utf-8") if raw else "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json({"success": False, "message": "Некорректный JSON в теле запроса.",
                            "user_columns": [], "user_rows": [], "row_count": 0}, status=400)
            return
        exercise_id = data.get("exercise_id")
        user_sql = data.get("sql", "")
        if not isinstance(exercise_id, int):
            try:
                exercise_id = int(exercise_id)
            except (TypeError, ValueError):
                self.send_json({"success": False, "message": "Поле exercise_id обязательно и должно быть числом.",
                                "user_columns": [], "user_rows": [], "row_count": 0}, status=400)
                return
        if not isinstance(user_sql, str) or not user_sql.strip():
            self.send_json({"success": False, "message": "Пустой запрос. Введите SELECT-запрос.",
                            "user_columns": [], "user_rows": [], "row_count": 0})
            return

        # а) Проверка безопасности
        ok, msg = check_safety(user_sql)
        if not ok:
            print(f"Отклонён небезопасный запрос (задание {exercise_id}): {msg}")
            self.send_json({"success": False, "message": msg,
                            "user_columns": [], "user_rows": [], "row_count": 0})
            return

        # Эталон из БД
        try:
            conn = get_ro_connection()
        except sqlite3.Error as e:
            self.send_json({"success": False, "message": f"Ошибка базы данных: {e}",
                            "user_columns": [], "user_rows": [], "row_count": 0}, status=500)
            return
        try:
            cur = conn.cursor()
            cur.execute("SELECT expected_sql FROM exercises WHERE id = ?", (exercise_id,))
            r = cur.fetchone()
            if r is None:
                self.send_json({"success": False, "message": "Задание не найдено.",
                                "user_columns": [], "user_rows": [], "row_count": 0}, status=404)
                return
            expected_sql = r[0]

            # б) Выполнение эталона и пользовательского запроса
            try:
                exp_columns, exp_rows = execute_limited(conn, expected_sql)
            except sqlite3.Error as e:
                print(f"Ошибка в эталоне задания {exercise_id}: {e}")
                self.send_json({"success": False, "message": f"Ошибка эталона задания: {e}",
                                "user_columns": [], "user_rows": [], "row_count": 0}, status=500)
                return
            user_sql_limited = ensure_limit(user_sql)
            try:
                user_columns, user_rows = execute_limited(conn, user_sql_limited)
            except sqlite3.Error as e:
                print(f"Ошибка в запросе пользователя: {e}")
                self.send_json({"success": False, "message": f"Ошибка в запросе: {e}",
                                "user_columns": [], "user_rows": [], "row_count": 0})
                return

            # в) Сравнение
            user_rows_list = [list(r) for r in user_rows]
            exp_rows_list = [list(r) for r in exp_rows]

            # Число колонок должно совпасть
            if len(user_columns) != len(exp_columns) or (exercise_id >= 31 and user_columns != exp_columns):
                self.send_json({"success": False, "message": "❌ Неверно. Попробуй ещё раз.",
                                "user_columns": user_columns, "user_rows": user_rows_list,
                                "row_count": len(user_rows_list)})
                return
            # Пустой результат при непустом эталоне
            if not user_rows_list and exp_rows_list:
                self.send_json({"success": False, "message": "❌ Неверно. Попробуй ещё раз.",
                                "user_columns": user_columns, "user_rows": [],
                                "row_count": 0})
                return
            strict = ordered(expected_sql)
            matched = rows_equal(exp_rows_list, user_rows_list, strict)

            # г) Сообщения строго на русском
            if matched:
                print(f"Задание {exercise_id}: верно")
                self.send_json({"success": True, "message": "✅ Верно! Задание выполнено.",
                                "user_columns": user_columns, "user_rows": user_rows_list,
                                "row_count": len(user_rows_list)})
            else:
                print(f"Задание {exercise_id}: неверно")
                self.send_json({"success": False, "message": "❌ Неверно. Попробуй ещё раз.",
                                "user_columns": user_columns, "user_rows": user_rows_list,
                                "row_count": len(user_rows_list)})
        finally:
            conn.close()


def main():
    # 1. Проверка наличия БД
    if not os.path.isfile(DB_PATH):
        print("Сначала запустите: python3 db/seed.py", file=sys.stderr)
        sys.exit(1)

    parser = argparse.ArgumentParser(description="SQL-тренажёр: локальный сервер")
    parser.add_argument("--port", type=int, default=8000, help="Порт сервера (по умолчанию 8000)")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Сервер запущен: http://localhost:{args.port}")
    print(f"База данных: {DB_PATH}")
    print("Для остановки нажмите Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")


if __name__ == "__main__":
    main()
