-- The framework's own tables, hand-written for the same reason 001-003 are: SCOPE (3)'s
-- generator is what will emit them, from `src/auth/entities.ts`, which is where they are
-- actually defined. Until then the shape is stated twice, so keep the two in step — in
-- particular every `not null` here matches a `nullable: false` there (`completeRecord` defaults
-- every non-pk field to nullable, so the entity has to say so explicitly).
--
-- `timestamp`, never `timestamptz`: the `datetime` handler accepts no zone suffix, so a
-- timestamptz column would be refused on the way back out and 500 every authenticated request.
-- The connection pins `timezone=UTC`, which is what makes `expires_at > now()` mean one thing.
--
-- `"user"` is quoted throughout: `user` is a reserved word in Postgres (it doubles as a
-- function equivalent to `current_user`). The framework already quotes every identifier it
-- generates (`sql/identifier.ts`'s `q()`) for exactly this class of case, so a reserved word as
-- a table name is a feature to demonstrate, not a name to avoid.

create table "user" (
  username  varchar(60)  not null,
  email     text,
  is_admin  boolean      not null default false,
  active    boolean      not null default true,
  constraint user_pk primary key (username)
);

-- The secret, alone in its own table. `"user"` therefore holds nothing that has to be hidden,
-- so it needs no column-level visibility rule to be safe to expose later.
create table credential (
  "user"  varchar(60)   not null,
  hash    varchar(200)  not null,   -- scrypt, PHC-shaped: scrypt$N=…,r=…,p=…$salt$key
  constraint credential_pk primary key ("user"),
  constraint credential_user_fk foreign key ("user") references "user" (username)
);

-- `token` holds the SHA-256 *digest* of the token, never the token, so a dump of this table
-- yields nothing that can be presented. varchar rather than char: char(n) is blank-padded and
-- compares ignoring trailing spaces.
create table session (
  token       varchar(64)  not null,
  "user"      varchar(60)  not null,
  created_at  timestamp    not null,
  expires_at  timestamp    not null,
  constraint session_pk primary key (token),
  constraint session_user_fk foreign key ("user") references "user" (username)
);

-- Reaping runs on every login (`delete from session where expires_at <= now()`), which is the
-- one query this index exists for.
create index session_expires_at_ix on session (expires_at);
