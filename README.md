# Metabase Database Metadata

CLI tool for extracting Metabase database metadata (databases, tables, and fields) into YAML files.

Two modes are supported:

- **`default`** — a compact on-disk representation meant for agent and human access: diff-friendly, minimal IDs, fields nested inside their tables.
- **`serdes`** — the format expected by Metabase's serialization importer. Use this mode when you want to round-trip edits back into a Metabase instance via `POST /api/ee/serialization/import`.

## Contents

- **[core-spec/v1/spec.md](core-spec/v1/spec.md)** — Full specification (v1.0.0) covering entity keys, field types, folder structure, and each entity shape.
- **[examples/v1/](examples/v1/)** — Reference output for both modes, using the Sample Database.
- **[src/](src/)** / **[bin/](bin/)** — The CLI implementation.

## Input: `metadata.json`

The CLI operates on a JSON snapshot produced by Metabase's `GET /api/database/metadata` endpoint. Fetch it against any running Metabase instance:

```sh
curl "https://my.metabase/api/database/metadata" \
  -H "X-Metabase-Session: $SESSION_TOKEN" \
  > metadata.json
```

The response is a flat structure with three arrays — `databases`, `tables`, and `fields` — streamed for large schemas. Authenticate with either a session token (`X-Metabase-Session`) or an API key (`X-API-Key`).

## CLI

### Extract metadata to YAML

```sh
bunx @metabase/database-metadata extract-metadata <input-file> <output-folder> [--mode <mode>]
```

Arguments:

- `<input-file>` — path to the `metadata.json` produced by the API.
- `<output-folder>` — destination directory. The tool writes `databases/<slug>/...` under it.

Modes:

| Mode | Purpose | Layout |
|------|---------|--------|
| `default` (default) | On-disk representation for agent/human access | One YAML per database + one per table with fields nested inside. No `serdes/meta`. |
| `serdes`            | Import back into Metabase                     | Separate YAML per database, table, and field — each with `serdes/meta`, `active: true`, and full foreign-key tuples. Feed to `POST /api/ee/serialization/import`. |

### Extract the spec

Copy the bundled `spec.md` into a target file:

```sh
bunx @metabase/database-metadata extract-spec --file ./spec.md
```

Omit `--file` to write `spec.md` into the current directory.

## Development

```sh
bun install
bun bin/cli.js extract-metadata examples/v1/metadata.json /tmp/out
```

GitHub workflows:

- **Validate** — regenerates the bundled examples on every push and fails if they drift from what's checked in.
- **Import** — feeds the `serdes` example folder into a fresh Metabase Enterprise container and asserts that `/api/ee/serialization/import` returns `200`.
- **Release** — on pushes to `main`, compares the local `package.json` version with the published one and publishes to NPM when they differ.
