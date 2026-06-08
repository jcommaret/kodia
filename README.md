# Welcome to Kodia

<div align="center">
	<img
		src="./src/vs/workbench/browser/parts/editor/media/slice_of_void.png"
		alt="Void Welcome"
		width="300"
		height="300"
	/>
</div>

## About Kodia

Kodia is a Void fork, Void is an open-source alternative to Cursor, designed to provide a powerful and flexible code editor with advanced AI integration. It allows you to:
- Use AI agents directly on your codebase
- Checkpoint and visualize changes
- Bring any model or host locally
- Send messages directly to providers without retaining your data

Kodia is a fork of VSCode, with additional features and modifications to support AI-driven development workflows.

## Features

- **AI Agents**: Integrate AI models to assist with code reviews, suggestions, and automation.
- **Checkpointing**: Save and visualize changes in your codebase over time.
- **Local Hosting**: Run models locally for privacy and performance.
- **Direct Provider Communication**: Void communicates directly with providers without retaining your data.

## Getting Started

### Prerequisites

#### Mac
- Python (usually pre-installed)
- XCode (usually pre-installed)

#### Windows
- [Visual Studio 2022](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=Community) or [VS Build Tools](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=BuildTools)
  - Workloads:
    - `Desktop development with C++`
    - `Node.js build tools`
  - Individual Components:
    - `MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)`
    - `C++ ATL for latest build tools with Spectre Mitigations`
    - `C++ MFC for latest build tools with Spectre Mitigations`

#### Linux
- Run `npm install -g node-gyp`
- Install dependencies based on your distribution:
  - Debian (Ubuntu, etc): `sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python-is-python3`
  - Red Hat (Fedora, etc): `sudo dnf install @development-tools gcc gcc-c++ make libsecret-devel krb5-devel libX11-devel libxkbfile-devel`
  - SUSE (openSUSE, etc): `sudo zypper install patterns-devel-C-C++-devel_C_C++ krb5-devel libsecret-devel libxkbfile-devel libX11-devel`

### Building and Running Void

