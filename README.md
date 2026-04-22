# Metabase Database Metadata Format

Metabase represents database metadata — synced databases, their tables, and their fields — as a tree of YAML files. Files are diff-friendly: numeric IDs are omitted entirely, and foreign keys use natural-key tuples like `["Sample Database", "PUBLIC", "ORDERS"]` instead of database identifiers.

This repository contains the specification, examples, and a CLI that converts the JSON returned by Metabase's `GET /api/database/metadata` endpoint into YAML.

## Specification

The format is defined in **[core-spec/v1/spec.md](core-spec/v1/spec.md)** (v1.0.3). It covers entity keys, field types, folder structure, sampled field values, and the shape of each entity.

Reference output for the Sample Database lives in **[examples/v1/](examples/v1/)** — both the raw `metadata.json` returned by the endpoint and the extracted YAML tree.

### Entities

| Entity | Description |
|--------|-------------|
| Database | A connected data source (Postgres, MySQL, BigQuery, etc.) |
| Table | A physical table (or view) inside a database |
| Field | A column on a table, including JSON-unfolded nested fields |

## Obtaining metadata

Metadata is fetched on demand from a running Metabase instance via `GET /api/database/metadata`. The response is a flat JSON document with three arrays — `databases`, `tables`, and `fields` — streamed so that even warehouses with very large schemas can be exported without exhausting server memory.

Authenticate with an API key (`X-API-Key`) or session token (`X-Metabase-Session`).

### Downloading metadata

The CLI can fetch `metadata.json`, `field-values.json`, and extract the YAML tree in one streaming pass:

```sh
export METABASE_API_KEY=...
bunx @metabase/database-metadata download-metadata "$METABASE_URL"
```

With no flags, the command writes:

- `.metabase/metadata.json`
- `.metabase/field-values.json`
- `.metabase/databases/` — extracted YAML tree

Flags override any default or opt out of individual steps:

| Flag | Default | Purpose |
|------|---------|---------|
| `--metadata <path>` | `.metabase/metadata.json` | Where to write the raw metadata JSON |
| `--field-values <path>` | `.metabase/field-values.json` | Where to write the raw field-values JSON |
| `--extract <folder>` | `.metabase/databases` | Where to extract the YAML tree |
| `--no-field-values` | — | Skip downloading field values |
| `--no-extract` | — | Skip YAML extraction |
| `--api-key <key>` | `METABASE_API_KEY` env var | API key |

Files are streamed to disk directly — responses are never fully buffered in memory, so multi-GB exports stay lean.

### Extracting metadata to YAML

If you already have a `metadata.json` on disk (e.g. downloaded via `curl`), you can skip the download and extract directly:

```sh
bunx @metabase/database-metadata extract-metadata <input-file> <output-folder>
```

- `<input-file>` — path to the `metadata.json` produced by the API.
- `<output-folder>` — destination directory. Database folders are created directly under it.

### Extracting field values

Metabase keeps a sampled list of distinct values for each field that's low-cardinality enough to enumerate (the same list that powers filter dropdowns in the UI).

```sh
bunx @metabase/database-metadata extract-field-values <metadata-file> <field-values-file> <output-folder>
```

- `<metadata-file>` — the same `metadata.json` used by `extract-metadata`. Field values reference fields by numeric ID, which the CLI resolves to natural keys using the metadata.
- `<field-values-file>` — path to the `field-values.json` returned by the endpoint.
- `<output-folder>` — destination directory; typically the same one used for `extract-metadata`, so values files land next to the table YAMLs they belong to.

One YAML file is written per field that has values. Fields with empty samples are skipped; field IDs not present in the metadata are reported as orphans and skipped. See the spec's [Field Values](core-spec/v1/spec.md#field-values) section for the on-disk shape and when agents should consult these files.

### Uploading metadata to a target instance

`upload-metadata` streams the JSON files previously written by `download-metadata` into a target Metabase instance, remapping numeric IDs across multiple NDJSON passes (see [metabase-api-contract.md](metabase-api-contract.md)):

