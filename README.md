# Metabase Database Metadata Format

Metabase represents database metadata — synced databases, their tables, and their fields — as a tree of YAML files. Files are diff-friendly: numeric IDs are omitted entirely, and foreign keys use natural-key tuples like `["Sample Database", "PUBLIC", "ORDERS"]` instead of database identifiers.

This repository contains the specification, examples, and a CLI that converts the JSON returned by Metabase's `GET /api/database/metadata` endpoint into YAML.

## Specification

The format is defined in **[core-spec/v1/spec.md](core-spec/v1/spec.md)** (v1.0.0). It covers entity keys, field types, folder structure, and the shape of each entity.

Reference output for the Sample Database lives in **[examples/v1/](examples/v1/)** — both the raw `metadata.json` returned by the endpoint and the extracted YAML tree.

### Entities

| Entity | Description |
|--------|-------------|
| Database | A connected data source (Postgres, MySQL, BigQuery, etc.) |
| Table | A physical table (or view) inside a database |
| Field | A column on a table, including JSON-unfolded nested fields |

## Obtaining metadata

Metadata is fetched on demand from a running Metabase instance via `GET /api/database/metadata`. The response is a flat JSON document with three arrays — `databases`, `tables`, and `fields` — streamed so that even warehouses with very large schemas can be exported without exhausting server memory.

Authenticate with either a session token (`X-Metabase-Session`) or an API key (`X-API-Key`):

```sh
curl "$METABASE_URL/api/database/metadata" \
  -H "X-API-Key: $METABASE_API_KEY" \
  -o metadata.json
```

### Extracting metadata to YAML

The CLI turns that JSON into the human- and agent-friendly YAML tree described in the spec:

```sh
bunx @metabase/database-metadata extract-metadata <input-file> <output-folder>
```

- `<input-file>` — path to the `metadata.json` produced by the API.
- `<output-folder>` — destination directory. Database folders are created directly under it.

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

With `.env` populated, the end-to-end flow is:

```sh
set -a; source .env; set +a

mkdir -p .metabase
curl -sf "$METABASE_URL/api/database/metadata" \
  -H "X-API-Key: $METABASE_API_KEY" \
  -o .metabase/metadata.json

rm -rf .metabase/databases
bunx @metabase/database-metadata extract-metadata .metabase/metadata.json .metabase/databases
```

After this, tools and agents should read the YAML tree under `.metabase/databases/` — not `metadata.json`, which exists only as input to the extractor.

## Publishing to NPM

Releases are published automatically by the **Release to NPM** GitHub Actions workflow on every push to `main`. The workflow compares the `version` in `package.json` against the version published on npm and publishes (with the `latest` dist-tag) if they differ.

To cut a release, bump `version` in `package.json` and merge to `main`.

The workflow requires an `NPM_RELEASE_TOKEN` secret with publish access to the `@metabase` npm org.

## Development

```sh
bun install
bun bin/cli.js extract-metadata examples/v1/metadata.json /tmp/.metabase/databases
```

The **Validate** GitHub workflow regenerates the bundled examples on every push and fails if they drift from what's checked in.
