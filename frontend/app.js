// SQL-тренажёр — ванильный фронтенд без сборки.
// Страницы: home (презентация) + trainer (уровни → задания → редактор).
// Контракт API (см. LOCAL-PROMPT.md, раздел 5):
//   GET  /api/levels             -> [{level, title, count}]
//   GET  /api/exercises?level=N  -> [{id, level, order_in_level, title, is_active}]
//   GET  /api/exercises/:id      -> {id, ..., tables: [{name, columns: [{name, type}], sample: [...]}]}
//   GET  /api/schema             -> [{name, columns: [{name, type}], sampleCount}]
//   POST /api/check {exercise_id, sql} -> {success, message, user_columns, user_rows, row_count, error?}

"use strict";

var PROGRESS_KEY = "sql_trainer_progress";
var TOTAL_EXERCISES = 45;
var CONNECTION_ERROR_TEXT = "Не удалось соединиться с сервером. Запустите python3 server.py";
var FALLBACK_LEVELS = [
  { level: 1, title: "Уровень 1: Основы SELECT", count: 15 },
  { level: 2, title: "Уровень 2: JOIN и агрегаты", count: 17 },
  { level: 3, title: "Уровень 3: Подзапросы и оконные функции", count: 13 }
];
// Иконки (id символов из SVG-спрайта в index.html) и короткие подписи уровней.
var LEVEL_META = {
  1: { icon: "i-search", tagline: "SELECT, WHERE, ORDER BY, LIMIT" },
  2: { icon: "i-link", tagline: "JOIN, GROUP BY и агрегаты" },
  3: { icon: "i-code", tagline: "Подзапросы, CASE, оконные функции" }
};
// Русские описания таблиц для секции «Наша база данных» на главной.
var TABLE_DESCRIPTIONS = {
  products: "Каталог товаров: названия, категории, цены и остатки на складе.",
  orders: "Заказы покупателей: кто, что и в каком количестве купил.",
  employees: "Сотрудники компании: отделы, зарплаты и даты найма.",
  categories: "Справочник категорий товаров с описаниями.",
  customers: "Клиенты магазина: контакты, города и даты регистрации.",
  exercises: "Служебная таблица заданий: уровни, теория и эталонные запросы.",
  reviews: "Отзывы клиентов о товарах с оценками от 1 до 5."
};

var currentLevel = null;
var currentExerciseId = null;
var currentView = "home";
// Кэш схемы БД: [{name, columns: [{name, type}], sampleCount}] — нужен и лендингу, и редактору.
var schemaCache = null;

// ---------- Утилиты ----------

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showConnectionError(text) {
  var el = document.getElementById("connection-error");
  el.hidden = !text;
  el.textContent = text || "";
}

// Переключение экранов: home (презентация) + trainer (levels/tasks/exercise).
function showScreen(name) {
  currentView = name;
  if (name === "home" || name === "levels") history.replaceState(null, "", name === "home" ? location.pathname : "#trainer");
  document.getElementById("screen-queries").hidden = name !== "queries";
  document.getElementById("screen-home").hidden = name !== "home";
  document.getElementById("screen-levels").hidden = name !== "levels";
  document.getElementById("screen-tasks").hidden = name !== "tasks";
  document.getElementById("screen-exercise").hidden = name !== "exercise";
  // Подсветка активного пункта навигации.
  var links = document.querySelectorAll(".nav-link");
  for (var i = 0; i < links.length; i++) {
    var target = links[i].getAttribute("data-nav");
    var active = (name === "home" && target === "home") ||
      (["levels", "tasks", "exercise"].includes(name) && target === "trainer") || (name === "queries" && target === "queries");
    links[i].classList.toggle("active", active);
  }
  window.scrollTo(0, 0);
}

function apiFetch(path, options) {
  return fetch("/api" + path, options).then(
    function (resp) {
      if (!resp.ok) throw new Error("Ошибка сервера: HTTP " + resp.status);
      return resp.json();
    },
    function () { throw new Error(CONNECTION_ERROR_TEXT); }
  );
}

// ---------- Прогресс (localStorage) ----------

