# Parser parity: replacing the hand-made Java lexer with tree-sitter

`tools/lib/java-lexer.mjs` (a comment/string masker, a brace-depth profile and a
set of regex declaration scanners) was replaced by `tools/lib/java-ast.mjs`, which
parses each file with the `tree-sitter-java` grammar and walks the tree. This
document records what that swap changed, why, and how each difference was
verified — the work `tools/parity.mjs` gated while both parsers existed.

## How it was verified

While both parsers existed, `tools/parity.mjs` ran them over the same tree and
classified every disagreement into categories that were either **must match
exactly** or **intentional corrections with a recorded count**. The run that
cleared the swap:

```
parser parity — 3078 files
  old scanner 1032 ms · tree-sitter 5706 ms
  4749 types / 96237 members

   ok  type-missing 0          ok  type-kind 0        ok  type-parent 0
   ok  type-doc 0              ok  type-extends 0     ok  type-implements 0
   ok  member-missing 0        ok  member-modifiers 0
   ok  member-annotations 0    ok  member-throws 0    ok  member-bodyLines 0
   ok  member-init 0           ok  member-type 0      ok  file-imports 0
   ok  fqn-edge 0              ok  file-loc 0         ok  file-blank 0
   acc type-span 4742          acc type-declLine 4742
   acc enum-constant-shape 993 acc member-params 318  acc file-code 84
   acc file-comment 84         acc member-complexity 82
   acc type-annotations 38     acc type-modifiers 38  acc member-extra 21
   acc count-methods 15        acc member-field-type 2 acc count-fields 1
   acc count-enumConstants 1   acc member-reclassified 1 acc parse-errors 1
```

Both the scanner and that harness have since been deleted — tree-sitter is the
only parser, and validation tooling is being redesigned. They remain in history
if the comparison needs reproducing:

```bash
git show 1c8f3b1:zombie-atlas/tools/lib/java-lexer.mjs > /tmp/java-lexer.mjs
git show 1c8f3b1:zombie-atlas/tools/parity.mjs      > /tmp/parity-oracle.mjs
```

## Exact matches (no behaviour change)

Type set, kinds, nesting and parentage (4,749 = 4,749, zero missing or extra,
including named local classes inside method bodies and nested types inside enum
bodies); javadoc on types; `extends`/`implements` clauses; blank-line counts;
member modifiers, annotations, `throws`, body line counts and field `init`
values; import lists; every member's identity `(kind, name, line)`; and the class
edges produced by inline `zombie.*` references.

Three comparison rules were needed to make those checks meaningful:

- **References are compared after attribution and resolution**, not as raw text.
  The masked regex also matched calls on a variable named `zombie`
  (`zombie.isDead()`), which resolve to no type and produce no edge; the walker
  never produces them, and the graph is identical.
- **Line statistics are compared only where both parsers measured the same span.**
  They usually do not, because of the `declLine` correction below.
- **Type text is compared with dots closed up**, because stripping a type-use
  annotation used to leave a space behind (`GameProfiler. ProfileArea`).

## Corrections (the `acc` rows)

Every change below is the new parser reporting what the source actually says,
and the old one being wrong. Each was inspected at least once by hand.

