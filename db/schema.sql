-- SQL-тренажёр: схема SQLite
-- Кодировка UTF-8. Даты хранятся как TEXT в формате YYYY-MM-DD.

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL,
    stock INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL,
    order_date TEXT NOT NULL,
    customer_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    salary REAL NOT NULL,
    hire_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY,
    level INTEGER NOT NULL,
    order_in_level INTEGER NOT NULL,
    title TEXT NOT NULL,
    theory TEXT NOT NULL,
    task_description TEXT NOT NULL,
    hint TEXT NOT NULL,
    expected_sql TEXT NOT NULL,
    expected_result_description TEXT NOT NULL,
    is_active INTEGER DEFAULT 1
);

-- Справочник категорий (products.category ссылается на categories.name по смыслу)
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL
);

-- Клиенты магазина (имена совпадают с orders.customer_name)
CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    city TEXT NOT NULL,
    registered_at TEXT NOT NULL
);

-- Отзывы клиентов о товарах
CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review_text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
