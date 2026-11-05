# Setup

Keep the shared code folder named `ai-on-prem-brain`. Each person's rules and runtime files live separately under their own `.codex` folder.

## Requirements

- Node.js 20 or newer and npm
- PowerShell 7 (`pwsh`)
- Internet access for the first install, to fetch the pinned npm package and local embedding model

## Install

1. Put this folder in a shared code location, such as `~/source/repos/ai-on-prem-brain`.
2. Add your own Codex instructions in `~/.codex/AGENTS.md`. You can also add `preferences.md` or Markdown memory notes under `~/.codex/projects/*/memory/`.
3. From the `ai-on-prem-brain` folder, preview and run setup:

   ```powershell
   pwsh -File ./setup.ps1 -WhatIf
   pwsh -File ./setup.ps1
   ```

   Setup installs dependencies, builds the rules graph and local vectors under `~/.codex/brain`, and runs the included checks. Use `-BrainHome <path>` if your Codex home is in a different location. The optional project map is attempted only when `MK_DOCS` points to a docs folder containing `graphify-out/graph.json`.

4. Check retrieval without saving a prompt to history:

   ```powershell
   node ./brain.js query "How should I configure my project?"
   ```

## Connect Codex

Codex reads global hooks from `~/.codex/hooks.json` (`%USERPROFILE%\.codex\hooks.json` on Windows). Add this command to the existing `hooks.UserPromptSubmit` array and preserve any hooks already there:

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "node \"C:\\path\\to\\ai-on-prem-brain\\brain.js\" hook",
      "timeout": 15
    }
  ]
}
```

Replace the example with the actual checkout path. Restart Codex after changing the file. For each qualifying prompt, the hook returns relevant context to Codex; it does not replace the normal answer process.

## Local files and history

Generated graphs, vectors, indexes, and prompt history stay under `~/.codex/brain`, outside the shared code folder. Prompts of four or more words are saved in monthly JSONL files. Common secret patterns are redacted, but avoid including secrets in prompts. To remove a matching entry, run `node ./brain.js forget "words from the prompt"`.