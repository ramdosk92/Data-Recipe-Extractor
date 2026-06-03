# CRM Analytics Recipe Extractor

A browser-based tool for isolating output-specific sub-recipes from large Salesforce **CRM Analytics Data Recipe** JSON files.

---

## What It Does

Large CRM Analytics recipes can have hundreds of nodes and take a long time to run. When you're iterating on a single output dataset — adding a formula, fixing a join, adjusting a filter — you shouldn't need to run the entire recipe.

This tool lets you:

1. Upload your full recipe JSON
2. Select the output dataset(s) you're working on
3. Download a trimmed JSON containing **only the nodes required to produce those outputs**

Upload the sub-recipe to CRM Analytics, iterate quickly, then copy your changes back to the full recipe.

---

## Usage

1. Open `extractor.html` in any modern browser — no server or install required
2. Select your recipe `.json` file using the file picker
3. The tool shows all output datasets with node counts
4. Check one or more outputs → click **Extract Selected**
5. Click **Download JSON** to save, or **Copy to clipboard** to paste directly

---

## How It Works

The tool performs a **reverse dependency walk** from each selected `save` node, following every `sources` reference upstream until all ancestor nodes are collected. It then rebuilds both `recipe.nodes` and `ui.nodes` — including all visual connector wiring — so the output is a fully valid, self-contained CRM Analytics recipe.

### Structural differences from Tableau CRM Dataflow format

| | Dataflow JSON | Recipe JSON |
|---|---|---|
| Output nodes | `register` action | `save` action |
| Source nodes | `sfdcDigest` / `edgemart` | `load` action |
| Visual grouping | None | `TRANSFORM` and `AGGREGATE` wrap child nodes in `ui.nodes[x].graph` |
| Connector scope | N/A | `ui.connectors` uses top-level UI node names only |

### Compound UI node types

| Type | Wraps | Graph value |
|---|---|---|
| `TRANSFORM` | `formula`, `schema`, `typeCast`, `computeRelative`, `drop_fields` | Object `{label, parameters}` |
| `AGGREGATE` | `extractGrains` + `aggregate` | `null` (key-only membership) |

Both types are handled: their `graph` is filtered to needed children only, and internal `connectors` arrays are preserved.

---

## Files

```
extractor.html   —  Bootstrap 5 UI (file picker, dataset cards, accordion results)
extractor.js     —  All extraction logic; zero external dependencies
README.md        —  This file
```

---

## Supported Actions

`load` · `save` · `formula` · `join` · `filter` · `schema` · `aggregate` ·
`computeRelative` · `extractGrains` · `typeCast` · `drop_fields`
