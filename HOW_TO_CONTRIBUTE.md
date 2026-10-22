# Contributing to Kodia

This guide covers building Kodia from source, running it in developer mode, and the checks a change goes through before it is merged. To find your way around the code, read [KODIA_CODEBASE_GUIDE.md](KODIA_CODEBASE_GUIDE.md) first.

Bugs and ideas go in [Issues](https://github.com/jcommaret/kodia/issues).

## Prerequisites

**macOS**: Xcode and Python 3. Both usually come with the system or the Xcode command line tools.

**Windows**: [Visual Studio 2022](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=Community) or the [Build Tools](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=BuildTools), with:
- the workloads `Desktop development with C++` and `Node.js build tools`;
- the individual components:
  - `MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)`;
  - `C++ ATL for latest build tools with Spectre Mitigations`;
  - `C++ MFC for latest build tools with Spectre Mitigations`.

**Linux**: `npm install -g node-gyp`, then:
- Debian/Ubuntu: `sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python-is-python3`
- Fedora: `sudo dnf install @development-tools gcc gcc-c++ make libsecret-devel krb5-devel libX11-devel libxkbfile-devel`
- openSUSE: `sudo zypper install patterns-devel-C-C++-devel_C_C++ krb5-devel libsecret-devel libxkbfile-devel libX11-devel`

**All platforms**: Node.js **24.18.0**, the version in `.nvmrc`. The easiest way to get it is [nvm](https://github.com/nvm-sh/nvm): `nvm install` then `nvm use`.

## Run Kodia in developer mode

1. Clone and install:
   ```bash
   git clone https://github.com/jcommaret/kodia.git
   cd kodia
   nvm install && nvm use
   npm install
   ```
   The first `npm install` takes a while. It also installs the git hooks.

2. Compile, and keep compiling as you edit. Either:
   - press <kbd>Cmd+Shift+B</kbd> (<kbd>Ctrl+Shift+B</kbd> on Windows and Linux) in VS Code or Kodia, opened on this folder. This starts the watchers for the workbench, the extensions and the React UI (the sidebar, settings and other React views). **Kill VS Code - Build** in **Run Task** stops them.
   - or, in a terminal, build the React UI with `npm run buildreact`, then run `npm run watch`. When you work on the React code, also keep `npm run watchreact` running in another terminal; it rebuilds the UI on every change.

   The first build takes a few minutes. The workbench is ready when the watchers report `Finished compilation`.

3. Start Kodia:
   - macOS and Linux: `./scripts/code.sh`
   - Windows: `./scripts/code.bat`

   Some useful flags:
   - `--user-data-dir ./.tmp/user-data --extensions-dir ./.tmp/extensions` uses a throwaway profile, reset by deleting `.tmp`.
   - `--agents` opens the Agents window.

4. After a change, reload the window with <kbd>Cmd+R</kbd> (<kbd>Ctrl+R</kbd>), or run **Reload Window** from the command palette.

### Common problems

- **Wrong Node version**: run `nvm use` in the repository, or use the exact version in `.nvmrc`.
- **A space in the repository's path**: the build doesn't support it.
- **`TypeError: Failed to fetch dynamically imported module`**: an import is missing its `.js` extension.
- **Missing styles**: wait a few seconds and reload. If they still don't appear, run `npm run buildreact` again.
- **The React build runs out of memory**: `NODE_OPTIONS="--max-old-space-size=8192" npm run buildreact`.
- **`libtool: error: unrecognised option: '-static'` on macOS**: install GNU libtool. BSD libtool is the macOS default.
- **`The SUID sandbox helper binary was found, but is not configured correctly` on Linux**: run `sudo chown root:root .build/electron/chrome-sandbox && sudo chmod 4755 .build/electron/chrome-sandbox`.

VS Code's [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute) wiki covers the rest of the build.

## Before opening a pull request

The CI (`.github/workflows/pr-checks.yml`) runs these checks on every pull request. You can run them locally:

```bash
# Lint Kodia's code (errors only)
npx eslint --quiet src/vs/workbench/contrib/void --ignore-pattern '**/react/src2/**' --ignore-pattern '**/react/out/**'

# Build and typecheck the React UI (only errors under src/ count)
cd src/vs/workbench/contrib/void/browser/react && node build.js && npx tsc --noEmit -p tsconfig.json | grep '^src/'; cd -

# Typecheck the workbench and the build scripts
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p src/tsconfig.json
npm run typecheck --prefix build

# Unit tests
npm run test-void
```

When you change the Kodia agent, also run its tests:

```bash
npm run transpile-client
npm run test-node -- --runGlob "vs/platform/agentHost/test/node/kodia*.test.js"
```

### Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) (`feat(agent): …`, `fix(settings): …`, `chore(deps): …`). The git hook checks them, and `.husky/commit-msg.mjs` gives the rules and examples. If commits aren't being checked, run `npm run reinstall-git-hooks`.

### Pull requests

- Open the pull request against `master`. One topic per pull request.
- Explain what changed and why, and how you tested it.
- If you change a VS Code core file (anything outside `contrib/void` and `agentHost/node/kodia`), keep the change minimal and add a `Kodia:` comment explaining it. This keeps upstream merges manageable.
- Pull requests are merged with a merge commit, not squashed.

## Building a local executable

Developer mode is faster for day-to-day work. To produce a standalone app anyway, enter developer mode first, then run one of the following. It takes around 25 minutes.

- macOS: `npm run gulp vscode-darwin-arm64` (Apple Silicon) or `npm run gulp vscode-darwin-x64` (Intel)
- Windows: `npm run gulp vscode-win32-x64` or `npm run gulp vscode-win32-arm64`
- Linux: `npm run gulp vscode-linux-x64` or `npm run gulp vscode-linux-arm64`

The app is written next to the repository, in a folder such as `../VSCode-darwin-arm64/`.

## Releases

Official releases are built by [kodia-builder](https://github.com/jcommaret/kodia-builder), a VSCodium-based pipeline on GitHub Actions. It also strips telemetry and points updates at Kodia's releases. Releases are published on [this repository](https://github.com/jcommaret/kodia/releases).
