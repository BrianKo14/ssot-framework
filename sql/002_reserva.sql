-- Fixture exercising every built-in domain type, so the CRUD backend's type checking has
-- something to check. Like 001 this is hand-written; SCOPE (3)'s generator is what will derive
-- it from the entity definition.
--
-- Constraints are named explicitly rather than left to Postgres's defaults, per Emilio's review
-- note. 001 still has an inline `primary key` and so a default-named constraint; that is the
-- generator's to fix, not this file's.

create table reserva (
  fecha       date          not null,
  id          integer       not null,
  nombre      varchar(100)  not null,
  notas       text,
  hora        time,
  creado_en   timestamp,
  duracion    interval,
  importe     numeric(12,2),
  confirmada  boolean,
  constraint reserva_pk primary key (fecha, id)
);