function getProgress() {
  try {
    var arr = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function isCompleted(id) { return getProgress().indexOf(id) !== -1; }
function saveProgress(id) {
  var progress = getProgress();
  if (progress.indexOf(id) === -1) {
    progress.push(id);
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); } catch (e) {}
  }
}
function clearProgress() {
  try { localStorage.removeItem(PROGRESS_KEY); } catch (e) {}
}
// Обновить все индикаторы прогресса: пилюля в шапке, hero, экран уровней.
function updateProgressText() {
  var done = getProgress().length;
  document.getElementById("nav-progress").textContent = done + "/" + TOTAL_EXERCISES;
  var heroText = document.getElementById("hero-progress-text");
  if (heroText) heroText.textContent = "Выполнено " + done + " из " + TOTAL_EXERCISES;
  var heroFill = document.getElementById("hero-progress-fill");
  if (heroFill) heroFill.style.width = Math.round((done / TOTAL_EXERCISES) * 100) + "%";
  var levelsText = document.getElementById("levels-progress-text");
  if (levelsText) levelsText.textContent = "Выполнено " + done + " из " + TOTAL_EXERCISES;
}

// ---------- Главная: превью уровней ----------

function shortLevelTitle(full) {
  // «Уровень 1: Основы SELECT» -> «Основы SELECT» для компактных карточек.
  var m = /^Уровень\s+\d+\s*:\s*(.*)$/.exec(full || "");
  return m ? m[1] : full;
}

// Кэш списков заданий по уровням: {1: [...], ...} — чтобы считать прогресс уровня.
var levelListsCache = {};

function fetchLevelList(level) {
  if (levelListsCache[level]) return Promise.resolve(levelListsCache[level]);
  return apiFetch("/exercises?level=" + encodeURIComponent(level)).then(function (list) {
    levelListsCache[level] = list || [];
    return levelListsCache[level];
  });
}

function countDoneIn(ids) {
  var progress = getProgress();
  var n = 0;
  ids.forEach(function (ex) { if (progress.indexOf(ex.id) !== -1) n++; });
  return n;
}

// Отрисовать карточки уровней в указанный контейнер.
function renderLevelCards(container, levels, withCounts) {
  container.innerHTML = "";
  levels.forEach(function (lvl) {
    var meta = LEVEL_META[lvl.level] || { icon: "i-book", tagline: "" };
    var card = document.createElement("button");
    card.className = "level-card";
    card.type = "button";
    var head = "<div class='level-ic'><svg class='ic'><use href='#" + meta.icon + "'/></svg></div>" +
      "<h3>" + escapeHtml(shortLevelTitle(lvl.title)) + "</h3>" +
      "<p>" + escapeHtml(meta.tagline) + "</p>";
    card.innerHTML = head + "<small>Загрузка…</small>";
    card.addEventListener("click", function () { showTasks(lvl.level); });
    container.appendChild(card);

    var paint = function (done, total) {
      var pct = total ? Math.round((done / total) * 100) : 0;
      var bar = "<div class='level-bar'><i style='width:" + pct + "%'></i></div>";
      var label = done === total && total > 0
        ? "<svg class='ic ic-done'><use href='#i-check-circle'/></svg> Уровень пройден!"
        : "Выполнено " + done + " из " + total;
      card.innerHTML = head + bar + "<small>" + label + "</small>";
    };
    if (withCounts) {
      fetchLevelList(lvl.level).then(
        function (list) { paint(countDoneIn(list), list.length || lvl.count); },
        function () { paint(0, lvl.count); }
      );
    } else {
      // На главной без точных id — показываем общий прогресс как подсказку.
      paint(0, lvl.count);
      var small = card.querySelector("small");
      if (small) small.textContent = "Заданий: " + lvl.count + " — жми, чтобы начать!";
    }
  });
}

// ---------- Главная: секция «Наша база данных» ----------

function loadSchema() {
  if (schemaCache) return Promise.resolve(schemaCache);
  return apiFetch("/schema").then(function (schema) {
    schemaCache = schema || [];
    return schemaCache;
  });
}

function renderSchemaCards() {
  var box = document.getElementById("schema-cards");
  var summary = document.getElementById("schema-summary");
  loadSchema().then(
    function (schema) {
      showConnectionError("");
      if (!schema.length) {
        box.innerHTML = "<p>Таблицы не найдены.</p>";
        return;
      }
      summary.textContent = "Всего таблиц: " + schema.length +
        " — кликай «Задания», чтобы писать к ним запросы";
      box.innerHTML = "";
      schema.forEach(function (t) {
        var card = document.createElement("div");
        card.className = "schema-card";
        var cols = (t.columns || []).map(function (c) {
          var cname = typeof c === "string" ? c : c.name;
          var ctype = typeof c === "string" ? "" : (c.type || "");
          return "<span class='col-chip'>" + escapeHtml(cname) +
            (ctype ? " <span>" + escapeHtml(ctype) + "</span>" : "") + "</span>";
        }).join("");
        var count = typeof t.sampleCount === "number" ? t.sampleCount : "?";
        card.innerHTML =
          "<div class='schema-card-head'><h3><svg class='ic'><use href='#i-db'/></svg> " +
          escapeHtml(t.name) + "</h3>" +
          "<span class='row-count'>" + escapeHtml(count) + " строк</span></div>" +
          "<p>" + escapeHtml(TABLE_DESCRIPTIONS[t.name] || "Таблица базы данных.") + "</p>" +
          "<div class='col-chips'>" + cols + "</div>";
        box.appendChild(card);
      });
    },
    function (err) {
      showConnectionError(err.message || CONNECTION_ERROR_TEXT);
      summary.textContent = "Не удалось загрузить схему. Запустите python3 server.py";
    }
  );
}

