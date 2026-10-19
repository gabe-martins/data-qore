# DataQore Web App

The DataQore web app provides the workspace for connections, datasets, profiles,
comparisons, and run history. It uses React, Vite, and TypeScript, with locally
served Inter fonts and the project's shared color tokens.

For a first installation, follow the [project quick start](../README.md#get-started).
The commands below run from the project root.

## Local development

With the databases, engine, worker, and controller already configured and running:

```bash
npm ci --prefix web
npm run dev --prefix web
```

Open [the web app](http://127.0.0.1:5173/). Vite forwards `/api` requests to the
controller at `127.0.0.1:3000`. The browser does not receive the engine API key.
Use `./dataqore.sh` to manage all local services together.

## Build and generated assets

```bash
npm run build --prefix web
```

The build checks TypeScript and writes the output to `web/dist`.
To inspect it locally with the controller running:

```bash
npm run preview --prefix web
```

Regenerate color tokens or API types only when their source files change:

```bash
npm run tokens:generate --prefix web
npm run types:generate --prefix web
```

Brand assets are SVG files in `public/branding/`: the full DataQore logo and
its standalone symbol. The app uses them on the sign-in screen, navigation,
header, and browser tab. Keep their proportions and original colors.

## Using the workspace

Start in **Connections** to add and test a data source. In **Catalog**, register
a table and open its dataset to run a profile. Use **Comparisons** to create or
run a comparison, then visit **Runs** to review progress and results.

Access tokens stay in memory; session renewal uses an HttpOnly cookie.
Saved connection passwords are not displayed when editing a connection.

Comparison rules show **Absolute tolerance (units)** and **Relative tolerance (%)**.
Enter `1` for 1% relative tolerance. Dot/comma decimals are accepted without
thousands separators. Absolute values retain the column's units. Help buttons
explain how the larger of the two limits is applied to numeric values and can
be opened with hover, focus or tap and closed with Escape. The API still uses
decimal fractions as strings; editing an existing comparison preserves its
numeric meaning. These limits do not represent a percentage of differing rows.

Exact conversion checks (no database required):

```bash
node --experimental-strip-types web/unit/tolerances.test.ts
```

## Browser checks

Install the test browser once:

```bash
cd web
npx playwright install chromium
cd ..
```

With local PostgreSQL binaries available, run the disposable full-stack fixture:

```bash
PYTHONPATH=engine:tests DATAQORE_PG_BIN=/PATH/TO/POSTGRESQL/bin \
  engine/.venv/bin/python -m unittest discover -s tests -v
```

The fixture creates a temporary PostgreSQL cluster, starts the services on free
ports, and supplies test accounts and SQLite sources. It does not use real local
environment files. Processes and the temporary cluster are removed afterward;
screenshots are written to the ignored `web/test-results/` directory.

Check branding on desktop and mobile, including the sign-in screen, header,
expanded mobile menu, and favicon. Deployment and HTTPS hosting are outside
the current local workflow.
