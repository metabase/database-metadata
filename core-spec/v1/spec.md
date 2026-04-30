# Metabase Database Metadata Format

**Version:** 1.0.4

## Overview

Metabase database metadata is a read-only snapshot of databases, tables, and fields that have been synced from a connected data source. This specification describes the **default** format for exporting that metadata to disk: one YAML file per database, and one YAML file per table with its fields nested inside.

The format is designed to be **portable** and **reviewable**: numeric IDs are omitted or replaced with human-readable natural keys (database name, `[database, schema, table]` tuples, etc.). Files can be diffed, grepped, and edited by hand.

The raw `table_metadata.json` (downloaded from the Metabase workspace page) is a single flat JSON document with `databases`, `tables`, and `fields` arrays, optimized for transport rather than reading. It can be arbitrarily large — tens or hundreds of megabytes on warehouses with many tables — and is not intended for direct consumption. Tools and humans should read the extracted YAML tree under `databases/` instead, where each entity lives in its own small file and foreign keys are resolved to natural-key tuples.

## Table of Contents

1. [Entity Keys](#entity-keys)
2. [Field Types](#field-types)
3. [Folder Structure](#folder-structure)
4. [Database](#database)
5. [Table](#table)
6. [Field](#field)
7. [Field Values](#field-values)

---

## Entity Keys

Database objects are referenced using natural keys instead of numeric IDs.

| Reference | Format | Example |
|-----------|--------|---------|
| Database FK | database name | `"Sample Database"` |
| Table FK | `[database, schema, table]` | `["Sample Database", "PUBLIC", "ORDERS"]` |
| Field FK | `[database, schema, table, field, ...]` | `["Sample Database", "PUBLIC", "ORDERS", "TOTAL"]` |

For schemaless databases, the schema component is `null` (e.g., `["My Database", null, "my_table"]`).

For JSON-unfolded fields, the Field FK extends beyond 4 elements with the nested path: `["Sample Database", "PUBLIC", "EVENTS", "DATA", "user", "name"]` represents the JSON path `DATA.user.name`.

Numeric primary keys (`id`) are not emitted. Each entity is identified by its position in the folder tree and by the natural-key foreign keys on child entities.

---

## Field Types

Each field has four type attributes that describe the column at different layers: `database_type` (the native SQL type), `base_type` (the matching Metabase type), `effective_type` (the type after any coercion), and `semantic_type` (the business-domain role). An optional `coercion_strategy` defines the rule that produces `effective_type` from `base_type`.

### `database_type`

The native SQL type reported by the database driver, verbatim (e.g., `BIGINT`, `VARCHAR`, `DOUBLE PRECISION`, `TIMESTAMP WITH TIME ZONE`, `JSONB`). This value is **database-specific**: the same logical type can appear with different spellings across engines (`INT4` vs `INTEGER`, `CHARACTER VARYING` vs `VARCHAR`, `DOUBLE` vs `DOUBLE PRECISION`). Metabase uses `database_type` for informational purposes and when generating native SQL; it is not portable across engines.

`database_type` always maps deterministically to a `base_type` for a given driver — see the table below for typical pairings.

### `base_type`

The raw Metabase type that matches the column's native database type. This is what the driver reports the column as (e.g., a Postgres `BIGINT` → `type/BigInteger`, `VARCHAR` → `type/Text`, `DOUBLE PRECISION` → `type/Float`).

`base_type` is always one of the types below and never a semantic type like `type/PK`.

Common base types (selected from the type hierarchy):

| Base type | Meaning | Typical native types |
|-----------|---------|----------------------|
| `type/Boolean` | Boolean | `BOOLEAN`, `BIT` |
| `type/Integer` | Signed integer | `INTEGER`, `INT`, `SMALLINT` |
| `type/BigInteger` | Wide integer | `BIGINT` |
| `type/Float` | Binary floating-point | `DOUBLE`, `REAL`, `FLOAT` |
| `type/Decimal` | Fixed-precision decimal | `DECIMAL`, `NUMERIC` |
| `type/Text` | Variable-length text | `VARCHAR`, `TEXT`, `CHARACTER` |
| `type/UUID` | UUID (a `type/Text` subtype) | `UUID` |
| `type/Date` | Date without time | `DATE` |
| `type/Time` | Time of day | `TIME` |
| `type/TimeWithLocalTZ` | Time stored at UTC | `TIME WITH TIME ZONE` |
| `type/DateTime` | Local date-time (no offset) | `TIMESTAMP`, `DATETIME` |
| `type/DateTimeWithLocalTZ` | Date-time stored at UTC | `TIMESTAMP WITH TIME ZONE` |
| `type/Instant` | Absolute point in time | (see coercion strategies) |
| `type/Structured` | JSON/structured payload | `JSON`, `JSONB` |
| `type/*` | Unknown / fallback | — |

### `effective_type`

The type Metabase actually treats the column as when running queries. If no coercion is applied, `effective_type` equals `base_type` and is omitted from the YAML. It is emitted only when coercion changes the type.

For example: a `VARCHAR` column whose `base_type` is `type/Text` but that stores ISO-8601 timestamps would have `effective_type: type/DateTime` and `coercion_strategy: Coercion/ISO8601->DateTime`.

### `coercion_strategy`

An optional rule that tells Metabase how to convert `base_type` → `effective_type` at query time. Absent unless coercion is configured.

Built-in coercion strategies:

| Strategy | `base_type` | `effective_type` |
|----------|-------------|------------------|
| `Coercion/UNIXSeconds->DateTime` | `type/Integer`, `type/Decimal` | `type/Instant` |
| `Coercion/UNIXMilliSeconds->DateTime` | `type/Integer`, `type/Decimal` | `type/Instant` |
| `Coercion/UNIXMicroSeconds->DateTime` | `type/Integer`, `type/Decimal` | `type/Instant` |
| `Coercion/UNIXNanoSeconds->DateTime` | `type/Integer`, `type/Decimal` | `type/Instant` |
| `Coercion/ISO8601->Date` | `type/Text` | `type/Date` |
| `Coercion/ISO8601->Time` | `type/Text` | `type/Time` |
| `Coercion/ISO8601->DateTime` | `type/Text` | `type/DateTime` |
| `Coercion/YYYYMMDDHHMMSSString->Temporal` | `type/Text` | `type/DateTime` |
| `Coercion/DateTime->Date` | `type/DateTime` | `type/Date` |

### `semantic_type`

An optional label describing how the column is used in the business domain. Semantic types sit in a separate hierarchy (rooted at `Semantic/*` or `Relation/*`) and don't affect how values are read or converted — they drive UI choices (icons, default visualizations, filter widgets) and some analytical behavior (e.g., auto-binning for `type/Category`).

Common semantic types, grouped by purpose:

| Group | Semantic types |
|-------|----------------|
| Relations | `type/PK`, `type/FK` |
| Identity / labels | `type/Name`, `type/Title`, `type/Description`, `type/Comment` |
| Categorization | `type/Category`, `type/Enum`, `type/Source`, `type/Product`, `type/Company`, `type/Subscription` |
| Geography | `type/City`, `type/State`, `type/Country`, `type/ZipCode`, `type/Latitude`, `type/Longitude`, `type/IPAddress` |
| Contact | `type/Email`, `type/URL`, `type/ImageURL`, `type/AvatarURL` |
| Money / numeric | `type/Currency`, `type/Price`, `type/Cost`, `type/Income`, `type/Discount`, `type/GrossMargin`, `type/Percentage`, `type/Share`, `type/Score`, `type/Quantity`, `type/Duration` |
| Temporal roles | `type/CreationTimestamp`, `type/CreationDate`, `type/JoinTimestamp`, `type/CancelationTimestamp`, `type/DeletionTimestamp`, `type/UpdatedTimestamp`, `type/Birthdate` |
| Other | `type/User`, `type/Structured` |

`semantic_type` is always compatible with `effective_type` (or `base_type` when no coercion is in play) — e.g., `type/Latitude` only makes sense on `type/Float`, `type/Email` only on `type/Text`.

---

## Folder Structure

By convention, metadata is extracted under a `.metabase/databases/` directory, with each database occupying its own folder. The exporter itself doesn't enforce this location; it writes the tree below into whatever folder the caller passes.

```
.metabase/
└── databases/
    └── {database}/
        ├── {database}.yaml
        ├── schemas/
        │   └── {schema}/
        │       └── tables/
        │           ├── {table}.yaml
        │           └── {table}/            # Optional: one YAML per field
        │               └── {field}.yaml    #           that has sampled values
        └── tables/                         # Schemaless databases
            ├── {table}.yaml
            └── {table}/
                └── {field}.yaml
```

### Path Construction Rules

- Database, schema, and table names are used verbatim as folder and file names. Case and spaces are preserved (e.g. `Sample Database/`, `PUBLIC/`, `ORDERS.yaml`).
- Only characters that are invalid in paths are escaped: `/` becomes `__SLASH__`, `\` becomes `__BACKSLASH__`.
- A database's YAML file (`{name}.yaml`) lives at the root of its folder.
- Tables are nested under `schemas/{schema}/tables/{table}.yaml` when the database has schemas, or directly under `tables/{table}.yaml` for schemaless databases.
- A table's YAML file embeds all of its fields inline — there is no separate file per field.

---

## Database

A `Database` entry describes a connected data source (e.g., a Postgres or MySQL instance). Only identifying information is included; connection details are not part of this format.

The database YAML file lives at `databases/{slug}/{slug}.yaml`.

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Database name (unique, used as the Database FK) |
| `engine` | string | Yes | Database engine (e.g., `postgres`, `mysql`, `h2`, `bigquery-cloud-sdk`) |

### Example

```yaml
name: Sample Database
engine: postgres
```

---

## Table

A `Table` entry describes a single physical table (or view) within a database. Its fields are nested directly in the same YAML file.

The table YAML file lives at `databases/{db_slug}/schemas/{schema_slug}/tables/{table_slug}.yaml` (or `databases/{db_slug}/tables/{table_slug}.yaml` for schemaless databases).

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Table name in the database |
| `db_id` | string | Yes | Database FK (database name) |
| `fields` | array | Yes | Array of [Field](#field) entries belonging to this table |
| `schema` | string | No | Schema name; omitted for schemaless databases |
| `description` | string | No | Human-readable description |

### Example

```yaml
name: ORDERS
db_id: Sample Database
schema: PUBLIC
description: Confirmed Sample Company orders for a product, from a user.
fields:
  - name: ID
    base_type: type/BigInteger
    database_type: BIGINT
    semantic_type: type/PK
  - name: TOTAL
    description: The total billed amount.
    base_type: type/Float
    database_type: DOUBLE PRECISION
```

---

## Field

A `Field` entry describes a single column. Fields are nested inline inside their [Table](#table); there is no separate field file.

A field's table is implied by its position in the enclosing table's `fields` array, so `table_id` is not emitted on nested fields. Only `parent_id` appears when the field is a child of another field (e.g., JSON-unfolded nested columns).

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Column name in the database |
| `database_type` | string | Yes | Native database type (e.g., `INTEGER`, `VARCHAR`) |
| `base_type` | string | Yes | Metabase type matching the native type. See [Field Types](#field-types) |
| `description` | string | No | Human-readable description |
| `effective_type` | string | No | Type after coercion; omitted when equal to `base_type`. See [Field Types](#field-types) |
| `coercion_strategy` | string | No | Coercion rule applied at query time. See [Field Types](#field-types) |
| `semantic_type` | string | No | Business-domain label (e.g., `type/PK`, `type/Email`). See [Field Types](#field-types) |
| `parent_id` | array | No | Field FK of the parent field, for nested/JSON-unfolded columns |
| `fk_target_field_id` | array | No | Field FK of the referenced primary-key column, for fields with `semantic_type: type/FK` |

### Example

```yaml
name: CREATED_AT
description: The order creation timestamp.
base_type: type/Text
database_type: TEXT
effective_type: type/DateTime
semantic_type: type/CreationTimestamp
coercion_strategy: Coercion/ISO8601->DateTime
```

### Nested Fields

JSON-unfolded columns use `parent_id` to reference the enclosing field:

```yaml
name: name
base_type: type/Text
database_type: TEXT
parent_id:
  - Sample Database
  - PUBLIC
  - EVENTS
  - DATA
  - user
```

---

## Field Values

A `Field Values` entry records the **sampled distinct values** Metabase keeps for a single field. These power filter dropdowns in the Metabase UI and give agents a concrete sense of a column's domain — what values actually appear in the data, and what human-readable labels (if any) are associated with them.

Field values are **sampled, not exhaustive**: Metabase caps the list (typically at ~1000 distinct values), and fields above that cap, or fields whose type doesn't lend itself to enumeration (long text, high-cardinality numerics), will not have a values file at all. Agents should treat a field values file as evidence that *these* values exist, not as a ground-truth enumeration of *all* values in the column.

### Extraction order

**Field values must be extracted *after* metadata, never before or in isolation.** The raw `field_values.json` references fields by numeric `field_id` only; resolving those IDs to the natural-key tuples used everywhere in this format requires the metadata index. The extractor takes both `table_metadata.json` and `field_values.json` as inputs, and the two **must come from the same Metabase workspace download at the same point in time** — a stale metadata file paired with a fresh values file (or vice versa) will silently drop entries as orphans whenever a field has been added, removed, or had its ID reassigned.

The recommended workflow is therefore strictly sequential:

1. Download `table_metadata.json` from the Metabase workspace page.
2. Run `extract-metadata` to write the database/table/field YAML tree.
3. Download `field_values.json` from the **same** workspace, ideally back-to-back with step 1.
4. Run `extract-field-values` against the same output folder to drop per-field values files into the existing tree.

Agents reading the tree can rely on this ordering: any `{table}/{field}.yaml` file is guaranteed to have a corresponding entry in the parent `{table}.yaml`'s `fields` array.

### When to consult field values

- Filtering by a categorical, enum-like, or low-cardinality column — the values file tells you the vocabulary you can filter against.
- Checking whether a particular value appears in a field.
- Showing example values or options to users.
- Distinguishing between display labels and stored values (e.g., a numeric `RATING` column stored as `0-5` but displayed as `Unrated`, `Poor`, …, `Excellent`).

### Folder layout

Field values live one directory down from the table YAML, in a folder named after the table:

```
schemas/{schema}/tables/
├── {table}.yaml
└── {table}/
    └── {field}.yaml
```

For schemaless databases, the same pattern applies directly under `tables/`.

**Absence is meaningful:** if a table has no `{table}/` folder, or a field has no `{field}.yaml`, then no sampled values are available for that entity. This is not an error — it's the default for high-cardinality or non-enumerable fields.

### Filename rule

The field filename is the field's name directly (e.g., `STATUS.yaml`). For nested JSON-unfolded fields, the path is joined with `.`:

```
tables/EVENTS/
└── DATA.user.name.yaml         # represents DATA → user → name
```

Literal dots inside a field segment are escaped as `__DOT__` so the join remains unambiguous.

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field_id` | array | Yes | Field FK (natural-key tuple, same form as in the enclosing table YAML) |
| `has_more_values` | boolean | Yes | `true` when Metabase truncated the list at its internal cap; the file contains a representative sample, not the full domain |
| `values` | array | Yes | Sampled distinct values. Two encodings — see below |

#### `values` encoding

When no human-readable labels exist, values are bare scalars:

```yaml
field_id:
  - Sample Database
  - PUBLIC
  - PEOPLE
  - STATE
has_more_values: false
values:
  - AK
  - AL
  - AR
```

When a field has display labels (typically a remapped FK or an enum with friendly names), each entry is a `{value, label}` object:

```yaml
field_id:
  - Sample Database
  - PUBLIC
  - PRODUCTS
  - RATING
has_more_values: false
values:
  - value: 0
    label: Unrated
  - value: 1
    label: Poor
  - value: 5
    label: Excellent
```

The two encodings are mutually exclusive per file; a single YAML never mixes scalar and object entries.