function showHome() {
  showScreen("home");
  updateProgressText();
  // Превью уровней на главной.
  var preview = document.getElementById("levels-preview");
  apiFetch("/levels").then(
    function (levels) {
      showConnectionError("");
      renderLevelCards(preview, levels && levels.length ? levels : FALLBACK_LEVELS, false);
    },
    function (err) {
      showConnectionError(err.message || CONNECTION_ERROR_TEXT);
      renderLevelCards(preview, FALLBACK_LEVELS, false);
    }
  );
  renderSchemaCards();
}

// ---------- Тренажёр: уровни и задания ----------

function showLevels() {
  showScreen("levels");
  updateProgressText();
  var list = document.getElementById("levels-list");
  list.innerHTML = "<p>Загрузка уровней…</p>";
  apiFetch("/levels").then(
    function (levels) {
      showConnectionError("");
      renderLevelCards(list, levels && levels.length ? levels : FALLBACK_LEVELS, true);
    },
    function (err) {
      showConnectionError(err.message || CONNECTION_ERROR_TEXT);
      renderLevelCards(list, FALLBACK_LEVELS, true);
    }
  );
}

function showTasks(level) {
  currentLevel = level;
  showScreen("tasks");
  updateProgressText();
  document.getElementById("tasks-title").textContent = "Задания уровня " + level;
  var list = document.getElementById("tasks-list");
  list.innerHTML = "<p>Загрузка заданий…</p>";
  // Запоминаем список в кэш для прогресс-баров уровней.
  var p = levelListsCache[level]
    ? Promise.resolve(levelListsCache[level])
    : apiFetch("/exercises?level=" + encodeURIComponent(level)).then(function (exs) {
        levelListsCache[level] = exs || [];
        return levelListsCache[level];
      });
  p.then(
    function (exercises) { showConnectionError(""); renderTasks(exercises); },
    function (err) {
      showConnectionError(err.message || CONNECTION_ERROR_TEXT);
      list.innerHTML = "<p>Не удалось загрузить задания.</p>";
    }
  );
}

function renderTasks(exercises) {
  var list = document.getElementById("tasks-list");
  list.innerHTML = "";
  if (!exercises.length) {
    list.innerHTML = "<p>Задания не найдены.</p>";
    return;
  }
  exercises.forEach(function (ex) {
    var done = isCompleted(ex.id);
    var btn = document.createElement("button");
    btn.className = "task-btn" + (done ? " done" : "");
    btn.type = "button";
    var icon = done
      ? "<svg class='ic ic-done'><use href='#i-check-circle'/></svg>"
      : "<svg class='ic ic-todo'><use href='#i-circle'/></svg>";
    btn.innerHTML = icon + "<span>Задание " + escapeHtml(ex.id) +
      ": " + escapeHtml(ex.title) + "</span>";
    btn.addEventListener("click", function () { showExercise(ex.id); });
    list.appendChild(btn);
  });
}

// ---------- Экран задания ----------

function showExercise(id) {
  currentExerciseId = id;
  showScreen("exercise");
  updateProgressText();
  document.getElementById("exercise-title").textContent = "Задание " + id;
  document.getElementById("exercise-theory").textContent = "Загрузка…";
  document.getElementById("exercise-task").textContent = "";
  document.getElementById("exercise-schema").innerHTML = "";
  document.getElementById("hint-block").hidden = true;
  document.getElementById("answer-block").hidden = true;
  document.getElementById("btn-hint").textContent = "Показать подсказку";
  document.getElementById("btn-answer").textContent = "Показать ответ";
  setEditorValue("");
  var result = document.getElementById("result");
  result.className = "result result-empty";
  result.textContent = "Нажмите «Проверить запрос», чтобы увидеть результат.";
  document.getElementById("btn-prev").disabled = id <= 1;
  document.getElementById("btn-next").disabled = id >= TOTAL_EXERCISES;

  apiFetch("/exercises/" + encodeURIComponent(id)).then(
    function (ex) { showConnectionError(""); renderExercise(ex); },
    function (err) {
      showConnectionError(err.message || CONNECTION_ERROR_TEXT);
      document.getElementById("exercise-theory").textContent = "Не удалось загрузить задание.";
    }
  );
}

