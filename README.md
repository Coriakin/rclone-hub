# rclone-hub

Manage your `rclone` remotes from a clean local web app built for browsing and moving files confidently.

rclone-hub gives you a visual, multi-pane workspace for exploring remotes, searching across directories, and running transfers without living in terminal commands all day.

![rclone-hub screenshot](./screenshot1.jpg)

## Features

- Multi-pane navigation for side-by-side browsing across remotes.
- Built-in search with live progress so you can quickly find files across large remote trees.
- Transfer-focused workflow designed to make file moves clear and predictable.
- Local-first web UI that runs on your machine.
- Cross-platform setup using a single startup script.
- Built around `rclone` remotes so you can keep using the storage you already have.

## Quick Start

Clone or open this repo, then run:

```bash
git clone https://github.com/andreas-io/rclone-hub.git
cd rclone-hub
./scripts/dev.sh
```

Then open the local URL shown in your terminal (typically `http://127.0.0.1:5173`).

For advanced defaults (for example fixed ports), you can use the root `.env` file. See the docs section below for deeper setup details.

## Who It's For

- People who manage files across multiple cloud or network remotes with `rclone`.
- Users who want a visual workflow instead of a command-heavy routine.
- Anyone who needs faster side-by-side file operations across storage backends.

## Documentation

- `docs/architecture.md` for system design details.
- `docs/transfer-safety.md` for transfer behavior and safety notes.
- `docs/api.md` for backend API details.

## Current Status

This is an active work in progress. Core workflows are usable, and the product is continuing to evolve based on real usage and feedback.
