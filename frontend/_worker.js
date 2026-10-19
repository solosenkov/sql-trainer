// SQL-тренажёр на Cloudflare Pages: единый _worker.js.
//   /api/* -> JSON-хендлеры на D1 (биндинг env.DB),
//   остальное -> статика из env.ASSETS.
// Логика — порт server.py (только SELECT/WITH, лимит 100 строк,
// мягкое сравнение: порядок важен лишь при ORDER BY).

var LEVELS_META = [
  { level: 1, title: "Уровень 1: Основы SELECT", fallback: 15 },
  { level: 2, title: "Уровень 2: JOIN и агрегаты", fallback: 17 },
  { level: 3, title: "Уровень 3: Подзапросы и оконные функции", fallback: 13 }
];

var TABLE_NAMES = ["products", "orders", "employees", "categories", "customers", "reviews"];

// Порядок колонок = порядок в CREATE TABLE.
var TABLE_COLUMNS = {
  products: [["id", "INTEGER"], ["name", "TEXT"], ["category", "TEXT"], ["price", "REAL"], ["stock", "INTEGER"], ["created_at", "TEXT"]],
  orders: [["id", "INTEGER"], ["product_id", "INTEGER"], ["quantity", "INTEGER"], ["order_date", "TEXT"], ["customer_name", "TEXT"]],
  employees: [["id", "INTEGER"], ["name", "TEXT"], ["department", "TEXT"], ["salary", "REAL"], ["hire_date", "TEXT"]],
  categories: [["id", "INTEGER"], ["name", "TEXT"], ["description", "TEXT"]],
  customers: [["id", "INTEGER"], ["name", "TEXT"], ["email", "TEXT"], ["city", "TEXT"], ["registered_at", "TEXT"]],
  reviews: [["id", "INTEGER"], ["product_id", "INTEGER"], ["customer_id", "INTEGER"], ["rating", "INTEGER"], ["review_text", "TEXT"], ["created_at", "TEXT"]]
};