function renderExercise(ex) {
  currentExerciseId = ex.id;
  history.replaceState(null, "", "#exercise-" + ex.id);
  document.getElementById("exercise-title").textContent = "Задание " + ex.id + ": " + (ex.title || "");
  document.getElementById("exercise-theory").textContent = ex.theory || "";
  document.getElementById("exercise-task").textContent = ex.task_description || "";
  document.getElementById("hint-text").textContent = ex.hint || "Подсказки нет.";
  // Эталонный ответ — с той же подсветкой синтаксиса, что и в редакторе.
  document.getElementById("answer-sql").innerHTML = highlightSql(ex.expected_sql || "");
  document.getElementById("answer-description").textContent = ex.expected_result_description || "";
  renderSchema(ex.tables || []);
  document.getElementById("btn-prev").disabled = ex.id <= 1;
  document.getElementById("btn-next").disabled = ex.id >= TOTAL_EXERCISES;
}

function renderSchema(tables) {
  var box = document.getElementById("exercise-schema");
  box.innerHTML = "";
  if (!tables.length) {
    box.innerHTML = "<p>Схема недоступна.</p>";
    return;
  }
  tables.forEach(function (t) {
    var wrap = document.createElement("div");
    wrap.className = "schema-table";
    var title = document.createElement("h4");
    title.textContent = "Таблица " + t.name;
    wrap.appendChild(title);
    var cols = t.columns || [];
    var html = "<div class='table-wrap'><table class='result-table'><thead><tr>";
    cols.forEach(function (c) {
      var cname = typeof c === "string" ? c : c.name;
      var ctype = typeof c === "string" ? "" : c.type || "";
      html += "<th>" + escapeHtml(cname) + (ctype ? " (" + escapeHtml(ctype) + ")" : "") + "</th>";
    });
    html += "</tr></thead><tbody>";
    (t.sample || []).slice(0, 3).forEach(function (row) {
      html += "<tr>";
      if (Array.isArray(row)) {
        row.forEach(function (v) { html += "<td>" + escapeHtml(v == null ? "NULL" : v) + "</td>"; });
      } else if (row && typeof row === "object") {
        cols.forEach(function (c) {
          var cname = typeof c === "string" ? c : c.name;
          html += "<td>" + escapeHtml(row[cname] == null ? "NULL" : row[cname]) + "</td>";
        });
      }
      html += "</tr>";
    });
    html += "</tbody></table></div>";
    var div = document.createElement("div");
    div.innerHTML = html;
    wrap.appendChild(div);
    box.appendChild(wrap);
  });
}

// ---------- Проверка запроса ----------

function checkQuery() {
  var sql = document.getElementById("sql-editor").value;
  var result = document.getElementById("result");
  if (!sql.trim()) {
    result.className = "result result-error";
    result.textContent = "Введите SQL-запрос перед проверкой.";
    return;
  }
  result.className = "result result-empty";
  result.textContent = "Проверка…";
  apiFetch("/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exercise_id: currentExerciseId, sql: sql })
  }).then(renderCheckResult, function (err) {
    result.className = "result result-error";
    result.textContent = err.message || CONNECTION_ERROR_TEXT;
  });
}

