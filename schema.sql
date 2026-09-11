create table if not exists cards (
  id serial primary key,
  title text not null,
  description text default '',
  status text not null default 'todo',
  assignee text default 'Unassigned',
  tag text default '',
  position double precision not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists subtasks (
  id serial primary key,
  card_id int references cards(id) on delete cascade,
  title text not null,
  done boolean default false,
  position double precision not null default 0,
  created_at timestamptz default now()
);
create table if not exists links (
  id serial primary key,
  card_id int references cards(id) on delete cascade,
  label text default '',
  url text not null,
  created_at timestamptz default now()
);
create table if not exists notes (
  id serial primary key,
  card_id int references cards(id) on delete cascade,
  author text default 'Anon',
  body text not null,
  created_at timestamptz default now()
);
create table if not exists resources (
  id serial primary key,
  label text not null,
  url text not null,
  category text default 'Brand & Reference',
  position double precision default 0,
  created_at timestamptz default now()
);