1. Clone the repository:
   ```bash
   git clone https://github.com/voideditor/void
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start Developer Mode (this can take ~5 minutes):
   - **Windows**: Press `Ctrl+Shift+B`
   - **Mac**: Press `Cmd+Shift+B`
   - **Linux**: Press `Ctrl+Shift+B`
4. Open the Void Developer Mode window:
   - **Windows**: `./scripts/code.bat`
   - **Mac**: `./scripts/code.sh`
   - **Linux**: `./scripts/code.sh`
5. Reload the window to see your changes by pressing `Ctrl+R` (`Cmd+R` on Mac) or using the command palette (`Ctrl+Shift+P`) and selecting `Reload Window`.

### Common Issues and Fixes

- Ensure you have Node version **22.22.3** (as specified in `.nvmrc`).
  - Use [nvm](https://github.com/nvm-sh/nvm) to manage Node versions:
    ```bash
    nvm install
    nvm use
    ```
- Ensure the path to your Void folder does not contain spaces.
- If you encounter `TypeError: Failed to fetch dynamically imported module`, ensure all imports end with `.js`.
- If you encounter React errors, try running:
  ```bash
  NODE_OPTIONS="--max-old-space-size=8192" npm run buildreact
  ```
- If styles are missing, wait a few seconds and reload.
- If you encounter `libtool: error: unrecognised option: '-static'`, ensure you have GNU libtool instead of BSD libtool (default on macOS).
- If you encounter `The SUID sandbox helper binary was found, but is not configured correctly`, run:
  ```bash
  sudo chown root:root .build/electron/chrome-sandbox && sudo chmod 4755 .build/electron/chrome-sandbox
  ```

### Building from Terminal

To build Void from the terminal instead of using VSCode:
1. Follow the steps above to install dependencies.
2. Run the following command instead of pressing `Cmd+Shift+B`:
   ```bash
   npm run watch
   ```
3. The build is complete when you see output similar to:
   ```
   [watch-extensions] [00:37:39] Finished compilation extensions with 0 errors after 19303 ms
   [watch-client    ] [00:38:06] Finished compilation with 0 errors after 46248 ms
   ```

## Distributing Void

Void is distributed via our website and releases. The build pipeline is a fork of VSCodium and uses GitHub Actions to create downloadable packages. For more details, see the [void-builder](https://github.com/voideditor/void-builder) repository.

If you want to control Void's build pipeline for internal use, refer to the [void-builder](https://github.com/jcommaret/void-builder) repository for instructions on auto-updating and rebasing.

## Building a Local Executable

While we generally recommend using Developer Mode for local development, you can build a local executable if needed. This process can take ~25 minutes.

### Steps

1. Ensure you have entered Developer Mode with Void.
2. Run one of the following commands based on your platform:
   - **Mac (Apple Silicon)**: `npm run gulp vscode-darwin-arm64`
   - **Mac (Intel)**: `npm run gulp vscode-darwin-x64`
   - **Windows**: `npm run gulp vscode-win32-x64`
   - **Linux**: `npm run gulp vscode-linux-x64`

The executable will be generated in a folder outside of the `void/` directory, e.g., `VSCode-darwin-arm64/`.

## Contributing

We welcome contributions to Void! Here are some guidelines to follow:

### Pull Request Guidelines

- Submit a pull request once you've made a change.
- No need to submit an issue unless you're creating a new feature that might involve multiple PRs.
- Avoid using AI to write your PR descriptions; keep them clear and concise.
- Ensure your code follows the existing style and conventions.

### Code Style

- Use TypeScript for new features.
- Follow the existing code structure and naming conventions.
- Add comments in English for new code.
- Ensure your changes do not break existing functionality.

### Reporting Issues

If you encounter any issues or have suggestions, please [submit an issue](https://github.com/voideditor/void/issues/new).

## FAQ

### What is the difference between Void and VSCode?
Void is a fork of VSCode with additional features focused on AI integration, checkpointing, and local model hosting. It is designed to provide a more flexible and privacy-focused alternative to Cursor.

### Can I use Void for commercial projects?
Yes, Void is open-source and can be used for both personal and commercial projects. Refer to the [LICENSE](LICENSE.txt) for more details.

### How do I update Void?
If you're using a pre-built version, check for updates on the [releases page](https://github.com/voideditor/void/releases). If you're building from source, pull the latest changes and rebuild.

### How can I contribute?
Refer to the [Contributing](#contributing) section above. We welcome all contributions, from bug fixes to new features!

## License

Void is licensed under the [MIT License](LICENSE.txt).


## Building your own version : 

### a. Mac - Prerequisites

If you're using a Mac, you need Python and XCode. You probably have these by default.

### b. Windows - Prerequisites

If you're using a Windows computer, first get [Visual Studio 2022](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=Community) (recommended) or [VS Build Tools](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=BuildTools) (not recommended). If you already have both, you might need to run the next few steps on both of them.

Go to the "Workloads" tab and select:
- `Desktop development with C++`
- `Node.js build tools`

Go to the "Individual Components" tab and select:
- `MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)`
- `C++ ATL for latest build tools with Spectre Mitigations`
- `C++ MFC for latest build tools with Spectre Mitigations`

Finally, click Install.

### c. Linux - Prerequisites

First, run `npm install -g node-gyp`. Then:

- Debian (Ubuntu, etc): `sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python-is-python3`.
- Red Hat (Fedora, etc): `sudo dnf install @development-tools gcc gcc-c++ make libsecret-devel krb5-devel libX11-devel libxkbfile-devel`.
- SUSE (openSUSE, etc): `sudo zypper install patterns-devel-C-C++-devel_C_C++  krb5-devel libsecret-devel libxkbfile-devel libX11-devel`.
- Others: see [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute).

### Developer Mode Instructions

Here's how to start changing Void's code. These steps cover everything from cloning Void, to opening a Developer Mode window where you can play around with your updates.

1. `git clone https://github.com/voideditor/void` to clone the repo.
2. `npm install` to install all dependencies.
3. Open Void or VSCode, and initialize Developer Mode (this can take ~5 min to finish, it's done when 2 of the 3 spinners turn to check marks):
   - Windows: Press <kbd>Ctrl+Shift+B</kbd>.
   - Mac: Press <kbd>Cmd+Shift+B</kbd>.
   - Linux: Press <kbd>Ctrl+Shift+B</kbd>.
4. Open the Void Developer Mode window:
   - Windows: `./scripts/code.bat`.
   - Mac: `./scripts/code.sh`.
   - Linux: `./scripts/code.sh`.
5. You're good to start editing Void's code! 
   - You won't see your changes unless you press <kbd>Ctrl+R</kbd> (<kbd>Cmd+R</kbd>) inside the new window to reload. Alternatively, press <kbd>Ctrl+Shift+P</kbd> and `Reload Window`.
   - You might want to add the flags `--user-data-dir ./.tmp/user-data --extensions-dir ./.tmp/extensions` to the command in step 4, which lets you reset any IDE changes you made by deleting the `.tmp` folder.
	- You can kill any of the build scripts by pressing `Ctrl+D` in its terminal. If you press `Ctrl+C` the script will close but will keep running in the background.

If you get any errors, scroll down for common fixes.

#### Common Fixes

- Make sure you followed the prerequisite steps above.
- Make sure you have Node version `20.18.2` (the version in `.nvmrc`).
    - You can do this without changing your global Node version using [nvm](https://github.com/nvm-sh/nvm): run `nvm install`, followed by `nvm use` to install the version in `.nvmrc` locally.
- Make sure the path to your Void folder does not have any spaces in it.
- If you get `"TypeError: Failed to fetch dynamically imported module"`, make sure all imports end with `.js`.
- If you get an error with React, try running `NODE_OPTIONS="--max-old-space-size=8192" npm run buildreact`.
- If you see missing styles, wait a few seconds and then reload.
- If you get errors like `npm error libtool:   error: unrecognised option: '-static'`,  when running ./scripts/code.sh, make sure you have GNU libtool instead of BSD libtool (BSD is the default in macos)
- If you get errors like `The SUID sandbox helper binary was found, but is not configured correctly` when running ./scripts/code.sh, run
`sudo chown root:root .build/electron/chrome-sandbox && sudo chmod 4755 .build/electron/chrome-sandbox` and then run `./scripts/code.sh` again.
- If you have any other questions, feel free to [submit an issue](https://github.com/voideditor/void/issues/new). You can also refer to VSCode's complete [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute) page.



#### Building Void from Terminal

To build Void from the terminal instead of from inside VSCode, follow the steps above, but instead of pressing <kbd>Cmd+Shift+B</kbd>, run `npm run watch`. The build is done when you see something like this:

```
[watch-extensions] [00:37:39] Finished compilation extensions with 0 errors after 19303 ms
[watch-client    ] [00:38:06] Finished compilation with 0 errors after 46248 ms
[watch-client    ] [00:38:07] Starting compilation...
[watch-client    ] [00:38:07] Finished compilation with 0 errors after 5 ms
```

### Distributing
Void's maintainers distribute Void on our website and in releases. Our build pipeline is a fork of VSCodium, and it works by running GitHub Actions which create the downloadables. The build repo with more instructions lives [here](https://github.com/voideditor/void-builder).

If you want to completely control Void's build pipeline for your own internal usage, which comes with a lot of time cost (and is typically not recommended), see our [`void-builder`](https://github.com/jcommaret/void-builder) repo which builds Void and contains a few important notes about auto-updating and rebasing.


#### Building a Local Executible
We don't usually recommend building a local executible of Void - typically you should follow the steps above to distribute a complete executible with the advantages of VSCodium baked-in, or you should just use Developer Mode to run Void locally which is much faster. If you're certain this is what you want, see details below.

<details>
	<summary> Building Locally (not recommended)</summary>
If you're certain you want to build a local executible of Void, follow these steps. It can take ~25 minutes.

Make sure you've already entered Developer Mode with Void first, then run one of the following commands. This will create a folder named `VSCode-darwin-arm64` or similar outside of the void/ repo (see below). 


##### Mac
- `npm run gulp vscode-darwin-arm64` - most common (Apple Silicon)
- `npm run gulp vscode-darwin-x64` (Intel)

##### Windows
- `npm run gulp vscode-win32-x64` - most common
- `npm run gulp vscode-win32-arm64`

##### Linux
- `npm run gulp vscode-linux-x64` - most common
- `npm run gulp vscode-linux-arm64`


##### Local Executible Output

The local executible will be located in a folder outside of `void/`:
```bash
workspace/
├── void/   # Your Void fork
└── VSCode-darwin-arm64/ # Generated output
```

</details>


## Pull Request Guidelines

- Please submit a pull request once you've made a change.
- No need to submit an Issue unless you're creating a new feature that might involve multiple PRs.
- Please don't use AI to write your PR 🙂