function renderCheckResult(data) {
  var result = document.getElementById("result");
  result.innerHTML = "";
  var msg = document.createElement("div");
  msg.className = "result-message";
  // Статусная иконка — SVG; ведущие эмодзи из текста сервера отрезаем.
  var icon = document.createElement("span");
  icon.innerHTML = data.success
    ? "<svg class='ic msg-ok'><use href='#i-check-circle'/></svg>"
    : "<svg class='ic msg-bad'><use href='#i-x-circle'/></svg>";
  msg.appendChild(icon);
  var text = document.createElement("span");
  var raw = data.message || (data.success ? "Верно! Задание выполнено." : "Неверно. Попробуй ещё раз.");
  text.textContent = raw.replace(/^[\u2705\u274C✅❌\s]+/, "");
  msg.appendChild(text);
  result.appendChild(msg);
  if (data.success) {
    result.className = "result result-success";
    saveProgress(currentExerciseId);
    updateProgressText();
  } else {
    result.className = "result result-error";
    if (data.error) {
      var errLine = document.createElement("div");
      errLine.textContent = data.error;
      result.appendChild(errLine);
    }
  }
  var cols = normalizeColumns(data.user_columns);
  var rows = data.user_rows || [];
  if (cols.length) {
    var info = document.createElement("div");
    info.textContent = "Строк: " + (typeof data.row_count === "number" ? data.row_count : rows.length);
    result.appendChild(info);
    var wrap = document.createElement("div");
    wrap.className = "table-wrap";
    var html = "<table class='result-table'><thead><tr>";
    cols.forEach(function (c) { html += "<th>" + escapeHtml(c) + "</th>"; });
    html += "</tr></thead><tbody>";
    rows.slice(0, 100).forEach(function (row) {
      html += "<tr>";
      if (Array.isArray(row)) {
        row.forEach(function (v) { html += "<td>" + escapeHtml(v == null ? "NULL" : v) + "</td>"; });
      } else if (row && typeof row === "object") {
        cols.forEach(function (c) { html += "<td>" + escapeHtml(row[c] == null ? "NULL" : row[c]) + "</td>"; });
      }
      html += "</tr>";
    });
    html += "</tbody></table>";
    wrap.innerHTML = html;
    result.appendChild(wrap);
  }
}

function normalizeColumns(userColumns) {
  if (!Array.isArray(userColumns)) return [];
  return userColumns.map(function (c) {
    if (typeof c === "string") return c;
    if (c && typeof c.name === "string") return c.name;
    return String(c);
  });
}

// =====================================================================
// SQL-редактор: подсветка синтаксиса + автодополнение (всё своё, без библиотек)
// Техника overlay: прозрачный textarea поверх подсвеченного <pre>.
// =====================================================================

// Словарь автодополнения: ключевые слова и конструкции SQL.
var SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "ORDER BY", "GROUP BY", "PARTITION BY", "BY",
  "LIMIT", "OFFSET", "JOIN", "LEFT JOIN", "INNER JOIN", "RIGHT JOIN",
  "ON", "AS", "AND", "OR", "NOT", "IN", "BETWEEN", "LIKE", "IS NULL",
  "DISTINCT", "ALL", "ASC", "DESC", "HAVING", "UNION", "WITH",
  "CASE", "WHEN", "THEN", "ELSE", "END",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "ROUND",
  "RANK", "ROW_NUMBER", "DENSE_RANK", "OVER",
  "LOWER", "UPPER", "LENGTH", "SUBSTR", "COALESCE"
];
var KEYWORD_SET = {};
SQL_KEYWORDS.forEach(function (kw) {
  // Составные конструкции («ORDER BY») индексируем и целиком, и по первому слову.
  KEYWORD_SET[kw] = true;
  KEYWORD_SET[kw.split(" ")[0]] = true;
});
// Слова, которые при вызове со скобкой красим как функции, а не ключевые слова.
var FN_SET = {};
["COUNT", "SUM", "AVG", "MIN", "MAX", "ROUND", "RANK", "ROW_NUMBER",
 "DENSE_RANK", "LOWER", "UPPER", "LENGTH", "SUBSTR", "COALESCE"
].forEach(function (fn) { FN_SET[fn] = true; });

function editorEls() {
  return {
    shell: document.getElementById("editor-shell"),
    code: document.getElementById("editor-code"),
    input: document.getElementById("sql-editor"),
    popup: document.getElementById("autocomplete")
  };
}

// Подсветить SQL-код: комментарии, строки, числа, ключевые слова, функции.
function highlightSql(src) {
  var re = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*(?:'|$)|"[^"\n]*"?|`[^`\n]*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z\u0400-\u04FF_][A-Za-z0-9\u0400-\u04FF_$.]*)/g;
  var out = "";
  var last = 0;
  var m;
  while ((m = re.exec(src)) !== null) {
    out += escapeHtml(src.slice(last, m.index));
    var tok = m[0];
    if (m[1]) {
      out += '<span class="tk-com">' + escapeHtml(tok) + "</span>";
    } else if (m[2]) {
      out += '<span class="tk-str">' + escapeHtml(tok) + "</span>";
    } else if (m[3]) {
      out += '<span class="tk-num">' + escapeHtml(tok) + "</span>";
    } else if (tok.indexOf(".") === -1 && KEYWORD_SET[tok.toUpperCase()]) {
      // Слово, за которым идёт «(» — вызов функции (COUNT(, SUM(, ...).
      var up = tok.toUpperCase();
      var next = src.charAt(m.index + tok.length);
      if (next === "(" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok) &&
          (FN_SET[up] || !KEYWORD_SET[up])) {
        out += '<span class="tk-fn">' + escapeHtml(tok) + "</span>";
      } else {
        out += '<span class="tk-kw">' + escapeHtml(tok) + "</span>";
      }
    } else {
      // Слово, за которым идёт «(» — вызов функции.
      var next = src.charAt(m.index + tok.length);
      if (next === "(" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok)) {
        out += '<span class="tk-fn">' + escapeHtml(tok) + "</span>";
      } else {
        out += escapeHtml(tok);
      }
    }
    last = m.index + tok.length;
    if (tok.length === 0) re.lastIndex++;
  }
  out += escapeHtml(src.slice(last));
  // Финальный перенос строки: иначе <pre> ниже textarea на пустой последней строке.
  return out + "\n";
}

