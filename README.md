# Kodia

<div align="center">
	<img src="./resources/linux/code.png" alt="Kodia" width="200" height="200" />
</div>

Kodia is an AI code editor built on [VS Code](https://github.com/microsoft/vscode). It started as a fork of [Void](https://github.com/voideditor/void), the open-source alternative to Cursor.

You bring the models: Kodia talks directly to the providers you configure, or to models running on your machine, without going through a Kodia server.

## Features

- **Chat sidebar** with three modes: **Normal** (questions), **Gather** (reads and searches your code) and **Agent** (edits files and runs commands, asking for approval).
- **Apply and Ctrl+K**: apply suggested code, or edit a selection in place. Changes show as diffs you accept or reject.
- **Checkpoints**: undo everything a turn changed.
- **Autocomplete** with fill-in-the-middle models (Codestral and others).
- **Agents window**: long-running agent sessions, with Kodia's Mistral agent.
- **Providers**:
  - cloud: Anthropic, OpenAI, Gemini, Mistral, DeepSeek, xAI, Groq, OpenRouter;
  - cloud platforms: Google Vertex, Azure, AWS Bedrock, LiteLLM;
  - any OpenAI-compatible API.
- **Local models**: Ollama, LM Studio and vLLM, plus MLX on Apple Silicon.
- **Tools**: MCP servers, a terminal, and file search and editing. Kodia also keeps a project memory in `.kodia/memory.md`.
- **Attachments**: images and PDFs, for the models that support them.
- **Commit messages** generated from your changes in Source Control.
- **Import** your settings and extensions from VS Code, Cursor or Windsurf.

## Install

Download the latest version for macOS, Windows or Linux from the [releases](https://github.com/jcommaret/kodia/releases). Kodia checks for new versions itself.

## Build from source

You need Node.js 24.18.0 (see `.nvmrc`), plus Xcode on macOS, Visual Studio Build Tools on Windows, or the build packages on Linux.

```bash
git clone https://github.com/jcommaret/kodia.git
cd kodia
nvm install && nvm use
npm install
npm run buildreact
npm run watch        # keep it running; wait for "Finished compilation"
./scripts/code.sh    # in another terminal (scripts\code.bat on Windows)
```

[HOW_TO_CONTRIBUTE.md](HOW_TO_CONTRIBUTE.md) has the full instructions: prerequisites, common problems, checks and pull requests. [KODIA_CODEBASE_GUIDE.md](KODIA_CODEBASE_GUIDE.md) explains how the code is organized.

## License

Kodia's additions are licensed under the [Apache License 2.0](LICENSE.txt). VS Code, on which Kodia is built, is licensed under the [MIT License](LICENSE-VS-Code.txt).

Kodia builds on the work of the [Void](https://github.com/voideditor/void), [VS Code](https://github.com/microsoft/vscode) and [VSCodium](https://github.com/VSCodium/vscodium) projects.
