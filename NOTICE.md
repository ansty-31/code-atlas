# Attribution and modification notice

Code Atlas is a modified distribution of **Zombie Atlas**, originally developed
by **kolulu23 (kolulu) and the Zedema contributors**.

- Original repository: https://github.com/kolulu23/Zedema
- Original component: `zombie-atlas/`
- Imported base commit: `5356122cffc3689716fcfc83c6a3aab2b475017a`
- Original component at that revision: https://github.com/kolulu23/Zedema/tree/5356122cffc3689716fcfc83c6a3aab2b475017a/zombie-atlas
- Modified distribution: https://github.com/ansty-31/code-atlas
- Modification date: **2026-10-29**
- Modifications maintained by: **ansty-31**

The upstream Git history and author identities are retained. Existing copyright
and license notices remain applicable; this notice does not transfer ownership
of upstream work or imply endorsement by its authors.

This derivative work is distributed under the **GNU General Public License,
version 3 only (SPDX: GPL-3.0-only)**, retaining the upstream GPL v3 license.
The complete, unmodified license text is in [LICENSE](LICENSE). It is provided
without warranty, to the extent permitted by applicable law.

## Changes in this distribution

- Extracted the atlas component into the repository root while retaining the
  upstream history and GitHub fork relationship.
- Added Python, C and C++ parsing adapters and mixed-language file discovery.
- Added directory/file structure, module entities, language filtering and
  colouring, and language-aware source highlighting.
- Added static imports/include resolution, Python alias/src-layout handling,
  syntax diagnostics and per-language capability descriptions.
- Added generic source configuration, output cleanup, regression fixtures,
  portable project tests, and multilingual architecture documentation.
- Retained the Java implementation for compatibility.

See [CHANGELOG.md](CHANGELOG.md) for release details.

## Distribution boundaries

This repository contains the visualizer and its own synthetic test fixtures.
It does not distribute Project Zomboid game source/assets, analyzed AUV or STM32
project sources, local datasets, credentials, node_modules, or generated builds.
The projects inspected with the tool retain their own licenses; using the
visualizer does not license those independent inputs under this repository's GPL.

Third-party dependency copyright and license texts are preserved in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Those dependencies retain their
respective licenses.