// Перерисовать подсветку + авторастяжение редактора.
function refreshEditor() {
  var els = editorEls();
  els.code.innerHTML = highlightSql(els.input.value);
  els.input.style.height = "auto";
  els.input.style.height = Math.max(150, els.input.scrollHeight) + "px";
}

function setEditorValue(value) {
  var els = editorEls();
  hideAutocomplete();
  els.input.value = value;
  refreshEditor();
}

// Словарь «таблица/колонка» из схемы БД (подтягивается с /api/schema).
function schemaVocab() {
  var items = [];
  (schemaCache || []).forEach(function (t) {
    items.push({ text: t.name, kind: "tbl", kindLabel: "таблица" });
    (t.columns || []).forEach(function (c) {
      var cname = typeof c === "string" ? c : c.name;
      items.push({ text: cname, table: t.name, kind: "col", kindLabel: "колонка" });
    });
  });
  return items;
}

// Текущее слово перед кареткой: {start, end, word}. Точку в конце («p.») сохраняем.
function currentWord(input) {
  var end = input.selectionStart;
  var before = input.value.slice(0, end);
  var m = /[A-Za-z\u0400-\u04FF_][A-Za-z0-9\u0400-\u04FF_$.]*$/.exec(before);
  if (!m) return null;
  return { start: end - m[0].length, end: end, word: m[0] };
}

// Подобрать кандидатов: сначала по префиксу, затем по вхождению; максимум 8.
function completeCandidates(word) {
  var dot = word.lastIndexOf(".");
  var hasDot = dot !== -1 && dot === word.length - 1;
  var tablePart = dot !== -1 ? word.slice(0, dot) : null;
  var prefix = (dot !== -1 ? word.slice(dot + 1) : word).toUpperCase();
  var out = [];
  var seen = {};

  var pushUnique = function (item) {
    var key = item.kind + ":" + item.text.toUpperCase();
    if (!seen[key]) { seen[key] = true; out.push(item); }
  };

  if (hasDot) {
    // «products.» — показываем колонки этой таблицы (или все, если таблица неизвестна).
    var cols = schemaVocab().filter(function (v) { return v.kind === "col"; });
    var known = cols.filter(function (v) { return v.table === tablePart; });
    (known.length ? known : cols).forEach(pushUnique);
  } else {
    var vocab = SQL_KEYWORDS.map(function (kw) {
      return { text: kw, kind: "kw", kindLabel: "команда" };
    }).concat(schemaVocab());
    // Проход 1: совпадение с начала.
    vocab.forEach(function (item) {
      if (prefix.length >= 2 && item.text.toUpperCase().indexOf(prefix) === 0) pushUnique(item);
    });
    // Проход 2: вхождение внутри (например «gro» найдёт «GROUP BY»).
    if (out.length < 8 && prefix.length >= 2) {
      vocab.forEach(function (item) {
        if (out.length >= 8) return;
        if (item.text.toUpperCase().indexOf(prefix) > 0) pushUnique(item);
      });
    }
  }
  return out.slice(0, 8);
}

var acState = { items: [], active: 0 };

