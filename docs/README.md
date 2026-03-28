# Onshape Multi-Model Exporter

A batch-export CLI for Onshape that generates multiple CAD variants from parametric models using property permutations, with parallel processing, local format conversion, and 3D preview generation.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Credentials Setup](#credentials-setup)
- [Quick Start](#quick-start)
- [Interactive Menu](#interactive-menu)
- [config.json Reference](#configjson-reference)
- [Permutations System](#permutations-system)
- [Export Formats](#export-formats)
- [CLI Flags](#cli-flags)
- [Output Structure](#output-structure)
- [Building a Standalone Binary](#building-a-standalone-binary)
- [Release Workflow](#release-workflow)

---

## Prerequisites

| Requirement | Purpose | Install |
|---|---|---|
| **Bun** ≥ 1.1 | Runtime & package manager | `curl -fsSL https://bun.sh/install \| bash` |
| **Onshape account** | Source CAD models | [onshape.com](https://onshape.com) |
| **Python 3.7+** *(optional)* | Local STEP / 3MF conversion | `python --version` |
| **Playwright Chromium** *(optional)* | 3D preview generation | `bunx playwright install chromium` |

Install Python dependencies for local conversion:

```bash
pip install -r requirements.txt
```

---

## Installation

```bash
# Clone and install
bun install

# Install + set up Playwright browser (for preview)
bun run setup
```

---

## Credentials Setup

The tool needs Onshape API keys. Get them at [dev-portal.onshape.com/keys](https://dev-portal.onshape.com/keys).

**Recommended — `.env` file:**

```env
ONSHAPE_ACCESS_KEY=your_access_key_here
ONSHAPE_SECRET_KEY=your_secret_key_here
```

On first run with no `.env`, the tool will prompt you to enter credentials and save them automatically.

> Credentials are **never written back to `config.json`** to prevent accidental secrets in version control.

---

## Quick Start

```bash
bun start
```

On first launch with no models configured, the tool walks you straight into adding your first model.

---

## Interactive Menu

### Main Menu

```
Select a model to process:
> my-part
  another-part
  ➕ Add New Model
  Exit
```

### Model Actions

| Action | Description |
|---|---|
| **📦 Export** | Shows an export preview (total files, skips, new) then runs all jobs |
| **🔄 Convert** | Batch-converts existing STLs in `dist/<model>/STL/` to STEP / 3MF locally |
| **🖼️ Preview** | Renders a 5×5 grid PNG of all STL variants using Playwright |
| **⚙️ Permutations** | Fetches the Onshape config schema and guides you through setting up value arrays |
| **✏️ Edit Details** | Set preview appearance (color, metalness, roughness) and transforms (rotation, translation) |
| **❌ Delete Model** | Removes model from `config.json` |

### Adding a Model

The **Add New Model** form asks for:

1. **Model Name** — used for folder names and file prefixes (e.g. `gridfinity-bin`)
2. **Onshape Document URL** — the URL from your browser on the part studio tab
3. **Export Formats** — multiselect: STL, STEP, 3MF, IGES

### Configuring Permutations

Select **⚙️ Permutations** on any model to:

1. Fetch the model's configuration parameters live from Onshape
2. Choose which values to include per parameter:
   - *Enum* → checkbox list
   - *Boolean* → select true / false
   - *Numeric* → comma-separated values (e.g. `10 mm, 20 mm, 30 mm`)
3. Preview the generated combinations and confirm to save

The Cartesian product of all selected values becomes a named permutation group in `config.json`.

---

## config.json Reference

```json
{
  "settings": {
    "maxConcurrent": 3
  },
  "credentials": {},
  "models": [
    {
      "name": "my-part",
      "url": "https://cad.onshape.com/documents/<doc>/w/<ws>/e/<elem>",
      "formats": ["STL", "STEP", "3MF"],
      "propSets": [],
      "permutations": [
        {
          "name": "sizes",
          "props": {
            "Width":  ["50 mm", "75 mm", "100 mm"],
            "Height": ["30 mm", "45 mm"],
            "HasLid": [true, false]
          }
        }
      ],
      "rotation":    { "x": -90, "y": 0, "z": 0 },
      "translation": { "x": 0,   "y": 0, "z": 0 },
      "style": {
        "color":     "#2c3e50",
        "metalness": 0.8,
        "roughness": 0.15
      }
    }
  ]
}
```

### Field Reference

| Field | Type | Description |
|---|---|---|
| `settings.maxConcurrent` | `number` | Max parallel export / conversion jobs. Default `3`. |
| `models[].name` | `string` | Unique model identifier. Used for output folder and file prefix. |
| `models[].url` | `string` | Onshape part studio URL. |
| `models[].formats` | `string[]` | Export formats: `"STL"`, `"STEP"`, `"3MF"`, `"IGES"`. |
| `models[].propSets` | `object[]` | Static list of pre-defined property combinations. Each object = one export. |
| `models[].permutations` | `PermGroup[]` | Dynamic permutation groups. Each group's props are expanded into a Cartesian product. |
| `models[].rotation` | `{x,y,z}` | Rotation in degrees applied to the 3D preview. |
| `models[].translation` | `{x,y,z}` | Translation applied to the 3D preview. |
| `models[].style.color` | `string` | Hex color for preview material. |
| `models[].style.metalness` | `0–1` | Preview material metalness. |
| `models[].style.roughness` | `0–1` | Preview material roughness. |
| `models[].style.emissive` | `string` | Emissive color hex. |
| `models[].style.emissiveIntensity` | `number` | Emissive light intensity. |

---

## Permutations System

### `propSets` vs `permutations`

**`propSets`** — a static list where each object is one exact export variant:

```json
"propSets": [
  { "Width": "50 mm", "Height": "30 mm" },
  { "Width": "75 mm", "Height": "45 mm" }
]
```

**`permutations`** — an array of named groups, each containing parameter → values arrays. The tool generates every combination (Cartesian product) of each group's values:

```json
"permutations": [
  {
    "name": "small",
    "props": {
      "Width":  ["50 mm", "75 mm"],
      "Height": ["30 mm", "45 mm"]
    }
  }
]
```

This produces **2 × 2 = 4** export variants from the `small` group.

### Multiple Groups

Multiple permutation groups let you define independent sets of variants:

```json
"permutations": [
  {
    "name": "no-lid",
    "props": {
      "Width":  ["50 mm", "75 mm"],
      "Height": ["30 mm", "45 mm"]
    }
  },
  {
    "name": "with-lid",
    "props": {
      "Width":  ["50 mm", "75 mm"],
      "Height": ["30 mm", "45 mm"],
      "HasLid": [true]
    }
  }
]
```

Both groups are expanded and merged. During export, `propSets` and all expanded permutation groups are combined into one flat list.

### Example Expansion

```json
"props": {
  "Connector": ["Large", "Small"],
  "Height":    ["15 mm", "30 mm"],
  "HasBottom": [true, false]
}
```

Generates **2 × 2 × 2 = 8** combinations:

```
{ Connector: "Large", Height: "15 mm", HasBottom: true  }
{ Connector: "Large", Height: "15 mm", HasBottom: false }
{ Connector: "Large", Height: "30 mm", HasBottom: true  }
{ Connector: "Large", Height: "30 mm", HasBottom: false }
{ Connector: "Small", Height: "15 mm", HasBottom: true  }
...
```

---

## Export Formats

| Format | Method | Notes |
|---|---|---|
| **STL** | Onshape API | Fetched directly |
| **STEP** | Local Python converter | Converts from STL; requires Python + dependencies |
| **3MF** | Local Python converter | Converts from STL; requires Python + trimesh |
| **IGES** | Onshape API | Fetched directly |

### Onshape API Export Flow

1. POST to `/api/partstudios/.../translations` with format and configuration string
2. Poll `/api/translations/{id}` every 5 seconds until `requestState === "DONE"`
3. Download the result from `/api/documents/.../externaldata/{id}`

### Local Conversion

STEP and 3MF are converted locally from STL using a Python helper script (`src/local_converter.py`), avoiding Onshape API calls for derived formats. The Python script attempts up to 5 reconstruction strategies (gmsh, trimesh, cadquery, etc.).

### Skip Logic

Files that already exist on disk are skipped. Pass `LOG_LEVEL=silly` to see skip messages:

```bash
LOG_LEVEL=silly bun start
```

---

## CLI Flags

### `--convert <folder>`

Batch-convert all STL files in a folder to STEP and 3MF locally, then exit:

```bash
bun start --convert ./dist/my-part/STL
```

### `--preview <folder>`

Generate a `preview.png` for all STL files in a folder, then exit. Automatically looks up model config (rotation, translation, style) if the path matches a model name:

```bash
bun start --preview ./dist/my-part/STL
```

### `LOG_LEVEL=silly`

Show verbose output including skipped files:

```bash
LOG_LEVEL=silly bun start
```

---

## Output Structure

```
dist/
└── my-part/
    ├── STL/
    │   ├── my-part_Width_50-mm_Height_30-mm.stl
    │   ├── my-part_Width_50-mm_Height_45-mm.stl
    │   └── ...
    ├── STEP/
    │   ├── my-part_Width_50-mm_Height_30-mm.step
    │   └── ...
    ├── 3MF/
    │   └── ...
    └── preview.png
```

### File Naming

```
<model-name>_<Param1>_<value1>_<Param2>_<value2>...<ext>
```

- Spaces in values → hyphens (`50 mm` → `50-mm`)
- Special characters (`&`, `=`, `;`) → underscores
- Extension → lowercase (`.stl`, `.step`, `.3mf`)

---

## Building a Standalone Binary

```bash
bun run build:win    # → build/onshape-exporter.exe
bun run build:linux  # → build/onshape-exporter
bun run build:mac    # → build/onshape-exporter-mac
```

The binary includes all JS dependencies. Playwright is loaded dynamically at runtime — install it separately on the target machine if you need preview:

```bash
bun add playwright
bunx playwright install chromium
```

---

## Release Workflow

```bash
bun run release          # patch bump  (1.0.0 → 1.0.1)
bun run release minor    # minor bump  (1.0.0 → 1.1.0)
bun run release major    # major bump  (1.0.0 → 2.0.0)
bun run release 1.2.3    # exact version
```

The release script:

1. Validates a clean git working tree
2. Bumps version in `package.json` and commits
3. Creates and pushes a git tag
4. Builds binaries for Windows, Linux, and macOS
5. Packages each binary with `local_converter.py`, `requirements.txt`, `.env.example`, `README.md`, and `LICENSE`
6. Archives as `.zip` (Windows / macOS) or `.tar.gz` (Linux)
7. Publishes a GitHub release with all three archives

Requires the [GitHub CLI](https://cli.github.com/) (`gh`) to be installed and authenticated.
