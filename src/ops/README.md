# Ops CLI

Command-line tools for the framework: creating the database, loading its sample data, and managing users.

Everything here talks to the database directly.

## Creating the database

`npm run db:create` writes the SQL that creates the schema (domains, tables, primary/unique/foreign keys, indexes, etc.) to stdout.

```
npm run db:create              # print it
npm run db:create -- --apply   # run it against DATABASE_URL
```

`--apply` is optional. If you don't pass it, the SQL is printed to stdout. If you do, it is applied to the database specified in `DATABASE_URL` (or the default in `.env`).

`npm run db:reset` is the whole cycle for development: it destroys the Postgres
volume, starts a fresh one, applies the schema to it and loads the sample data
(below). **It deletes everything**, users included, so the next step is always
creating an admin again:

```bash
npm run db:reset
AUTH_PASSWORD='yourpassword' npm run auth:user -- brian --role admin
```

## Loading the sample data

`npm run db:seed` writes the inserts for the example's sample data, one `.tab` file
per entity in `src/example/aida`, named after the entity (`docentes.tab`,
`evaluacion.preguntas.tab`).

```
npm run db:seed                # print it
npm run db:seed -- --apply     # load it into DATABASE_URL
```

## Updating the database

`npm run db:update` compares the system definition against the database and writes the SQL to keep it in sync with the definition (schemas, domains, tables, columns, keys, indexes).

```
npm run db:update                       # print what the database is missing
npm run db:update -- --apply            # add it
npm run db:update -- --drop             # print that, plus what has to go
npm run db:update -- --retype           # print that, plus the columns whose body changed
npm run db:update -- --drop --retype --apply
```

It always connects, since comparing means reading the database. If nothing differs, it writes no SQL. Applying is one statement, so a failure partway leaves the database untouched. Against an empty database it does what `db:create` does.

### `--drop`

`--drop` is permission to write a `drop`. Without it the command still *compares* but stops if a removal would be necessary.

If a foreign key points to different columns than before, it counts as dropping the old one and making a new one.

`--drop` only checks schemas the code mentions, but within those it'll want to delete anything it finds that the code doesn't mention.

### `--retype`

`--retype` is permission to change the body of a column that already holds data: its type or nullability. Without it the command still *compares* but stops and names each such column

A column are altered in place and the data is converted on the way.

### Adding a column to a table that has rows

A non-nullable column needs a `defaultValue` for the existing rows, a constant or a generator:

```ts
activo: { type: 'boolean', nullable: false, defaultValue: { value: true } },
alta:   { type: 'date',    nullable: false, defaultValue: { fn: 'today' } },
```

Without one, `db:update` stops and names the column instead. Empty tables allow either way.

## Managing users

`npm run auth:user` creates a user or edits an existing one. The user name is the
only positional argument. Everything else is a flag.

The password is read from the `AUTH_PASSWORD` environment variable, or typed at a
prompt if that variable is not set. It is never passed as an argument because the
shell history and `ps` would keep it.

This is the only way to create the first admin, there is no HTTP endpoint for it.

### General form

```
npm run auth:user -- <username> [--role <role>] [--active | --inactive] [--email <address>] [--no-password]
```

- `<username>` — the sole positional argument: the user to create or edit.
- `--role <role>` — permission level type.
- `--active` / `--inactive` — reactivate or deactivate. A deactivated user cannot
  log in and their existing sessions stop resolving.
- `--email <address>` — set the email (omit the argument to clear it).
- `--no-password` — edit the profile without reading or changing the password.

On an **existing** user, every field you don't pass keeps its current value.
On a **new** user the defaults are `--active`, no email, a password is mandatory (`--no-password`
means no way to log in), and  so is `--role`.

## Examples

### Create an admin

```bash
AUTH_PASSWORD='yourpassword' npm run auth:user -- brian --role admin --email brian@example.com
```

### Add users with narrower roles

```bash
AUTH_PASSWORD='yourpassword' npm run auth:user -- dlopez --role docente
AUTH_PASSWORD='yourpassword' npm run auth:user -- jacosta --role alumno
```

## Managing record locks

A claim on a record (SCOPE 6e) has no expiry: it stands until its holder lets it
go, or until somebody with `delete` on that entity takes it off them. If neither
can happen — the holder has left and no role is granted `delete` there — this is
the way out.

```bash
npm run locks                                  # every claim: entity, record, holder
npm run locks -- --user ada                    # only ada's
npm run locks -- --entity clases               # only this screen's
npm run locks -- --release --user ada          # let ada's go
npm run locks -- --release --entity clases     # let this screen's go
```

A record is named the way the address names it — the pk values joined with `/`,
so `clases 2026c1/bd/2` is the row `/clases/2026c1/bd/2`.

`--release` needs `--user` or `--entity`. Clearing every claim in the database in
one command is not offered, because a claim is somebody's unfinished work.

## Using the API from the terminal

The server listens on port 3000 by default (`PORT` to change it). The auth
endpoint is `/api/_auth`.

### Log in

```bash
curl -X POST localhost:3000/api/_auth \
  -H 'content-type: application/json' \
  -d '{"username":"brian","password":"yourpassword"}'
```

Returns `{"token": "...", ...}`, grab it, and:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/_auth \
  -H 'content-type: application/json' \
  -d '{"username":"brian","password":"yourpassword"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
```

### Make authenticated requests

```bash
curl localhost:3000/api/clases -H "Authorization: Bearer $TOKEN"
```

### Check who you are

```bash
curl localhost:3000/api/_auth -H "Authorization: Bearer $TOKEN"
```

### Log out

```bash
curl -X DELETE localhost:3000/api/_auth -H "Authorization: Bearer $TOKEN"
```