// Координаты каретки через div-зеркало с теми же метриками, что у textarea.
function caretCoords(input) {
  var cs = window.getComputedStyle(input);
  var padLeft = parseFloat(cs.paddingLeft) || 0;
  var padRight = parseFloat(cs.paddingRight) || 0;
  var mirror = document.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre";
  mirror.style.boxSizing = "content-box";
  mirror.style.fontFamily = cs.fontFamily;
  mirror.style.fontSize = cs.fontSize;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.padding = cs.padding;
  // Ширина контента = как у textarea, бордер на раскладку текста не влияет.
  mirror.style.width = Math.max(0, input.clientWidth - padLeft - padRight) + "px";
  mirror.textContent = input.value.slice(0, input.selectionStart);
  var marker = document.createElement("span");
  marker.textContent = "​"; // zero-width space — у маркера нулевая ширина, но есть позиция
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  var x = padLeft + marker.offsetLeft - input.scrollLeft;
  var y = marker.offsetTop - input.scrollTop;
  document.body.removeChild(mirror);
  var lineH = parseFloat(cs.lineHeight);
  if (isNaN(lineH)) lineH = (parseFloat(cs.fontSize) || 15) * 1.6;
  return { x: x, y: y, lineH: lineH };
}

function showAutocomplete(items, word) {
  var els = editorEls();
  acState.items = items;
  acState.active = 0;
  var pos = caretCoords(els.input);
  els.popup.innerHTML = "";
  items.forEach(function (item, i) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ac-item" + (i === 0 ? " active" : "");
    btn.innerHTML = "<span class='ac-kind " + item.kind + "'>" + escapeHtml(item.kindLabel) + "</span>" +
      "<span>" + escapeHtml(item.text) + "</span>";
    // mousedown, а не click: срабатывает до blur у textarea.
    btn.addEventListener("mousedown", function (e) {
      e.preventDefault();
      applyCompletion(i, word);
    });
    els.popup.appendChild(btn);
  });
  els.popup.hidden = false;
  // Позиция под кареткой; не даём попапу вылезти за правый край редактора.
  els.popup.style.left =
    Math.max(8, Math.min(pos.x, els.shell.clientWidth - 250)) + "px";
  els.popup.style.top = (pos.y + pos.lineH + 6) + "px";
}

function hideAutocomplete() {
  var els = editorEls();
  if (els.popup) els.popup.hidden = true;
  acState.items = [];
  acState.active = 0;
}

function markActiveItem() {
  var els = editorEls();
  var kids = els.popup.children;
  for (var i = 0; i < kids.length; i++) {
    kids[i].classList.toggle("active", i === acState.active);
  }
  if (kids[acState.active] && kids[acState.active].scrollIntoView) {
    kids[acState.active].scrollIntoView({ block: "nearest" });
  }
}

// Подставить выбранный вариант вместо текущего слова.
function applyCompletion(index, word) {
  var els = editorEls();
  var item = acState.items[index];
  if (!item || !word) { hideAutocomplete(); return; }
  var insert = item.text + (item.kind === "kw" ? " " : "");
  var value = els.input.value;
  els.input.value = value.slice(0, word.start) + insert + value.slice(word.end);
  var caret = word.start + insert.length;
  els.input.selectionStart = els.input.selectionEnd = caret;
  els.input.focus();
  hideAutocomplete();
  refreshEditor();
}

