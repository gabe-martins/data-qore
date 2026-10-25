# DataQore Web App

The DataQore web app provides the workspace for connections, datasets, critical comparison metrics,
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
a table and open its dataset to inspect metadata. Use **Comparisons** to create or
run a comparison, then visit **Runs** to review progress and results.

Access tokens stay in memory; session renewal uses an HttpOnly cookie.
Saved connection passwords are not displayed when editing a connection.

Open **Settings → Personal → Language** to choose **English** (the default)
or **Português (Brasil)**. Changes apply immediately and persist on this browser
under `dataqore.ui.language`, including cross-tab synchronization and the sign-in
screen. Language preferences need no database migration or account changes.

The user manual in **Settings → Help → User manual** (`/settings/manual`) follows
the selected language, including its topic index, HTML download and printing.
Its documents are [`English`](src/content/user-manual.en-US.html) and
[`Português (Brasil)`](src/content/user-manual.html). Both work offline.

Application copy is maintained in `src/i18n/pt-BR.ts`, with the original English
messages as stable keys. The language context and typed catalogs cover UI copy,
metric explanations, diagnostics, accessibility text and locale formatting.
Use interpolation for dynamic text and translate when rendering, so cached
results and drafts can switch language without being recreated. Never translate
source names, row values, SQL, API identifiers, JSON downloads or stored results.
Unknown technical errors retain their original details and request ID.

Comparison rules show **Absolute tolerance** and **Relative tolerance (fraction)**.
Enter `0.01` for 1% relative tolerance. Dot/comma decimals are accepted without
thousands separators. Absolute values retain the column's units. The form explains
fractions and the manual provides a worked example: the allowed difference is
the maximum of the absolute tolerance and the relative tolerance times the
larger absolute value. API tolerances use
decimal fractions as strings. These limits do not represent a percentage of
differing rows.

Exact conversion checks (no database required):

```bash
node --experimental-strip-types --test web/unit/tolerances.test.ts web/unit/language.test.ts
```

## Browser checks

Frontend regression and bilingual acceptance (API fixtures, no source writes):

```bash
npm run test:e2e --prefix web -- language.spec.ts user-manual.spec.ts settings.spec.ts access-control.spec.ts comparison-animation.spec.ts navigation-branding.spec.ts
```


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
