# ssot-framework

A framework that generates a backend (CRUD + auth) and a database schema from
one system definition, instead of writing SQL and endpoints by hand.

### Point `system-definition` at the local fork

This project depends on [`system-definition`](https://github.com/BrianKo14/system-definition),
a descriptive vocabulary layer. `package.json` lists the public npm
package (`^0.1.3`), but the latest version exists on a **fork** not yet published to npm.

Until that's published, `npm install` leads to a broken installation.

Clone the fork as a sibling of this repo, then link the fork in:

```bash
cd ..
git clone https://github.com/BrianKo14/system-definition.git
cd system-definition
git checkout schema-por-entidad
npm install
npm run build
npm link                       # registers this folder as the "system-definition" package

cd ../ssot-framework
npm link system-definition     # makes this project use that registered folder
```

This creates a symlink in `node_modules/system-definition` pointing at the
fork, instead of downloading the real package. It's local to your machine.
Running plain `npm install` again, or cloning this repo elsewhere, will not
carry the link with it, and the build will fail.

This is a temporary arrangement until the fork's change is published (see
`DECISIONS.md`, *Dependencies*).

Whenever you change something in the fork, rebuild it (`npm run build`
inside `system-definition`). This project reads its compiled `dist/`
output, not its source.

### Configure environment variables

Create a `.env` file in the project root:

```bash
DATABASE_URL=postgres://app:app@localhost:5433/appdb
PORT=3000
```

`DATABASE_URL` is required. `PORT` defaults to `3000` if omitted. Two more
are optional: `SESSION_TTL` (login session lifetime, ISO-8601 duration,
default `PT8H`) and `COOKIE_SECURE` (`true`/`false`, default `false`).

### Start the database

```bash
npm run build
npm run start
```

Then create the admin user using the CLI (see `src/ops/README.md`):

```bash
AUTH_PASSWORD='yourpassword' npm run auth:user -- brian --role admin
```

The app serves on `http://localhost:<PORT>` (default `3000`).