| # | Correction | Count | Cause | Visible effect |
| --- | --- | --- | --- | --- |
| 1 | `declLine` is the declaration line | 4,742 types | the old scanner backed up to the previous `;`/`}` and reported that line (`AchievementManager` on line 8 was reported as line 6) | inspector "declared at", source-viewer scroll and highlight (now correct) |
| 2 | Nested-type spans start at the declaration | 1,671 nested types (part of row 1) | consequence of row 1: the span included the preceding blank line | `loc`/`code`/`blank`/`bytes` of nested types; headline code total 724,991 → 723,502 |
| 3 | Comment/code split | 84 files, 173 lines | `maskSource` blanked string literals, so a line holding only a string looked like a comment (`CharacterSmartTexture` 252 → 256 code lines) | `comment` 10,230 → 10,057, `code` +173 at file level |
| 4 | Type annotations and modifiers | 38 types | the same back-up truncated annotation runs that follow a `}` (`@Target({…})`), losing `public` and the annotations | stereotype/legend counts, inspector badges |
| 5 | Enum-constant argument counts | 993 constants | masked string arguments made `splitTopLevel` count zero arguments (`CHARGE("charge")` → 0) | `argCount` in the member shards |
| 6 | Parameter types | 318 params | `readType` treated a leading annotation as the type, and mis-split some names (`String name, String defaultValue` → second parameter lost its type) | member signatures, member-type coupling |
| 7 | Field types | 2 fields | `public @Nullable V value;` was read as type `''` with the annotation dropped | member signatures |
| 8 | Members the old reader dropped | 21 members in 15 types | a type-use annotation inside the return type (`GameProfiler.@Nullable ProfileArea profile`) broke the name match, so the whole method was lost | method counts, insights rankings, member lists |
| 9 | Enum constants found | 1 enum | `CreditsName`'s walker stopped at 115 of 255 constants | `enumConstants`, `members` |
| 10 | Complexity | 82 methods in 63 types | canonical branch-node set (`if`/`for`/`while`/`do`/`case`/`catch`/`&&`/`||`/ternary) instead of a text scan that also counted `?` in wildcard casts; `default:` labels are not branch points | `complexity` column, insights rankings |
| 11 | Compact record constructor | 1 declaration | the old scanner recorded `public ItemKey { … }` as a field named `?` | member kind/name in `ItemKey` |
| 12 | Unparsable files reported | 1 file | `tree-sitter-java` reports one ERROR node in `zombie/core/CreditsName.java`; the old parser never noticed, and this file is also where it lost 140 enum constants | `meta.parseErrors` |

Measured effect on the bundle:

| Figure | Before | After |
| --- | --- | --- |
| types / packages | 4,749 / 270 | unchanged |
| class edges / package edges | 31,247 / 4,096 | unchanged (3 edge weights change) |
| fan-in / fan-out per type | — | unchanged (they count distinct types) |
| code lines (sum over types) | 724,991 | 723,502 |
| methods / fields | 49,624 / 46,613 | 49,645 / 46,612 |
| members | 96,237 | 96,257 |
| validator problems | 11 | 6 |
| heritage coverage | 99.5 % | 99.7 % |
| extraction time | ~2.0 s | ~6.2 s |

## Definition choices

Committed deliberately, so later changes are visible as drift:

- **Membership**: only declarations that are direct children of a type body.
  Nested types are types, not members; static and instance initialiser blocks are
  skipped; interface and annotation constants (`constant_declaration`) are fields.
- **Member identity**: `(kind, name, line)`. Compact record constructors are
  constructors named after the record.
- **Varargs** keep the old textual form (`Object... args`) so emitted signatures
  are unchanged; a real `varargs` flag is a Phase 2 addition.
- **Field `bodyLines`** is the whole declaration span — including an anonymous
  class or lambda block — while `init` stops where the old scanner stopped: at
  the first top-level `{`.
- **`init`** is masked text (comment and literal interiors blanked) after the
  first top-level `=`, capped at 160 characters, or `null` when it is empty.
- **Javadoc** is the nearest preceding block comment starting with `/**`, with
  only whitespace and annotations in between.
- **Line accounting**: a line is a comment line only when every non-whitespace
  character on it lies inside a comment; a blank line is blank first.
- **Spans**: the outermost type in a file owns the whole file (imports, licence
  header and trailing comments included); every nested type owns its own span, so
  package totals never double count an inner class.

## Environment

- `tree-sitter-java@0.23.5` (MIT) is used **only** for the `tree-sitter-java.wasm`
  it ships; its native `tree-sitter` peer is optional, so nothing compiles and no
  install script needs to run.
- `web-tree-sitter@0.27.0` loads that grammar at extraction time. Both are
  devDependencies: no parser code reaches the browser bundle.
- The wasm is resolved through `createRequire(...).resolve(...)`, so the process
  working directory never matters.
- In sandboxes where the global npm cache is not writable, install with
  `npm i --cache .npm-cache` (the directory already exists for this reason).

## Re-running the comparison

To reproduce the ledger from the history, restore the two files above, point
`tools/parity-oracle.mjs` at the restored lexer, and run it against the same
source tree. The counts in this document are from **3,078 files, decompiled with
Zomboid Decompiler v0.3.2 (Vineflower)**; a different tree gives different counts.
