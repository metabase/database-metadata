# Metabase Database Metadata Format

Metabase represents database metadata — synced databases, their tables, and their fields — as a tree of YAML files. Files are diff-friendly: numeric IDs are omitted entirely, and foreign keys use natural-key tuples like `["Sample Database", "PUBLIC", "ORDERS"]` instead of database identifiers.

This repository contains the specification, examples, and a CLI that converts the JSON returned by Metabase's `GET /api/database/metadata` endpoint into YAML.

## Contents

- **[core-spec/v1/spec.md](core-spec/v1/spec.md)** — Full specification (v1.0.0) covering entity keys, field types, folder structure, and each entity shape.
- **[examples/v1/](examples/v1/)** — Reference output using the Sample Database, in both modes.
- **[src/](src/)** / **[bin/](bin/)** — The CLI implementation.

## Entities

| Entity | Description |
|--------|-------------|
| Database | A connected data source (Postgres, MySQL, BigQuery, etc.) |
| Table | A physical table (or view) inside a database |
| Field | A column on a table, including JSON-unfolded nested fields |

See [core-spec/v1/spec.md](core-spec/v1/spec.md) for the full schema of each entity.

## CLI

### Input: `metadata.json`

The CLI operates on a JSON snapshot produced by Metabase's `GET /api/database/metadata` endpoint. Fetch it against any running Metabase instance:

```sh
mkdir -p .metabase
curl "https://my.metabase/api/database/metadata" \
  -H "X-Metabase-Session: $SESSION_TOKEN" \
  > .metabase/metadata.json
```

The response is a flat structure with three arrays — `databases`, `tables`, and `fields` — streamed for large schemas. Authenticate with either a session token (`X-Metabase-Session`) or an API key (`X-API-Key`).

### Extract metadata to YAML

```sh
bunx @metabase/database-metadata extract-metadata <input-file> <output-folder> [--mode <mode>]
```

- `<input-file>` — path to the `metadata.json` produced by the API.
- `<output-folder>` — destination directory. By convention this is `.metabase/databases` at the project root (see [spec.md](core-spec/v1/spec.md#folder-structure)). Database folders are created directly under it, so pass `.metabase/databases` to get a `databases/` parent.
- `--mode` — either `default` (the default) or `serdes`.

The typical end-to-end invocation:

```sh
bunx @metabase/database-metadata extract-metadata .metabase/metadata.json .metabase/databases
```

#### Modes

| Mode | Purpose | Layout |
|------|---------|--------|
| `default` | Compact on-disk representation for agent and human access. Diff-friendly, minimal. | One YAML per database + one per table with fields nested inside. No `serdes/meta`. |
| `serdes`  | The format expected by Metabase's serialization importer (`POST /api/ee/serialization/import`). | Separate YAML per database, table, and field — each with `serdes/meta`, `active: true`, and full foreign-key tuples. |

### Extract the spec

Copy the bundled `spec.md` to a target file:

```sh
bunx @metabase/database-metadata extract-spec --file ./spec.md
```

Omit `--file` to write `spec.md` into the current directory.

## Publishing to NPM

Releases are published automatically by the **Release to NPM** GitHub Actions workflow on every push to `main`. The workflow compares the `version` in `package.json` against the version published on npm and publishes (with the `latest` dist-tag) if they differ.

To cut a release, bump `version` in `package.json` and merge to `main`.

The workflow requires an `NPM_RELEASE_TOKEN` secret with publish access to the `@metabase` npm org.

## Development

```sh
bun install
bun bin/cli.js extract-metadata examples/v1/metadata.json /tmp/.metabase/databases
```

GitHub workflows in addition to the release workflow:

- **Validate** — regenerates the bundled examples on every push and fails if they drift from what's checked in.
- **Import** — feeds the `serdes` example folder into a fresh Metabase Enterprise container and asserts that `/api/ee/serialization/import` returns `200`.