var FORBIDDEN_RE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|REPLACE|TRUNCATE|GRANT|REVOKE|CALL|EXECUTE|HANDLER|LOAD_EXTENSION)\b/i;
var LIMIT_RE = /\bLIMIT\b/i;
var ORDER_BY_RE = /\bORDER\s+BY\b/i;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function stripComments(sql) {
  var res = "";
  var i = 0;
  var n = sql.length;
  var state = null;
  while (i < n) {
    var ch = sql[i];
    var nxt = i + 1 < n ? sql[i + 1] : "";
    if (state === null) {
      if (ch === "-" && nxt === "-") {
        while (i < n && sql[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && nxt === "*") {
        i += 2;
        while (i < n && !(sql[i] === "*" && i + 1 < n && sql[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        state = ch;
        res += ch;
        i++;
        continue;
      }
      res += ch;
      i++;
    } else {
      res += ch;
      if (ch === state) {
        if (ch === "'" && i + 1 < n && sql[i + 1] === "'") {
          res += "'";
          i += 2;
          continue;
        }
        state = null;
      }
      i++;
    }
  }
  return res;
}

function normKey(v) {
  if (v === null || v === undefined) return "null:";
  if (typeof v === "number") {
    if (!isFinite(v)) return "str:" + String(v);
    var r = Math.round(v * 1e6) / 1e6;
    return "num:" + (Object.is(r, -0) ? 0 : r);
  }
  var s = String(v).trim();
  if (s !== "" && !isNaN(Number(s))) {
    var num = Number(s);
    var rn = Math.round(num * 1e6) / 1e6;
    return "num:" + (Object.is(rn, -0) ? 0 : rn);
  }
  return "str:" + s;
}

function rowKey(arr) {
  return JSON.stringify(arr.map(normKey));
}

function shortErr(e) {
  var m = String((e && e.message) || e || "неизвестная ошибка");
  m = m.replace(/^D1_ERROR:\s*/i, "");
  return m.split("\n")[0].slice(0, 300);
}

async function handleLevels(DB) {
  var out = [];
  for (var i = 0; i < LEVELS_META.length; i++) {
    var m = LEVELS_META[i];
    var count = m.fallback;
    try {
      var row = await DB.prepare(
        "SELECT COUNT(*) AS c FROM exercises WHERE level = ?"
      ).bind(m.level).first();
      if (row && typeof row.c === "number") count = row.c;
    } catch (e) { /* пустая БД — fallback */ }
    out.push({ level: m.level, title: m.title, count: count });
  }
  return json(out);
}

async function handleExerciseList(DB, url) {
  var level = parseInt(url.searchParams.get("level") || "", 10);
  if (!level) {
    return json({ error: "Укажите номер уровня: /api/exercises?level=1" }, 400);
  }
  try {
    var res = await DB.prepare(
      "SELECT id, level, order_in_level, title, is_active " +
      "FROM exercises WHERE level = ? ORDER BY order_in_level, id"
    ).bind(level).all();
    return json(res.results || []);
  } catch (e) {
    return json({ error: "Ошибка базы данных: " + e.message }, 500);
  }
}

async function handleExerciseDetail(DB, id) {
  if (!id) return json({ error: "Задание не найдено" }, 404);
  var row;
  try {
    row = await DB.prepare("SELECT * FROM exercises WHERE id = ?").bind(id).first();
  } catch (e) {
    return json({ error: "Ошибка базы данных: " + e.message }, 500);
  }
  if (!row) return json({ error: "Задание не найдено" }, 404);
  var expected = row.expected_sql || "";
  var mentioned = TABLE_NAMES.filter(function (t) {
    return new RegExp("\\b" + t + "\\b", "i").test(expected);
  });
  var names = mentioned.length ? mentioned : TABLE_NAMES;
  var tables = [];
  for (var i = 0; i < names.length; i++) {
    var t = names[i];
    var cols = TABLE_COLUMNS[t];
    var sample = [];
    try {
      var r = await DB.prepare('SELECT * FROM "' + t + '" LIMIT 3').all();
      sample = (r.results || []).map(function (obj) {
        return cols.map(function (c) {
          var v = obj[c[0]];
          return v === undefined ? null : v;
        });
      });
    } catch (e) { /* таблицы нет — пропускаем */ }
    tables.push({
      name: t,
      columns: cols.map(function (c) { return { name: c[0], type: c[1] }; }),
      sample: sample
    });
  }
  var obj = {};
  for (var k in row) obj[k] = row[k];
  obj.tables = tables;
  return json(obj);
}

async function handleSchema(DB) {
  var result = [];
  for (var i = 0; i < TABLE_NAMES.length; i++) {
    var t = TABLE_NAMES[i];
    try {
      var cnt = await DB.prepare('SELECT COUNT(*) AS c FROM "' + t + '"').first();
      result.push({
        name: t,
        columns: TABLE_COLUMNS[t].map(function (c) { return { name: c[0], type: c[1] }; }),
        sampleCount: cnt ? cnt.c : 0
      });
    } catch (e) { /* таблицы нет — пропускаем */ }
  }
  return json(result);
}

function sqlCode(sql) {
  var code = "", quote = null;
  for (var i = 0; i < sql.length; i++) {
    var ch = sql[i], next = sql[i + 1];
    if (quote) {
      if (ch === quote) { if (next === quote) { i++; } else quote = null; }
      code += " "; continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; code += " "; }
    else code += ch;
  }
  return code;
}
function readQuery(value) {
  if (typeof value !== "string" || value.length > 16000) throw new Error("Запрос должен быть текстом не длиннее 16000 символов.");
  var sql = stripComments(value).trim().replace(/;\s*$/, "").trim();
  var code = sqlCode(sql);
  if (!sql || !/^(SELECT|WITH)\b/i.test(code.trim()) || FORBIDDEN_RE.test(code) || /\b(RECURSIVE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(code) || code.includes(";")) throw new Error("Разрешён один SELECT или WITH ... SELECT, без изменения данных и рекурсии.");
  return sql;
}
function ordered(sql) {
  var code = sqlCode(stripComments(sql)), depth = 0;
  for (var i = 0; i < code.length; i++) {
    if (code[i] === "(") depth++;
    if (code[i] === ")") depth--;
    if (depth === 0 && /^ORDER\s+BY\b/i.test(code.slice(i)) && (i === 0 || !/\w/.test(code[i - 1]))) return true;
  }
  return false;
}
async function runRead(DB, sql) {
  var values = await DB.prepare("SELECT * FROM (" + sql.replace(/;\s*$/, "") + ") AS _qartel_result LIMIT 101").raw({ columnNames: true });
  var columns = values.shift() || [];
  return { columns: columns, rows: values.slice(0, 100), truncated: values.length > 100 };
}
async function handleQuery(DB, request) {
  try {
    var body = await request.json();
    var result = await runRead(DB, readQuery(body.sql));
    return json({ success: true, columns: result.columns, rows: result.rows, row_count: result.rows.length, truncated: result.truncated });
  } catch (e) { return json({ success: false, message: "Ошибка запроса: " + shortErr(e) }, 400); }
}
async function handleCheck(DB, request) {
  var body;
  try { body = await request.json(); } catch (e) { return json({ success: false, message: "Некорректный JSON." }, 400); }
  if (!body || !Number.isInteger(body.exercise_id) || body.exercise_id < 1 || body.exercise_id > 45) return json({ success: false, message: "Некорректный номер задания." }, 400);
  var expected = await DB.prepare("SELECT expected_sql FROM exercises WHERE id = ? AND is_active = 1").bind(body.exercise_id).first();
  if (!expected) return json({ success: false, message: "Задание не найдено." }, 404);
  try {
    var sql = readQuery(body.sql);
    var user = await runRead(DB, sql), reference = await runRead(DB, expected.expected_sql);
    var sameColumns = user.columns.length === reference.columns.length;
    if (body.exercise_id >= 31) sameColumns = sameColumns && user.columns.every(function (c, i) { return c === reference.columns[i]; });
    var a = user.rows.map(rowKey), b = reference.rows.map(rowKey);
    if (!ordered(expected.expected_sql)) { a.sort(); b.sort(); }
    var success = !user.truncated && !reference.truncated && sameColumns && a.length === b.length && a.every(function (value, i) { return value === b[i]; });
    return json({ success: success, message: success ? "Верно! Результат совпадает с условием." : "Пока не совпадает. Проверьте столбцы, значения, число строк и требуемую сортировку.", user_columns: user.columns, user_rows: user.rows, row_count: user.rows.length });
  } catch (e) { return json({ success: false, message: "Ошибка запроса: " + shortErr(e) }); }
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;
    if (path === "/api/levels") return handleLevels(env.DB);
    if (path === "/api/exercises") return handleExerciseList(env.DB, url);
    var m = /^\/api\/exercises\/(\d+)$/.exec(path);
    if (m) return handleExerciseDetail(env.DB, parseInt(m[1], 10));
    if (path === "/api/schema") return handleSchema(env.DB);
    if (path === "/api/check") {
      if (request.method !== "POST") return json({ error: "Только POST" }, 405);
      if (!env.DB) return json({ success: false, message: "База данных не подключена." }, 500);
      return handleCheck(env.DB, request);
    }
    if (path === "/api/query") {
      if (request.method !== "POST") return json({ message: "Только POST" }, 405);
      return handleQuery(env.DB, request);
    }
    // Всё остальное — статика.
    return env.ASSETS.fetch(request);
  }
};
