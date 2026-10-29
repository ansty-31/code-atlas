# 历史 Java 专用版本说明

本文保存多语言改造前的设计、规模数据及测试说明。它不是当前通用版本的使用入口；请以根目录 README 与多语言架构文档为准。

# Zombie Atlas

**Zombie Atlas** is a static web app that makes the decompiled Project Zomboid Java source tree readable at a glance. It parses the `zombie/` package with the [`tree-sitter-java`](https://github.com/tree-sitter/tree-sitter-java) grammar — 3,078 `.java` files, 4,749 types (1,671 of them nested), 270 packages, 723,502 non-comment code lines, 49,645 methods, 46,612 fields and 96,257 members — into a compact JSON bundle, and renders it as a treemap-first map in the spirit of the Firefox memory tree-map view: packages, types and members as nested rectangles, backed by four companion views for the class hierarchy, package dependencies, functional subsystems and computed insights. The extracted reference graph contributes 31,247 class-to-class and 4,096 package-to-package edges. Every number on screen is derived from the source itself — nothing is hand-curated — and the built app is served next to the raw tree, so "View source" always opens the exact file a figure came from.

## Screenshots

The headless smoke test writes its captures to `.pw-shots/` (gitignored). A fresh run produces:

| File                                  | Shows                                                                 |
| ------------------------------------- | --------------------------------------------------------------------- |
| `.pw-shots/01-treemap.png`            | Root treemap — every package and type in the tree                     |
| `.pw-shots/02-treemap-zoomed.png`     | The same map after a double-click zoom, with breadcrumbs              |
| `.pw-shots/03-selection.png`          | `IsoPlayer` selected: highlighted rectangle plus populated inspector  |
| `.pw-shots/04-source.png`             | Source-viewer modal showing the decompiled file for the selected type |
| `.pw-shots/05-hierarchy.png`          | Inheritance forest with the root list                                 |
| `.pw-shots/06-dependencies.png`       | Force-directed package graph                                          |
| `.pw-shots/07-matrix.png`             | Package adjacency matrix with the class-edge list below it            |
| `.pw-shots/08-subsystems.png`         | Domain bar and the per-domain cards                                   |
| `.pw-shots/09-insights.png`           | Rankings and histograms                                               |
| `.pw-shots/10-treemap-light.png`      | Treemap in the light theme                                            |
| `.pw-shots/11-groupby-stereotype.png` | Treemap regrouped by inferred stereotype                              |
| `.pw-shots/12-members.png`            | Member-level leaves inside types                                      |

The directory may also contain extra captures from earlier sessions (`A-root.png`, `B-iso.png`, `C-core.png`, `C-stereotype.png`). Screenshots are off by default; regenerate the set with:

```bash
npm test              # bundle validation + unit tests + browser suite
npm run test:shots    # browser suite, writing .pw-shots/
npm run test:browser  # browser suite only, no screenshots
```

## Quick start

```bash
npm install          # dependencies (Playwright is only needed for the browser tests)
npm start            # extract the data, build, and serve → http://127.0.0.1:5184/
```

`npm start` runs the whole pipeline: it bundles the app into `dist/`, parses the
decompiled tree into `dist/data/`, and serves both together with the raw
sources. The generated JSON lives in exactly one place — inside the build
output — and is never committed.

Vite drives the pipeline itself through the `zombie-atlas-data` plugin in
`vite.config.ts`, so `npx vite build` and `npx vite` do the right thing on their
own; `tools/build.mjs` only exists to translate the flags below into the
environment variables that plugin reads.

| Command                            | What it does                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm install`                      | Install dependencies.                                                                                                          |
| `npm run data`                     | Regenerate the JSON bundle into `dist/data/` (`node tools/extract.mjs`).                                                       |
| `npm run build`                    | `vite build` — bundles the app, then writes `dist/data/` from the plugin's `closeBundle` hook.                                 |
| `npm run dev`                      | `vite` — dev server on port 5183; generates the bundle on startup and regenerates it when the tree changes.                    |
| `npm run serve`                    | Serve the existing `dist/` plus the raw sources at http://127.0.0.1:5184/.                                                     |
| `npm start`                        | `npm run build` followed by `node tools/serve.mjs`.                                                                            |
| `npm run typecheck`                | `tsc --noEmit`.                                                                                                                |
| `npm test`                         | The unit tests, then the browser suite.                                                                                        |
| `npm run test:unit`                | Pure Node tests: locale catalogs, no browser or dataset needed.                                                                |
| `npm run test:browser`             | The browser suite. Starts its own server on a free port, unless `--port` names one — or `--url` names an external deployment, in which case nothing local is started. |
| `npm run test:shots`               | The browser suite, also writing screenshots to `.pw-shots/`.                                                                   |
| `node tools/test/runner.mjs --spec treemap` | Run one spec (matched by filename). Add `--list` to see them, `--bail` to stop at the first failing spec.             |
| `sh tools/pw.sh <command>`         | Run any command with the project-local Chromium and shared libraries on the path (the test runner does this for itself).      |

Extra flags accepted by `tools/build.mjs`:

| Flag          | Effect                                                               |
| ------------- | -------------------------------------------------------------------- |
| `--dev`       | Extract, then run the Vite dev server instead of a production build. |
| `--skip-data` | Reuse the existing `dist/data/` bundle (UI-only rebuild, ~0.2 s).    |
| `--src <dir>` | Decompile tree to read (overrides `ZOMBIE_SRC`).                     |
| `--pretty`    | Indent the emitted JSON (larger, easier to diff by hand).            |
| `--no-refs`   | Skip the fine-grained reference layer (`refs/**`, ~13 MB).            |

### Pointing at your source tree

`zombie/` is a decompilation artefact: it is gitignored, belongs to a specific
game build, and may live anywhere on disk. The atlas therefore never assumes a
fixed location. The extractor, the validator, the dev middleware and the static
server all resolve the tree the same way, first hit wins:

1. `--src <dir>` on the command line
2. the `ZOMBIE_SRC` environment variable
3. `ZOMBIE_SRC` in a `.env` file (`zombie-atlas/.env`, then the repository root `.env`)
4. `<repository root>/zombie`
5. `./zombie` relative to the current working directory

Relative values are tried against the current working directory and then the
repository root, so both of these work:

```bash
ZOMBIE_SRC=../zombie npm run build                      # sibling of zombie-atlas/
ZOMBIE_SRC=/opt/pz/42.13.0/decompiled npm run build     # anywhere on disk
node tools/build.mjs --src ~/dumps/pz-42.20 --pretty
```

If you name a directory explicitly and it does not exist, the build fails with
the list of paths it tried instead of silently falling back to a default.

The last path segment of the source directory becomes the URL mount used by the
source viewer, so a tree at `/opt/pz/decompiled` is served as
`/src/decompiled/**`. That is also why "View source" keeps working after you
move the tree: the class records in the bundle store paths as
`<mount>/<path inside the tree>`, and the server maps the mount back to wherever
you pointed it. Requests for a mount this build does not serve return a 404
rather than the SPA's HTML.

`ZOMBIE_DATA_OUT` (or `--out <dir>`) relocates the generated bundle if you would
rather keep it outside the project.

## How it works

The whole dataset is produced by one extractor, `tools/extract.mjs` (`npm run data`). It is a plain Node ESM script with no build step; the only dependencies are the two build-time parser packages (see [Requirements](#requirements--regenerating-the-data)).

1. **Parse.** `tools/lib/java-ast.mjs` parses each file with the `tree-sitter-java` grammar and walks the tree — one parse per file, no masking pass and no regex declaration scanning. Comments, string literals and text blocks are grammar nodes, so the line accounting reads their ranges instead of blanking text, and every record carries the offsets and spans it came from. `tools/lib/java-names.mjs` holds the two string-level helpers (`normalizeTypeRef`, `simpleName`) that resolution needs.
2. **Extract, per file.** Package, imports (static and on-demand `*` imports kept distinct), and the file's line accounting.
3. **Extract, per type.** Declarations of `class`, `interface`, `enum`, `record` and `@interface` with their nesting, modifiers, annotations and nearest preceding javadoc; fields; methods and constructors (return type, parameter types, `throws`, modifiers, annotations, declaration line, body line count, per-method complexity); enum constants; and a per-type line count. A nested type is charged only its own span, while the outermost type in a file owns the whole file — imports, licence header and trailing comments included — so package totals never double count an inner class.
4. **Score.** Complexity is `1 +` every `if`, `for` (classic and enhanced), `while`, `do`, `case` label, `catch`, `&&`, `||` and ternary expression — read from the grammar's node types, so `default:` labels are not branch points and a `?` inside a wildcard cast is not a ternary. Branch density is complexity per code line. A **stereotype** is inferred from the declaration itself: `@UsedFromLua` becomes `lua-api`, `*Manager` becomes `manager`, `*Packet` becomes `packet`, and so on through `interface`, `enum`, `record`, `exception`, `abstraction`, `ui`, `factory`, `utility`, `event`, `debug`, `abstract`, `data` and finally `class`.
5. **Resolve.** Supertypes, interfaces and member type references are mapped to internal ids by trying the fully-qualified name first, then `zombie.<name>`, then a global simple-name index whose ties are broken by preferring a type in the same package, then `zombie.*`, then a top-level (non-nested) bearer. Genuinely ambiguous references resolve to nothing and are treated as external.
6. **Build the reference graph.** Three sources feed one class-to-class edge table:
   - non-static, file-level imports, attributed to the file's top-level types only (a nested type does not inherit its outer class's import list), with `.*` imports expanded to every type in the target package;
   - fully-qualified `zombie.*` names found inside type bodies, resolved to the longest known type prefix and attributed to the innermost declaring type containing them;
   - member type references (return and parameter types) resolved through the same-package index and the file's imports.
7. **Aggregate.** The nested package tree is built bottom-up with per-node metrics, own types and subtree type lists; functional domains are derived from the second package segment (55 domains under `zombie.`); fan-in, fan-out and per-domain hub types are computed.
8. **Emit.** The JSON bundle lands in `dist/data/` (see [Data bundle reference](#data-bundle-reference)). The `zombie-atlas-data` plugin runs this step from Vite's `closeBundle` hook — after the app has been written and after `emptyOutDir` — and from the dev server's startup and file watcher, so one tool owns the whole pipeline. `insights.json` precomputes the rankings and histograms the UI would otherwise have to scan the whole member space for.
9. **Emit and check.** The bundle is written, the unit tests cover the pure modules and the browser suite drives the built app. [docs/parser-parity.md](docs/parser-parity.md) records what the tree-sitter swap changed, with the measured count and cause of every correction.

Metrics recorded per type (their meaning is echoed in `meta.json` so the bundle is self-describing):

| Metric               | Meaning                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `code`               | Non-blank, non-comment source lines                                                        |
| `loc`                | Total source lines                                                                         |
| `comment` / `blank`  | Comment-only and blank lines                                                               |
| `bytes`              | UTF-8 bytes of the type's source span (the outermost type in a file covers the whole file) |
| `methods` / `fields` | Declared methods and constructors / declared fields                                        |
| `members`            | Methods + fields + enum constants                                                          |
| `complexity`         | Sum of `1 +` branch points (`if`/`for`/`while`/`case`/`catch`/`&&`/`\|\|`/`?:`)            |
| `fanIn` / `fanOut`   | Distinct types in the tree that reference this type / that this type references            |
| `luaExposed`         | Types carrying `@UsedFromLua`                                                              |

## Language Support

The header language selector supports changing of display language across all five
views, controls, tooltips, dialogs, and load errors. The initial language is chosen
from url path (e.g. `?lang=en`), then the saved preference, then the browser's
language list; unsupported languages fall back to English.

Switching language reloads the app after saving the current settings and navigation.
The preference is stored separately as `zombie-atlas.language.v1`; **Restore defaults**
resets view settings without changing language. Language links also work when browser
storage is blocked. Permalinks preserve the language query, package selection (`pkg`)
and minimum code-line filter (`min`).

Java names, packages, annotations, source text, search identifiers and JSON export
values retain their original spelling. Numbers and relative-time labels follow the
selected language. The language catalogs are in `src/locales/<language_code>.json`;
`src/i18n.ts` provides typed `msg()` calls with numbered placeholders (`{0}`, `{1}`) 
and display-only category translation through `trLabel()`.
Keep HTML interpolation escaped at its call site, as with the existing tooltips.

To add UI text, add matching entries to both catalogs and call `msg()` at the display
site. Use stable IDs for selectors, never translated labels. `npm run test:unit`
checks catalog key and placeholder parity, and `npm test` adds browser coverage of
both languages and language switching.

## Views

Tab between views with the top bar or the `1`–`5` keys. All five share the sidebar (view controls plus a legend), the breadcrumb bar and the status bar; the status bar always reports how many types pass the current filters, the package count, the code-line total, a view-specific line, and the active metric, colour mode and grouping.

### 1. Treemap

Canvas treemap of the whole tree: packages → types → members as nested rectangles, laid out with `d3-hierarchy`.

- **Click** selects a type or package and fills the inspector; **double-click** a group zooms into it (a leaf focuses that type); **right-click** zooms back to the root; breadcrumbs and the `Up` / `Root` stage buttons navigate the same zoom path.
- **Hover** shows a full readout: kind and stereotype, code and comment lines, method and field counts, complexity, fan-in/fan-out, Lua annotations, enum constants and the rectangle's share of the map. Group rectangles report aggregate type, code, method, complexity and Lua totals instead.
- Labels are fitted to the available space and can be toggled; padding, depth limit and a "hide below N% of total" cull keep large trees readable.
- Stage actions: layout shortcuts (squarified / slice / binary), a types-or-members leaf toggle, `Up`, `Root`, **PNG** export (downloads `zombie-atlas-<metric>-<colour>.png`) and **JSON** export (downloads `zombie-atlas-selection.json` — every type passing the current filters with its metrics, heritage and source path).

### 2. Hierarchy

The inheritance forest, built from the 3,340 types with no internal supertype.

- The root list is ranked by subtree size (also sortable by name or kind) and is capped at 400 rows; the text filter matches roots and their subtrees, and the `interfaces` / `lua only` checkboxes narrow the list.
- The tree pane expands and collapses with carets, draws inheritance connectors, shows `implements` relations as dashed entries when `interfaces` is on, and labels each row with kind badge, code size, Lua badge and hidden-subtype count.
- Selecting a type anywhere in the app auto-reveals and expands its chain in this view; `Collapse all` and `Expand two levels` are available from the stage actions.

### 3. Dependencies

Three modes over the same package graph, switched from the stage actions.

| Mode      | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `graph`   | Force-directed package graph (`d3-force`). Node radius scales with code size, colour comes from the functional domain, hover dims everything that is not a neighbour and shows code, linked-package counts and total refs. Scroll to zoom around the cursor, drag empty space to pan, drag a node to pin it, double-click a node to centre and zoom on it, double-click empty space (or press `Fit`) to frame the whole graph, and use the `−` / `+` buttons for stepped zoom. Click a node to select its package in the inspector. A press only becomes a drag after the pointer travels ~3px, and gestures are tracked on the window, so panning keeps following the pointer outside the canvas. Pan and zoom are preserved across clicks, mode switches and view changes — the force layout is only recomputed when the node set actually changes, and only `Fit`, a double-click on empty space or a graph rebuild re-frames it. |
| `matrix`  | Adjacency matrix of the busiest packages — row = importing package, column = imported package, cell = number of class-level references. Hovering a cell shows the count and its share of the row; clicking one opens the class-level edges between that pair.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `classes` | The class-edge list for the pair picked in the matrix (or for the selected package), heaviest first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Graph controls: how many top packages to keep (default 40, range 6–270), the minimum edge weight (default 3) and a `cross-domain only` switch.

### 4. Subsystems

The functional layout of the engine.

- A proportional bar of all 55 domains, ordered by size, with a clickable legend — clicking a segment or a card filters the treemap to that domain and switches to it.
- One card per domain carrying its description, code lines, types, methods, complexity, share of the codebase and Lua-exposed type count, plus bars for size, branch density, cross-package coupling (fan-in/fan-out) and type mix (classes/interfaces/enums/records), the number of packages it owns and its key hub types by fan-in.
- Cards can be sorted by code, types, complexity, fan-in, Lua surface or name.

### 5. Insights

Twelve cards computed at extraction time and served from `insights.json`.

- **Empty results explain themselves.** If the active filters exclude every type,
  the stage shows what is filtering (`query "IsoPlayer" · domains: iso`) with
  **Clear filters** and **Reset view** buttons instead of a blank canvas.
- **Most complex methods** (togglable between complexity, branch count and body lines), **Largest types**, **Most depended-upon (fan-in)**, **Biggest reusers (fan-out)**, **Highest branch density**, **Most annotated methods** (the largest `@UsedFromLua` surface per type) and **Strongest package coupling** — each ranking row selects the type (or jumps to the package pair in the Dependencies view).
- Histograms of declaration kinds, stereotypes, annotations and largest packages, plus a **Scale** card listing the bundle's headline counts.
- Four cards come from the reference layer when the bundle carries it (they are appended, so the cards above keep their positions): **Most-called methods** and **Most-written fields** rank members by incoming references, **Deepest call chains** shows the longest resolved chains as `Type.m → Type.n → …` deduplicated by shape, and **Reference coverage** reports how much of the call graph could be typed — resolved, class-only and unresolved, with the receiver-shape histogram and the flow counts. A `--no-refs` bundle renders the twelve cards it always had.

**The source viewer colourises with the grammar.** Opening a file parses it with
the same `tree-sitter-java` grammar that extracted the bundle, so comments and
literals can never be mistaken for code and an unknown construct is visibly
uncoloured rather than silently wrong. That parser is a lazy chunk: `web-tree-
sitter` and the grammar's 415 KB `.wasm` are fetched the first time a viewer
opens, never at startup, and one file is parsed per open (~1 ms), so it runs on
the main thread. If the asset cannot be fetched the viewer falls back to plain
escaped text. The runtime and grammar wasm are emitted by the
`zombie-atlas-parser-assets` plugin in `vite.config.ts` (grammar under `/ts/`,
the runtime next to the chunk that loads it).

The right-hand **inspector** is shared by every view: it shows the project overview when nothing is selected, and for a type it lists the badges (kind, Lua API status), metrics, the internal superclass chain, direct subtypes, the full member list with a filter, and the "depends on" / "used by" neighbours, with buttons to open the source, show the type in the hierarchy or copy the fully-qualified name.

When the bundle carries the reference layer, the inspector adds a **References** section for the selected type and a `→n ←n` badge on each member row. The section lists what the type's members call, read and write (with counts and the first source line, each row jumping to the target type), then which members are referenced most and by whom. It also publishes its own confidence — the resolved share, tree-wide — and states how many sites resolved to a class only or not at all, because a receiver the analysis cannot type is counted rather than guessed. A **Data flow** block lists what the members do with their values: a parameter stored into a field, what a returned value comes from, and callbacks registered with another member (`registers itself with IsoGameCharacter.addOnDiedListener`). A bundle built with `--no-refs` shows none of this and behaves exactly as before.

For a package the inspector shows the package metrics, its sub-packages, and the types it declares (largest first, capped at 60) with buttons to zoom the treemap there or clear the filters.

## Customising the map

Everything in this section is a control in the sidebar, a stage action or a filter chip, and every setting is persisted.

| Setting                | Options                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size metric            | Code lines (non-comment), total lines, file size, method count, field count, members, cyclomatic complexity, fan-in (used by), fan-out (uses), Lua exposure, branch density, or a custom composite |
| Custom composite       | Weight sliders (0–1) for code, complexity, methods, fan-in, Lua exposure and file size                                                                                                             |
| Colour by              | Functional domain, package, declaration kind, stereotype, fan-in heat, fan-out heat, complexity heat, branch density heat, Lua exposure, nesting depth                                             |
| Group by               | Package hierarchy, functional domain, stereotype, declaration kind, stereotype → domain                                                                                                            |
| Layout                 | Squarified, slice & dice, binary, strips (plain `treemapSlice` — not d3's `resquarify`, which only exists to keep a squarified layout stable across updates)                                       |
| Sort                   | Size, name, fan-in, complexity                                                                                                                                                                     |
| Depth limit            | 0 (unlimited) to 6 package levels                                                                                                                                                                  |
| Padding                | 0–8 px between rectangles                                                                                                                                                                          |
| Hide below N% of total | Culls rectangles smaller than a share of the whole map                                                                                                                                             |
| Leaves                 | Types or members (`M`)                                                                                                                                                                             |
| Labels                 | On (adaptive) or off                                                                                                                                                                               |

Filters:

| Filter             | Behaviour                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text query         | Matches type names, fully-qualified names, packages, stereotypes, annotations and — once member shards are loaded — member names. The search box also offers ranked class and package suggestions; choosing one selects the type or zooms the treemap to the package. |
| Kind chips         | Declaration kinds (class, interface, enum, record, annotation)                                                                                                                                                                                                        |
| Stereotype chips   | The twelve most common inferred stereotypes, with counts                                                                                                                                                                                                              |
| Domain chips       | All 55 functional domains, with type and code-line counts on hover                                                                                                                                                                                                    |
| Lua only           | Restrict to `@UsedFromLua` types                                                                                                                                                                                                                                      |
| Minimum code lines | Drop types below a code-line threshold                                                                                                                                                                                                                                |

A `Clear N filters` button appears whenever any filter is active.

**Persistence.** Settings live in `localStorage` under `zombie-atlas.settings.v1`. The URL hash carries the shareable state — view (`v`), metric (`m`), colour mode (`c`), grouping (`g`), layout (`l`), theme (`t`), depth (`d`), member leaves (`mm`), query (`q`), Lua filter (`lua`), domains (`dom`), kinds (`k`), stereotypes (`st`), zoom path (`z`) and selected type (`sel`) — and is re-applied on load and on `hashchange`. The **Permalink** button in the stage actions copies the current link to the clipboard.

## Persistence & recovery

Configuration lives in `localStorage` under a single key:

```
zombie-atlas.settings.v1  →  { version, theme, sizeMetric, weights, colorMode, palette,
                               groupBy, layout, depthLimit, showMembers, labelMode,
                               padding, minShare, sort, sidebar, inspector,
                               filters: { query, kinds, stereotypes, domains, luaOnly, minCode } }
```

Nothing else is stored — no cookies, no `sessionStorage`, no IndexedDB, no
service worker. The view, zoom path, selection and the filter summary travel in
the URL hash instead, so a permalink reproduces a screen without touching
storage. Seven settings are storage-only and return to their defaults if it is
cleared: `palette`, `labelMode`, `padding`, `minShare`, `sort`, `sidebar`,
`inspector`.

**Reads are validated field by field.** `coerceSettings()` builds the settings
object from the documented defaults and only accepts a stored value that has the
right type and range, so a truncated, hand-edited or future-version payload
degrades to defaults instead of breaking the UI. The result is written back on
the next pass, which means storage repairs itself on load. The sidebar says what
happened ("No saved settings found — defaults written.", "Saved settings
repaired on load (19 fields).") and the tooltip on that line lists every repair.

To start over:

| Where                                | Action                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| View controls → **Restore defaults** | Discards every saved setting and writes the defaults back                                    |
| Console                              | `zombieAtlas.store.resetSettings()`, or read `zombieAtlas.store.storage` for the load report |
| Empty-state overlay                  | **Clear filters** (keeps zoom) or **Reset view** (also clears zoom, selection, culling)      |

If a filter still applies after clearing storage, the URL hash is re-applying it
— drop the `#…` part of the address as well.

## Keyboard shortcuts

| Key                               | Action                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/`                               | Focus the search box                                                                                         |
| `Esc`                             | In the search box, clear the query; otherwise zoom out one treemap level, or clear the selection at the root |
| `1` … `5`                         | Switch to Treemap, Hierarchy, Dependencies, Subsystems, Insights                                             |
| `T`                               | Toggle the light/dark theme                                                                                  |
| `S`                               | Toggle the sidebar                                                                                           |
| `I`                               | Toggle the inspector                                                                                         |
| `M`                               | Toggle member-level leaves                                                                                   |
| `?`                               | Open the help dialog                                                                                         |
| `ArrowUp` / `ArrowDown` / `Enter` | Move through and accept search results                                                                       |

Shortcuts are ignored while a text field, select or textarea has focus. Mouse: click selects, double-click zooms or focuses, right-click zooms out to the root, hover reads out the rectangle under the cursor. In the Dependencies graph the wheel zooms and dragging empty space pans.

Every panel scrolls independently: the control sidebar, the inspector, and the Hierarchy, Subsystems, Dependencies and Insights panes each own their scroll container, so long lists never push content out of reach.

## Data bundle reference

The bundle is generated straight into `dist/data/`, where both the dev server
and the production server read it from; it is never committed. Sizes are from
the current build and drift slightly with each regeneration.

| File                  | Size                      | Contents                                                                                                                                                                                                                                             |
| --------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta.json`           | ~3.6 KB                   | Generation timestamp, schema version, parser and grammar versions, files the grammar could not parse, source root and its mount, decompiler string, headline counts, domain descriptions, the column lists for `classes.json` and the member shards, and the metric glossary. |
| `packages.json`       | ~86 KB                    | Nested package tree with per-node aggregates (code, lines, methods, complexity, Lua counts, fan-in/fan-out).                                                                                                                                         |
| `classes.json`        | ~923 KB                   | Compact columnar records for all 4,749 types; the column names are documented in `meta.json`.                                                                                                                                                        |
| `hierarchy.json`      | ~13 KB                    | Ids of the types with neither an internal supertype nor an interface (the Hierarchy view derives its root list from `classes.json` at runtime).                                                                                                      |
| `deps-packages.json`  | ~202 KB                   | 4,096 `[from, to, weight]` package edges, heaviest first.                                                                                                                                                                                            |
| `deps-classes.json`   | ~408 KB                   | Class-to-class edges, loaded lazily when a class-level edge list is requested.                                                                                                                                                                       |
| `insights.json`       | ~41 KB                    | Top methods by complexity (with body line and branch counts), the rankings, the histograms and the package-coupling table.                                                                                                                           |
| `members/<slug>.json` | 266 shards, ~10 MB total | Per-package member lists keyed by class id (methods with parameters, throws, modifiers, annotations, line, complexity, body lines and javadoc, plus fields and enum constants). Loaded on demand; the slug is the package with `.` replaced by `__`. |
| `refs/meta.json` | ~1 KB | The reference layer's counts and resolution report: sites by kind, resolved / class-only / unresolved, receiver shapes, row and shard totals. Its absence is how the app knows the bundle was built with `--no-refs`. |
| `refs/summary.json` | ~230 KB | Per-class aggregates `[id, outCalls, inCalls, outReads, inReads, outWrites, inWrites]` plus the rankings the insights cards read (most-called members, most-written fields, …). |
| `refs/<slug>.json` | 263 shards, ~15 MB total | Per-member rows: what a member calls/reads/writes (`out`), who calls/reads/writes it (`in`), and a `flow` block. Rows are `[classId, line, kind, count, [lines]]` where kind is `call`/`read`/`write`/`new` and `line` is `-1` when only the class could be resolved; `flow` is `{p, r, g}` — `p` a parameter stored into a field, `r` what a returned value is, `g` a callback handed to another member. Sharded and loaded exactly like the member lists. |
| `refs/chains.json` | ~70 KB | Resolved chains: a depth histogram plus the 120 deepest, each `{from, line, path}` with one `[classId, line, name]` per step. |

The bundle is about 27 MB in total: roughly 1.9 MB of JSON loaded eagerly and 25 MB of shards fetched on demand (member lists plus the reference layer). The reference shards are an order of magnitude more rows than the class graph — 456,920 member-to-member edges from 2.5 M sites — so they are the reason `npm run data -- --no-refs` exists: it writes the bundle without `refs/**` (12 MB) and every reference surface simply hides itself.

## Verification

The parser swap was checked against the source with an independent scanner while
both parsers existed; that scanner and the harness that ran them are gone, and
the findings are recorded in [docs/parser-parity.md](docs/parser-parity.md).
New verification is planned; for now the guarantees are the test layers below,
the fact that the bundle is a pure function of the source, and `git diff` on a
regenerated `dist/data` when a change is meant to move figures.

### Test suite

Three layers, cheapest first:

| Layer | Command | Covers |
| ----- | ------- | ------ |
| Unit tests | `npm run test:unit` | The settings schema and codec, the permalink round trip, filtering and search, the locale catalogs. No browser, no dataset — about 80 cases in a tenth of a second. |
| Browser suite | `npm run test:browser` | The built app in headless Chromium: every view, interaction, persistence path and export. |

The unit layer imports the application's TypeScript directly — `node --test` strips the types — so the pure parts of `src/` are tested against the real modules rather than a copy. `tools/test/ts-resolve.mjs` supplies the two things Node needs for that: extension resolution for the Vite-style imports, and enough of a `location`/`localStorage` for `i18n.ts` to load.

The browser suite is a set of independent specs rather than one long session:

```
tools/test/
  runner.mjs      # discovers specs, one browser + server per run, per-spec context, reporting
  harness.mjs     # server spawn/probe, browser launch, page factory, console-error capture
  kit.mjs         # the `t` object: t.test(), t.todo(), t.shot(), t.newApp(), t.switchLanguage()
  locators.mjs    # every selector in the suite, in one place
  seam.mjs        # the only place that reaches into application internals
  probes.mjs      # canvas pixel sampling, canvas signatures, scroll reachability
  fixtures.mjs    # shared constants: the settings key, IsoPlayer, known zoom paths
  specs/*.spec.mjs
  unit/*.test.mjs
```

Conventions that stop the suite from fighting the source:

- **Specs never write a selector.** They ask `locators.mjs` for a thing — a tab, a stage action, a control found by its visible label — and that module decides how to find it. A UI restructure becomes a change in one file, and the positional `select >> nth=3` juggling is gone.
- **Specs never touch `window.zombieAtlas`.** Everything goes through `seam.mjs` as named, data-driven operations (`seam.store.apply({...})`, `seam.treemap.findGroup(page)`), because Playwright cannot pass a function across the page boundary.
- **One spec file per area, one browser context each.** Specs cannot leak state into one another, and each spec ends with a console-error sweep for its own page, so a failure names an area rather than the whole app. A failing test no longer aborts the run — the old single script lost every result it had gathered if one element went missing.
- **Regression guards are named tests.** The defects that prompted them are described in the spec that asserts them.

Screenshots are opt-in (`npm run test:shots`); `.pw-shots/` is gitignored.

#### Known defects

Behaviour that is currently broken is recorded with `t.todo()`. It does not fail the run, but it stays visible in the output with its root cause, and it flips to `XPASS` once it starts passing so it can be promoted to a real assertion.

| Spec | Defect |
| ---- | ------ |
| `treemap` | The member level silently does nothing when zoomed into a nested package: `ensureMembers()` resolves the zoom package with `find()` — the outermost `p:` segment — while the rectangles on screen belong to the deepest one, so the needed shard is never fetched. |
| `customisation` | `S`, `I` and the settings button flip `settings.sidebar` / `settings.inspector`, and `.workspace.no-sidebar` / `.no-inspector` exist in `styles.css`, but nothing ever applies those classes — the panels never collapse. |
| `persistence` | The sidebar's repair note is overwritten by the first state change, so a repair is announced on load and silently un-announced as soon as a control is touched. |
| `hierarchy` | The "lua only" checkbox does nothing until filter text is typed: both call sites guard the whole predicate with `!filterText \|\|`, so `matches()` never consults `useLuaFilter`. |
| `insights` | The "branch" sort is indistinguishable from "complexity" — complexity is defined as branch points + 1, so both orderings and both value labels come out identical. |

One entry has since been fixed and promoted to a normal assertion: a permalink could set `colorMode`, `groupBy` and `layout` to unvalidated values, because the URL path cast where the storage path validated. Both channels now run through the same field specs in `src/state/schema.ts`.

The suite starts its own server on a free port and picks up the project-local Chromium (`.pw-browsers/`) and shared libraries (`.pw-libs/`) automatically, so `npm test` works without any wrapper.

### Showcase trailer

`sh tools/pw.sh node tools/trailer.mjs` films the running app for a showcase
trailer. It drives **real mouse and keyboard input** through the whole product —
treemap hover, selection, zoom and breadcrumb walk-back; the size, colour,
grouping, layout and culling controls; the filter chips; ranked search and the
source viewer; the hierarchy forest; the dependency graph, adjacency matrix and
class-edge list; the domain cards and their treemap filter; the insight rankings;
the light theme; the help dialog and the permalink — and records the **page
viewport** rather than the desktop, so the video contains the application and
nothing else.

Output lands in `.pw-video/`: `zombie-atlas-trailer.mp4` (H.264, 30 fps,
yuv420p, faststart, written when an ffmpeg binary is available — otherwise a
VP8 `.webm`), one screenshot per checkpoint in `.pw-video/frames/` for
eyeballing a take without decoding it, and a per-beat report with timings and
any console error. A synthetic pointer with a click ripple and the intro/outro
title cards are injected into the page (a headless browser films no OS cursor);
`--no-cursor` and `--no-cards` leave the app's own pixels untouched. The other
flags are `--url`, `--width`, `--height`, `--out`, `--trim` and `--no-encode`,
and the load-time lead-in is trimmed automatically so the film opens on the
title card. Every beat is non-fatal: a selector that stops matching is reported
and skipped instead of ending the take.

## Project layout

```
zombie-atlas/
  index.html              App shell: top bar, sidebar, canvas stage, inspector, status bar
  package.json            Scripts and dependencies
  vite.config.ts          Vite config + the data plugin: /data/** and /src/<mount>/** middleware,
                          bundle generation on build and regeneration on source change
  tsconfig.json           Strict TypeScript, ES2022, noEmit
  src/
    main.ts               Bootstrap: mounts the shell, then wires views, controls, search,
                          breadcrumbs, exports and the render loop
    app/
      app.tsx             The shell markup (topbar, sidebar, stage, inspector, status bar)
    util.ts               Formatting, DOM helper, canvas text fitting
    domain/               The extracted dataset. Pure: no DOM, no i18n, no store.
      types.ts            ClassRec / PkgNode / MemberRec / Atlas and friends
      metrics.ts          Declaration kinds, metric keys and accessors
      atlas.ts            Bundle loading and index building
      members.ts          Lazily-fetched member and class-edge shards
      queries.ts          Ancestry, descendants, package paths
      index.ts            Barrel — imports elsewhere use `../domain`
    shared/
      color.ts            Colour maths and the sequential ramps
      text.ts             `esc`, for anything that builds HTML
    state/
      schema.ts           The settings schema: one entry per setting, driving
                          defaults, storage validation and the permalink
      persist.ts          localStorage codec + the repair report
      permalink.ts        Compact, shareable URL encoding (pure core + DOM wrapper)
      query.ts            Filtering and ranked search
      store.ts            The observable store
      types.ts            AppState / Selection / view ids
      index.ts            Barrel — the rest of the app imports `./state`
    styles.css            Themes and layout
    views/
      source/             Source-viewer modal + the grammar-driven highlighter
      treemap.ts          Canvas treemap, zoom, labels, tooltip, exports
      hierarchy.ts        Inheritance forest
      dependencies.ts     Force graph, adjacency matrix, class-edge list
      subsystems.ts       Domain bar and cards
      insights.ts         Rankings and histograms
      inspector.ts        Right-hand detail panel
      source.ts           Source-viewer modal
  tools/
    extract.mjs           The extractor; writes the JSON bundle
    build.mjs             Flag-friendly front-end for Vite (--dev, --skip-data, --src)
    lib/config.mjs        Source/output discovery (ZOMBIE_SRC, --src, .env)
    serve.mjs             Production server: dist/ plus /src/<mount>/**
    trailer.mjs           Records the showcase trailer (viewport capture + encode)
    pw.sh                 Runs a command with the bundled Chromium and libraries
    lib/java-ast.mjs      The tree-sitter extractor: one parse per file, then a walk
    lib/java-names.mjs    Type-name normalisation used by the resolver
    test/
      runner.mjs          Spec discovery, reporting, exit code
      harness.mjs         Server/browser/page plumbing
      kit.mjs             The `t` test context
      locators.mjs        Every selector the suite uses
      seam.mjs            The only reader of window.zombieAtlas internals
      probes.mjs          Canvas and scroll measurements
      specs/              One spec per area
      unit/               Pure Node tests (locale catalogs)
  dist/                   Generated app bundle and dist/data/ JSON bundle (gitignored)
  .pw-shots/              Smoke-test screenshots (gitignored)
  .pw-video/              Trailer output: mp4/webm, checkpoint frames (gitignored)
  .pw-browsers/, .pw-libs/  Local Chromium and extracted libraries (gitignored)
```

The stack is TypeScript and Vite 8 with no UI framework: `d3-hierarchy` for the treemap, `d3-force` for the dependency graph, `d3-scale`/`d3-selection` for supporting work, and direct canvas 2D rendering for both. After boot a debug handle is exposed for automation: `window.zombieAtlas = { store, atlas, treemap, view }`.

## Requirements & regenerating the data

The app needs a dataset; the dataset needs the decompiled source.

- The source tree defaults to `<repository root>/zombie` and can be moved
  anywhere — see [Pointing at your source tree](#pointing-at-your-source-tree).
  `zombie/` itself is gitignored; materialise it from the workspace root with
  `sh scripts/update_api_reference.sh`, which decompiles the locally installed
  game, restores a cached snapshot, or fetches a pinned source set.
- The shipped dataset was produced from **"Decompiled with Zomboid Decompiler
  v0.3.2 using Vineflower."** — the exact string, the resolved source path, where
  it came from (`--src`, `ZOMBIE_SRC`, `.env` or default) and the URL mount are
  all recorded in `meta.json`.

```bash
npm run build                                    # data + bundle, default source
ZOMBIE_SRC=/path/to/decompiled npm run build     # data + bundle, explicit source
node tools/extract.mjs --out /tmp/atlas-data     # bundle somewhere else
node tools/extract.mjs --pretty                  # indented JSON for diffing
```

- Node.js with npm is the only build requirement; the pipeline is plain Node ESM
  and the app's own dependencies are the bundled `d3-*` packages plus the parser
  the source viewer uses (see below).
- The extractor has exactly two parser dependencies: `tree-sitter-java` (MIT)
  and `web-tree-sitter`. The grammar is consumed as the `.wasm` file the
  package ships, its native peer is optional, and no install script needs to run
  — nothing compiles, and no parser code reaches the browser bundle. Where the
  global npm cache is not writable (some sandboxes), install with
  `npm i --cache .npm-cache`; the directory already exists for that reason.
- The browser suite needs Chromium and its shared libraries. Neither is installed
  system-wide in this sandbox, so both ship inside the project: `.pw-browsers/`
  (installed with `npx playwright install chromium`) and `.pw-libs/`, which was
  populated with `apt-get download` plus `dpkg-deb -x` when the system libraries
  were missing. The test harness exports `PLAYWRIGHT_BROWSERS_PATH` and
  `LD_LIBRARY_PATH` for itself, so `npm test` needs no wrapper; `tools/pw.sh`
  does the same for any other command:

```bash
sh tools/pw.sh node tools/trailer.mjs
sh tools/pw.sh node tools/test/runner.mjs --spec treemap
```

- `npm run dev` keeps the atlas in step with the tree: it generates the bundle
  when the server starts and regenerates it (about 12 s for all 3,078 files with
  the reference layer, 6.5 s without it, debounced to 400 ms) whenever a `.java`
  file under the source directory is added, changed or removed, then triggers a
  browser reload. Re-extraction runs in the Vite process, so nothing else needs
  to be running. Set `ZOMBIE_ATLAS_SKIP_DATA=1` to disable both the generation
  and the watcher, or `ZOMBIE_ATLAS_SKIP_REFS=1` to keep the loop at 6.5 s while
  editing the tree.

- For a plain static host, copy `dist/` and make sure whatever serves it also
  exposes the source tree at `/src/<mount>/**` (mount = the source directory's
  last path segment), otherwise the source viewer will report that it cannot
  load a file. The rest of the app works without it.

## Limitations

- **Static source metrics, not runtime behaviour.** Complexity, branch density, fan-in and fan-out describe the code as written. A class that is central at runtime but small and lightly referenced in source will look small here, and nothing in the atlas measures hot paths, timings or coverage.
- **The reference graph approximates coupling.** Edges come from imports, inline fully-qualified references and member type references. Reflection, string-based lookup, Lua and zedscript call sites, and data-driven wiring are invisible; an import creates an edge even when nothing in the file uses it; and a simple name that is genuinely ambiguous is dropped rather than guessed.
- **Decompiled code contains synthetic constructs.** Generated accessors and bridge methods, `$`-suffixed names and synthetic casts are part of the source the parser reads, so member counts and complexity can include code the original developer never wrote.
- **Supertypes outside the tree are external.** JDK and Kahlua base types cannot be resolved, so a type inheriting only from an external class appears as a hierarchy root, and heritage validation covers the internal share (99.7% of in-tree references) rather than everything.
- **The grammar defines what can be seen.** Records are read from `tree-sitter-java`; a file the grammar cannot parse end-to-end is still analysed best-effort and listed in `meta.json` (`parseErrors`) instead of failing the build — currently one file of 3,078 (`zombie/core/CreditsName.java`). Upgrading the grammar is expected to move figures, so treat a bundle regeneration after a grammar bump as a change to review.
- **Display culling and caps.** The treemap hides rectangles below the configured share of the map, and the hierarchy root list renders the first 400 roots (use its filter to reach the rest); the status bar's type count reflects filters, not what is currently drawn.
- **Byte sizes are spans, not sums.** A type's `bytes` is the UTF-8 size of its source span: the outermost type in a file is charged the whole file (imports, licence header and trailing comments included) and each nested type only its own span, so a file's size is not the sum of the types it declares.