// Обновить попап после каждого ввода.
function updateAutocomplete() {
  var els = editorEls();
  // Не подсказываем, если есть выделение или попап был закрыт через Esc.
  if (els.input.selectionStart !== els.input.selectionEnd) { hideAutocomplete(); return; }
  var word = currentWord(els.input);
  if (!word || word.word.length < 2) { hideAutocomplete(); return; }
  // Не подсказываем внутри строковых литералов и комментариев.
  var before = els.input.value.slice(0, word.start);
  var openQuote = (before.match(/'/g) || []).length % 2 === 1;
  var lineStart = before.lastIndexOf("\n");
  if (openQuote || before.slice(lineStart).indexOf("--") !== -1) { hideAutocomplete(); return; }
  var items = completeCandidates(word.word);
  if (!items.length) { hideAutocomplete(); return; }
  // Точное совпадение единственного варианта (уже введено целиком) — прячем.
  if (items.length === 1 && items[0].text.toUpperCase() === word.word.toUpperCase()) {
    hideAutocomplete();
    return;
  }
  showAutocomplete(items, word);
}

function initEditor() {
  var els = editorEls();
  // Схему для словаря подгружаем заранее (тихо, без баннеров).
  apiFetch("/schema").then(function (tables) { document.getElementById("free-schema").textContent = tables.map(function (t) { return t.name + " (" + t.columns.map(function (c) { return c.name; }).join(", ") + ")"; }).join("\n"); }).catch(function () {});
  refreshEditor();

  els.input.addEventListener("input", function () {
    refreshEditor();
    updateAutocomplete();
  });
  els.input.addEventListener("scroll", function () {
    document.querySelector(".editor-layer").scrollTop = els.input.scrollTop;
    document.querySelector(".editor-layer").scrollLeft = els.input.scrollLeft;
  });
  els.input.addEventListener("blur", function () {
    // Небольшая задержка, чтобы успел сработать mousedown по пункту.
    setTimeout(hideAutocomplete, 150);
  });

  els.input.addEventListener("keydown", function (e) {
    var popupOpen = !els.popup.hidden && acState.items.length > 0;
    if (popupOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      var n = acState.items.length;
      acState.active = e.key === "ArrowDown"
        ? (acState.active + 1) % n
        : (acState.active - 1 + n) % n;
      markActiveItem();
      return;
    }
    if (popupOpen && (e.key === "Enter" || e.key === "Tab")) {
      // Enter/Tab выбирают подсказку (без Ctrl — иначе это «проверить»).
      if (!(e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        applyCompletion(acState.active, currentWord(els.input));
        return;
      }
    }
    if (e.key === "Escape") { hideAutocomplete(); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      var start = els.input.selectionStart;
      var end = els.input.selectionEnd;
      var value = els.input.value;
      els.input.value = value.slice(0, start) + "  " + value.slice(end);
      els.input.selectionStart = els.input.selectionEnd = start + 2;
      refreshEditor();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      hideAutocomplete();
      checkQuery();
    }
  });
}

// ---------- Инициализация ----------

document.addEventListener("DOMContentLoaded", function () {
  // Навигация шапки и кнопок «Начать учиться».
  var navs = document.querySelectorAll("[data-nav]");
  for (var i = 0; i < navs.length; i++) {
    navs[i].addEventListener("click", function () {
      var target = this.getAttribute("data-nav");
      if (target === "home") showHome();
      else if (target === "queries") showQueries();
      else showLevels();
    });
  }

  document.getElementById("btn-back-levels").addEventListener("click", showLevels);
  document.getElementById("btn-back-tasks").addEventListener("click", function () {
    if (currentLevel != null) showTasks(currentLevel);
    else showLevels();
  });
  document.getElementById("btn-check").addEventListener("click", checkQuery);

  document.getElementById("btn-hint").addEventListener("click", function () {
    var block = document.getElementById("hint-block");
    block.hidden = !block.hidden;
    this.textContent = block.hidden ? "Показать подсказку" : "Скрыть подсказку";
  });
  document.getElementById("btn-answer").addEventListener("click", function () {
    var block = document.getElementById("answer-block");
    block.hidden = !block.hidden;
    this.textContent = block.hidden ? "Показать ответ" : "Скрыть ответ";
  });
  document.getElementById("btn-prev").addEventListener("click", function () {
    if (currentExerciseId > 1) showExercise(currentExerciseId - 1);
  });
  document.getElementById("btn-next").addEventListener("click", function () {
    if (currentExerciseId < TOTAL_EXERCISES) showExercise(currentExerciseId + 1);
  });
  document.getElementById("btn-reset").addEventListener("click", function () {
    if (confirm("Сбросить весь прогресс? Придётся проходить задания заново!")) {
      clearProgress();
      updateProgressText();
      if (currentView === "home") showHome();
      else if (currentView === "levels") showLevels();
    }
  });

  initEditor();
  var hash = window.location.hash;
  if (/^#exercise-\d+$/.test(hash)) showExercise(Number(hash.slice(10)));
  else if (hash === "#queries") showQueries();
  else showHome();
});

function showQueries() {
  showScreen("queries");
  window.location.hash = "queries";
  apiFetch("/schema").then(function (tables) { document.getElementById("free-schema").textContent = tables.map(function (t) { return t.name + " (" + t.columns.map(function (c) { return c.name; }).join(", ") + ")"; }).join("\n"); }).catch(function () {});
}
document.getElementById("run-free-query").addEventListener("click", function () {
  var button = this, target = document.getElementById("free-result");
  button.disabled = true; target.textContent = "Выполняем…";
  apiFetch("/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: document.getElementById("free-sql").value }) }).then(function (result) {
    if (!result.success) { target.textContent = result.message; return; }
    target.innerHTML = "<p>Строк: " + result.row_count + (result.truncated ? " (показаны первые 100)" : "") + "</p><div style='overflow:auto'><table><thead><tr>" + result.columns.map(function (c) { return "<th>" + escapeHtml(c) + "</th>"; }).join("") + "</tr></thead><tbody>" + result.rows.map(function (row) { return "<tr>" + row.map(function (v) { return "<td>" + escapeHtml(v === null ? "NULL" : v) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>";
  }).catch(function (error) { target.textContent = error.message; }).finally(function () { button.disabled = false; });
});
