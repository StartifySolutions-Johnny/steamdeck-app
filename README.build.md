# Building Gamepad App (Electron) — Windows and Linux

This project bundles a React app inside an Electron wrapper. The repository contains two folders:

- `nintendo-switch-web-ui` — React app source. Build outputs to `nintendo-switch-web-ui/dist`.
- `steamdeck-app` — Electron wrapper which embeds the `dist` build.

Prerequisites

- Node.js (16+ recommended). Electron-builder may require a compatible Node and native toolchain.
- On Windows: nothing special for basic builds (electron-builder will produce an NSIS installer).
- On Linux (Arch): have `libfuse` and basic build tools installed. For AppImage creation, `appimagetool` is used by electron-builder automatically.

Install dev dependencies

```powershell
cd d:\Stari Podaci\GitHub\steamdeck-app
npm install
```

Embed the React build into the Electron folder

```powershell
# from repo root (or inside steamdeck-app)
cd d:\Stari Podaci\GitHub\nintendo-switch-web-ui
npm run build
cd ..\steamdeck-app
npm run embed-dist
```

Build for Windows (NSIS, x64)

```powershell
cd d:\Stari Podaci\GitHub\steamdeck-app
npm run build:win
```

Build for Linux (AppImage, x64)

```bash
cd /path/to/repo/steamdeck-app
npm run build:linux
```

Outputs

- Installer(s) and AppImage will be in `steamdeck-app/release/`.

Notes

- electron-builder will download the Electron binaries during the build. Make sure you have a stable network connection.
- If you want multi-arch builds (arm/x64), add the desired archs to the `--x64` flags or update the `build` config.
- For CI builds, consider using cross-platform build runners or configure `nsis` properly.
