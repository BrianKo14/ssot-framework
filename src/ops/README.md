# Ops CLI

Command-line tools for the framework: creating the database, and managing users.

Everything here talks to the database directly.

## Creating the database

`npm run db:create` writes the SQL that creates the schema (domains, tables, primary/unique/foreign keys, indexes, etc.) to stdout.

```
npm run db:create              # print it
npm run db:create -- --apply   # run it against DATABASE_URL
```

`--apply` is optional. If you don't pass it, the SQL is printed to stdout. If you do, it is applied to the database specified in `DATABASE_URL` (or the default in `.env`).

`npm run db:reset` is the whole cycle for development: it destroys the Postgres
volume, starts a fresh one and applies the schema to it. **It deletes
everything**, users included, so the next step is always creating an admin
again:

```bash
npm run db:reset
AUTH_PASSWORD='yourpassword' npm run auth:user -- brian --role admin
```

The database that comes out is empty.

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
AUTH_PASSWORD='yourpassword' npm run auth:user -- emilio --role profesor
```

## Using the API from the terminal

The server listens on port 3000 by default (`PORT` to change it). The auth
endpoint is `/api/_auth`.

### Log in

```bash
curl -X POST localhost:3000/api/_auth \
  -H 'content-type: application/json' \
  -d '{"username":"ada","password":"yourpassword"}'
```

Returns `{"token": "...", ...}`, grab it, and:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/_auth \
  -H 'content-type: application/json' \
  -d '{"username":"ada","password":"yourpassword"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
```

### Make authenticated requests

```bash
curl localhost:3000/api/reserva -H "Authorization: Bearer $TOKEN"
```

### Check who you are

```bash
curl localhost:3000/api/_auth -H "Authorization: Bearer $TOKEN"
```

### Log out

```bash
curl -X DELETE localhost:3000/api/_auth -H "Authorization: Bearer $TOKEN"
```
