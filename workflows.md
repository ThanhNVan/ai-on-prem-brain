# Workflows

This page explains how a person sets up the shared brain and what it does when they send a prompt to Codex. The setup steps are in [setup.md](setup.md).

## The main idea

The shared folder contains the brain program. Each person keeps their own instructions in `~/.codex/AGENTS.md` and their search index and prompt history under `~/.codex/brain`. Codex sends each prompt through the local brain hook. The brain can add a few useful notes or earlier related prompts to Codex's context. Codex still answers the prompt as usual.

## One-time setup

```mermaid
flowchart LR
    A["Get the shared ai-on-prem-brain folder"] --> B["Install Node.js and PowerShell 7"]
    B --> C["Add personal instructions to ~/.codex/AGENTS.md"]
    C --> D["Run setup.ps1"]
    D --> E["Install pinned package and local language model"]
    E --> F["Build personal search index in ~/.codex/brain"]
    F --> G["Add brain.js hook to ~/.codex/hooks.json"]
    G --> H["Restart Codex"]
    H --> I["Send a prompt to check the setup"]
    D --> J["Optional: set MK_DOCS to build a project map"]
```

The setup downloads software and a small model once. The brain uses the model locally after that. Setup does not add or replace the Codex hook automatically; add its command to the existing `UserPromptSubmit` hook list and keep other entries. See [setup.md](setup.md) for the exact command.

## What happens to a prompt

```mermaid
sequenceDiagram
    actor Person
    participant Codex
    participant Hook as Local brain hook
    participant Rules as Instructions in ~/.codex/AGENTS.md
    participant Files as Local index and history in ~/.codex/brain
    participant Map as Optional project map

    Person->>Codex: Send a prompt
    Codex->>Hook: Prompt text and current project folder
    alt Short, slash, or automated prompt
        Hook-->>Codex: No added context
    else Normal prompt
        Hook->>Rules: Read instructions when the index needs updating
        Hook->>Files: Refresh or search the local index
        Hook->>Files: Find related earlier prompts
        opt A project map exists for this folder
            Hook->>Map: Find related project docs and code
            Map-->>Hook: Return the strongest matches
        end
        Hook->>Files: Save a redacted copy in local prompt history
        alt Useful matches found
            Hook-->>Codex: Add selected context
        else No useful matches
            Hook-->>Codex: No added context
        end
    end
    Codex->>Person: Answer the original prompt with any added context
```

A prompt is skipped by the hook when it starts with `/`, has fewer than four words, or is a system-generated notice. Other prompts are matched by words and synonyms. If the small local language model is installed, meaning is used too. The optional project map is searched only when one exists for the current folder. If the hook encounters an error, Codex continues without extra context.

## What stays on the person's computer

- `~/.codex/AGENTS.md`, optional preferences, and personal memory notes
- The rules graph, meaning vectors, and optional project indexes in `~/.codex/brain`
- Prompt history in `~/.codex/brain/history`, saved as readable monthly text files

The export excludes the source user's `history` folder. Each recipient's own history is created locally when the hook first saves a qualifying prompt. Secret removal uses patterns and cannot guarantee that every secret is caught, so do not put credentials in prompts.