```sh
export METABASE_API_KEY=...
bunx @metabase/database-metadata upload-metadata "$TARGET_METABASE_URL"
```

With no flags, it reads `.metabase/metadata.json` and `.metabase/field-values.json` — the same layout `download-metadata` writes by default.

| Flag | Default | Purpose |
|------|---------|---------|
| `--metadata <path>` | `.metabase/metadata.json` | Path to the metadata JSON to upload |
| `--field-values <path>` | `.metabase/field-values.json` | Path to the field-values JSON |
| `--no-field-values` | — | Skip uploading field values |
| `--api-key <key>` | `METABASE_API_KEY` env var | API key |

The source JSON files are streamed through `@streamparser/json-node` — they are never fully loaded into memory, so 100 GB+ exports upload fine. Rows are sent in batches of 2000 per HTTP POST (matching the server's per-transaction batch size) with HTTP keep-alive, so each request is one clean server-side transaction.

Exits non-zero if any step reports row-level errors, or if the server acknowledges fewer rows than were sent in a batch (so CI can catch partial imports).

### Extracting the spec

The bundled spec can be extracted to any file — convenient for agents that need to read it locally:

```sh
bunx @metabase/database-metadata extract-spec --file ./spec.md
```

Omit `--file` to write `spec.md` into the current directory.

## Recommended workflow

The following is the **default** workflow for a project that wants to use Metabase metadata. It is a convention, not a requirement — teams are free to organize things differently.

### 1. A `.metabase/` directory at the repo root

Create a top-level `.metabase/` directory and **add it to `.gitignore`**. This is where the raw `metadata.json` and the extracted `databases/` YAML tree live:

```
.metabase/
├── metadata.json
└── databases/
    └── …
```

### 2. Why `.metabase/` should not be committed

On a large data warehouse the metadata export can easily reach **hundreds of megabytes or several gigabytes**. Committing it:

- bloats the repository and slows every clone and fetch,
- produces noisy diffs on unrelated PRs whenever someone resyncs,
- can make the repo effectively unusable for CI and for new contributors.

Each developer (or a CI job) fetches metadata on demand from their own Metabase instance instead.

### 3. Credentials via a gitignored `.env` file

Check in an **`.env.template`** at the repo root with placeholders:

```env
METABASE_URL=https://metabase.example.com
METABASE_API_KEY=
```

Each developer copies it to `.env` (also gitignored) and fills in the real values:

```sh
cp .env.template .env
# edit .env to set METABASE_URL and METABASE_API_KEY
```

### 4. Fetch and extract on demand

With `.env` populated, the end-to-end flow is a single command:

```sh
set -a; source .env; set +a

rm -rf .metabase/databases
bunx @metabase/database-metadata download-metadata "$METABASE_URL"
```

That downloads `.metabase/metadata.json`, `.metabase/field-values.json`, and extracts the YAML tree into `.metabase/databases/`. Use `--no-field-values` or `--no-extract` to skip parts of the pipeline.

After this, tools and agents should read the YAML tree under `.metabase/databases/` — not `metadata.json` or `field-values.json`, which exist only as input to the extractors.

## Publishing to NPM

Releases are published automatically by the **Release to NPM** GitHub Actions workflow on every push to `main`. The workflow compares the `version` in `package.json` against the version published on npm and publishes (with the `latest` dist-tag) if they differ.

To cut a release, bump `version` in `package.json` and merge to `main`.

The workflow requires an `NPM_RELEASE_TOKEN` secret with publish access to the `@metabase` npm org.

## Development

```sh
bun install
bun bin/cli.ts extract-metadata examples/v1/metadata.json /tmp/.metabase/databases
```

### Scripts

- `bun run build` — compile TypeScript to `dist/` and bundle the spec.
- `bun run type-check` — `tsc --noEmit`.
- `bun run lint-eslint` — ESLint with no warnings allowed.
- `bun run lint-format` — oxfmt format check.
- `bun run test` — bun test suite.

The **Lint**, **Test**, and **Validate** GitHub workflows run on every push and pull request. **Validate** regenerates the bundled examples and fails if they drift from what's checked in.
