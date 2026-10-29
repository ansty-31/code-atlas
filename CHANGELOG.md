# Changelog

## 2026-10-29 — Initial Code Atlas derivative

Based on `kolulu23/Zedema` commit
`5356122cffc3689716fcfc83c6a3aab2b475017a`, component `zombie-atlas/`.
Original authors: kolulu23 (kolulu) and Zedema contributors.
Modifications: ansty-31.

### Added

- Python, C and C++ structure extraction alongside the original Java support.
- Mixed-language projects with directory → file → entity navigation.
- Per-language filtering, colouring, syntax highlighting and capability notices.
- Python static import aliases and conventional src layouts; C/C++ include edges.
- Syntax diagnostics, repeated-extraction cleanup, and synthetic C++/Python tests.
- Architecture and validation documentation; root-level GPL and attribution.

### Changed

- Product name to Code Atlas and generic ATLAS_* configuration names, retaining
  existing ZOMBIE_* aliases and legacy data/API names for compatibility.
- Standalone repository layout and default tests using bundled synthetic inputs.
- Source-viewer URL handling and metric aggregation for member leaves.

### Current limits

- Static syntax/dependency analysis, not a precise Python/C++ call graph.
- No macro expansion, overload resolution or cross-language binding inference.
- C++ declarations/definitions retain separate locations; Lua and PowerShell
  adapters remain future work.
