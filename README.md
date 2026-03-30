# Onshape Model Exporter

[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://costicapuntaru.github.io/onshape-permutation-config-exporter/USER_MANUAL.html)

Batch-export parametric CAD models from Onshape. Define your parameter combinations once — the tool generates every variant as STL, STEP, 3MF, or IGES, with parallel processing and automatic 3D preview grids.

## Documentation

For non-programmers, check our [📘 User Manual](https://costicapuntaru.github.io/onshape-permutation-config-exporter/USER_MANUAL.html) for simple setup and usage.
For advanced technical details, see the [Full Documentation](https://costicapuntaru.github.io/onshape-permutation-config-exporter/).

## Disclamer

This tool was 100% "vibe" coded, as i don't expect to get to much use, only the end result was taken into consideration, no best practices or performance otimizations where done, it has one job, to export a set of permutation of models from onshape in various formats so i can upload them easly to printables.com or other sites to share 3d models

## Quick Start

### Option A — Pre-built executable (no Bun required)

1. Download the latest release for your OS from the [Releases](../../releases) page and extract it
2. Get Onshape API keys from [dev-portal.onshape.com/keys](https://dev-portal.onshape.com/keys)
3. Run the executable — a setup wizard will prompt for your API keys on first launch:
   ```
   # Windows
   onshape-exporter.exe

   # Linux / macOS
   ./onshape-exporter
   ```

> Run the executable from the folder where you want `config.json` and `dist/` to be created.

### Option B — From source

```bash
git clone https://github.com/your-org/model-exporter
cd model-exporter
bun run setup        # installs deps + Playwright browsers
cp .env.example .env # add your Onshape API keys
bun start
```

## Optional features

| Feature               | What to install                                                                     |
| --------------------- | ----------------------------------------------------------------------------------- |
| STEP / 3MF conversion | `pip install -r requirements.txt` — place `local_converter.py` next to the exe |
| 3D preview generation | `bunx playwright install chromium` (one-time, ~120 MB)                            |

## Configuration

`config.json` is created automatically on first use. Key structure:

```json
{
  "settings": { "maxConcurrent": 3 },
  "models": [
    {
      "name": "my-part",
      "url": "https://cad.onshape.com/documents/<doc>/w/<ws>/e/<elem>",
      "formats": ["STL", "STEP", "3MF"],
      "propSets": [
        { "Width": "50 mm", "Height": "30 mm" },
        { "Width": "75 mm", "Height": "45 mm" }
      ],
      "rotation": { "x": -90, "y": 0, "z": 0 },
      "style": { "color": "#2c3e50", "metalness": 0.8, "roughness": 0.15 }
    }
  ]
}
```

Each entry in `propSets` is one export variant. Use the **Permutations** menu option to auto-generate the full Cartesian product from your Onshape configuration schema.

## Output

```
dist/
└── my-part/
    ├── STL/   my-part_Width_50mm_Height_30mm.stl …
    ├── STEP/
    ├── 3MF/
    └── preview.png
```

## Build from source

Bun supports cross-compilation — you can build all three platform binaries from any OS:

```bash
bun run build:win    # → build/onshape-exporter.exe
bun run build:linux  # → build/onshape-exporter
bun run build:mac    # → build/onshape-exporter-mac
```

## Release

Bumps version, commits, tags, builds all platforms, packages zips, and publishes to GitHub Releases in one command. Requires [gh CLI](https://cli.github.com) authenticated.

```bash
bun run release          # patch bump: 1.0.0 → 1.0.1
bun run release minor    # minor bump: 1.0.0 → 1.1.0
bun run release major    # major bump: 1.0.0 → 2.0.0
bun run release 1.2.3    # exact version
```

Each release package contains:

```
onshape-exporter(.exe)   ← preview.html embedded
local_converter.py
requirements.txt
.env.example
README.md
LICENSE
```


## License

MIT
