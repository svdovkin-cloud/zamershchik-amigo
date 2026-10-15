-- Схема базы Supabase для «Замеры Amigo».
-- Выполняется один раз в SQL-редакторе Supabase после создания проекта.

-- Пользователи. PIN хранится как scrypt-хэш с солью, сам PIN нигде не сохраняется.
create table if not exists public.users (
  id          uuid primary key,
  name        text not null,
  email       text,
  role        text not null default 'measurer' check (role in ('admin', 'measurer')),
  salt        text,
  hash        text,
  created_at  timestamptz not null default now()
);

-- Настройки одним объектом: ключевые параметры почты меняет администратор.
create table if not exists public.settings (
  id          integer primary key default 1 check (id = 1),
  data        jsonb not null default '{}'::jsonb
);

-- Заявки. Вся заявка — одним JSONB-документом, история не перезаписывается.
create table if not exists public.orders (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

-- Поиск по заявкам по автору и клиенту.
create index if not exists orders_created_at_idx on public.orders (created_at desc);
