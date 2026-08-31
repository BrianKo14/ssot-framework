# Ops CLI

User-management CLI tool for the framework.

Everything here talks to the database directly.

## Managing users

`npm run auth:user` creates a user or edits an existing one. The user name is the
only positional argument. Everything else is a flag.

The password is read from the `AUTH_PASSWORD` environment variable, or typed at a
prompt if that variable is not set. It is never passed as an argument because the
shell history and `ps` would keep it.

This is the only way to create the first admin, there is no HTTP endpoint for it.

### General form

```
npm run auth:user -- <username> [--admin | --no-admin] [--active | --inactive] [--email <address>] [--no-password]
```

- `<username>` — the sole positional argument: the user to create or edit.
- `--admin` / `--no-admin` — grant or revoke admin rights.
- `--active` / `--inactive` — reactivate or deactivate. A deactivated user cannot
  log in and their existing sessions stop resolving.
- `--email <address>` — set the email (omit the argument to clear it).
- `--no-password` — edit the profile without reading or changing the password.

Paired flags are last-wins. On an **existing** user, every field you don't pass
keeps its current value. On a **new** user the defaults are `--no-admin`,
`--active`, no email, and a password is mandatory — so don't pass `--no-password`,
or the account is created with no way to log in.

## Examples

### Create an admin

```bash
AUTH_PASSWORD='yourpassword' npm run auth:user -- ada --admin --email ada@example.com
```

### Add a regular user

```bash
AUTH_PASSWORD='yourpassword' npm run auth:user -- bob
```

### Other user management flags

```bash
npm run auth:user -- bob --inactive          # deactivate (kills their sessions immediately)
npm run auth:user -- bob --active            # reactivate
npm run auth:user -- bob --email new@x.com   # update email only
npm run auth:user -- bob --no-password       # edit profile without touching the password
```

`--admin` / `--no-admin` toggle admin rights. Running the command again for an
existing name updates just the fields you pass; the rest stay as they were.

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
