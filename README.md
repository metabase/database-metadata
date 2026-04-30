# Metabase Database Metadata Format

Metabase represents database metadata — synced databases, their tables, and their fields — as a tree of YAML files. Files are diff-friendly: numeric IDs are omitted entirely, and foreign keys use natural-key tuples like `["Sample Database", "PUBLIC", "ORDERS"]` instead of database identifiers.

This repository contains the specification, examples, and a CLI that converts the `table_metadata.json` downloaded from a Metabase workspace page into YAML.

## Specification

The format is defined in **[core-spec/v1/spec.md](core-spec/v1/spec.md)** (v1.0.4). It covers entity keys, field types, folder structure, sampled field values, and the shape of each entity.

Reference output for the Sample Database lives in **[examples/v1/](examples/v1/)** — both the raw `table_metadata.json` and the extracted YAML tree.

### Entities

| Entity | Description |
|--------|-------------|
| Database | A connected data source (Postgres, MySQL, BigQuery, etc.) |
| Table | A physical table (or view) inside a database |
| Field | A column on a table, including JSON-unfolded nested fields |

## Obtaining metadata

Metadata is downloaded as `table_metadata.json` from the Metabase workspace page (Workspaces → the relevant workspace → "Download table_metadata.json"). The file is a flat JSON document with three arrays — `databases`, `tables`, and `fields` — that even warehouses with very large schemas can produce without exhausting server memory.

### Extracting metadata to YAML

The CLI turns that JSON into the human- and agent-friendly YAML tree described in the spec:

```sh
bunx @metabase/database-metadata extract-table-metadata <input-file> <output-folder>
```

- `<input-file>` — path to the `table_metadata.json` downloaded from the workspace page.
- `<output-folder>` — destination directory. Database folders are created directly under it.

### Extracting field values

Metabase keeps a sampled list of distinct values for each field that's low-cardinality enough to enumerate (the same list that powers filter dropdowns in the UI). Download `field_values.json` from the same workspace page and extract it alongside the metadata:

```sh
bunx @metabase/database-metadata extract-field-values <metadata-file> <field-values-file> <output-folder>
```

- `<metadata-file>` — the same `table_metadata.json` used by `extract-table-metadata`. Field values reference fields by numeric ID, which the CLI resolves to natural keys using the metadata.
- `<field-values-file>` — path to the `field_values.json` downloaded from the workspace page.
- `<output-folder>` — destination directory; typically the same one used for `extract-table-metadata`, so values files land next to the table YAMLs they belong to.

One YAML file is written per field that has values. Fields with empty samples are skipped; field IDs not present in the metadata are reported as orphans and skipped. See the spec's [Field Values](core-spec/v1/spec.md#field-values) section for the on-disk shape and when agents should consult these files.

### Extracting the spec

The bundled spec can be extracted to any file — convenient for agents that need to read it locally:

```sh
bunx @metabase/database-metadata extract-spec --file ./spec.md
```

Omit `--file` to write `spec.md` into the current directory.

## Recommended workflow

The following is the **default** workflow for a project that wants to use Metabase metadata. It is a convention, not a requirement — teams are free to organize things differently.

### 1. A `.metadata/` directory at the repo root

Create a top-level `.metadata/` directory and **add it to `.gitignore`**. This is where the raw `table_metadata.json` and the extracted `databases/` YAML tree live:

```
.metadata/
├── table_metadata.json
└── databases/
    └── …
```

### 2. Why `.metadata/` should not be committed

On a large data warehouse the metadata export can easily reach **hundreds of megabytes or several gigabytes**. Committing it:

- bloats the repository and slows every clone and fetch,
- produces noisy diffs on unrelated PRs whenever someone resyncs,
- can make the repo effectively unusable for CI and for new contributors.

Each developer (or a CI job) fetches metadata on demand from their own Metabase instance instead.

### 3. Download from the workspace page and extract

Each developer downloads `table_metadata.json` (and optionally `field_values.json`) from the Metabase workspace page and drops them into `.metadata/`. Then run the extractors:

```sh
mkdir -p .metadata
# Drop table_metadata.json (and optionally field_values.json) from the workspace page into .metadata/

rm -rf .metadata/databases
bunx @metabase/database-metadata extract-table-metadata .metadata/table_metadata.json .metadata/databases
bunx @metabase/database-metadata extract-field-values .metadata/table_metadata.json .metadata/field_values.json .metadata/databases
```

After this, tools and agents should read the YAML tree under `.metadata/databases/` — not `table_metadata.json` or `field_values.json`, which exist only as input to the extractors.

## Publishing to NPM

Releases are published automatically by the **Release to NPM** GitHub Actions workflow on every push to `main`. The workflow compares the `version` in `package.json` against the version published on npm and publishes (with the `latest` dist-tag) if they differ.

To cut a release, bump `version` in `package.json` and merge to `main`.

The workflow requires an `NPM_RELEASE_TOKEN` secret with publish access to the `@metabase` npm org.

## Development

```sh
bun install
bun bin/cli.ts extract-table-metadata examples/v1/table_metadata.json /tmp/.metadata/databases
```

### Scripts

- `bun run build` — compile TypeScript to `dist/` and bundle the spec.
- `bun run type-check` — `tsc --noEmit`.
- `bun run lint-eslint` — ESLint with no warnings allowed.
- `bun run lint-format` — oxfmt format check.
- `bun run test` — bun test suite.

The **Lint**, **Test**, and **Validate** GitHub workflows run on every push and pull request. **Validate** regenerates the bundled examples and fails if they drift from what's checked in.
