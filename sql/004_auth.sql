-- The framework's own tables, hand-written for the same reason 001-003 are: SCOPE (3)'s
-- generator is what will emit them, from `src/auth/entities.ts`, which is where they are
-- actually defined. Until then the shape is stated twice, so keep the two in step — in
-- particular every `not null` here matches a `nullable: false` there (`completeRecord` defaults
-- every non-pk field to nullable, so the entity has to say so explicitly).
--
-- `timestamp`, never `timestamptz`: the `datetime` handler accepts no zone suffix, so a
-- timestamptz column would be refused on the way back out and 500 every authenticated request.
-- The connection pins `timezone=UTC`, which is what makes `expira > now()` mean one thing.

create table usuario (
  nombre    varchar(60)  not null,
  email     text,
  es_admin  boolean      not null default false,
  activo    boolean      not null default true,
  constraint usuario_pk primary key (nombre)
);

-- The secret, alone in its own table. `usuario` therefore holds nothing that has to be hidden,
-- so it needs no column-level visibility rule to be safe to expose later.
create table credencial (
  usuario  varchar(60)   not null,
  hash     varchar(200)  not null,   -- scrypt, PHC-shaped: scrypt$N=…,r=…,p=…$salt$key
  constraint credencial_pk primary key (usuario),
  constraint credencial_usuario_fk foreign key (usuario) references usuario (nombre)
);

-- `token` holds the SHA-256 *digest* of the token, never the token, so a dump of this table
-- yields nothing that can be presented. varchar rather than char: char(n) is blank-padded and
-- compares ignoring trailing spaces.
create table sesion (
  token      varchar(64)  not null,
  usuario    varchar(60)  not null,
  creado_en  timestamp    not null,
  expira     timestamp    not null,
  constraint sesion_pk primary key (token),
  constraint sesion_usuario_fk foreign key (usuario) references usuario (nombre)
);

-- Reaping runs on every login (`delete from sesion where expira <= now()`), which is the one
-- query this index exists for.
create index sesion_expira_ix on sesion (expira);
