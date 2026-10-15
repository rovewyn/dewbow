# Dewbow

<p align="center">
  <img src="docs/assets/dewbow-logo.svg" alt="dewbow logo" width="320" />
</p>

Dewbow is a self-hosted CLI and daemon for managing local Codex conversations through Web.

Documentation is in [docs/](docs/).

## Install

Install and log in to the Codex CLI first. Node.js and Rust are not required.

### Linux x64 and macOS ARM64/x64

```sh
curl -fsSL https://raw.githubusercontent.com/rovewyn/dewbow/main/scripts/install.sh | sh
```

### Windows x64 (PowerShell)

```powershell
irm https://raw.githubusercontent.com/rovewyn/dewbow/main/scripts/install.ps1 | iex
```

Installs to `~/.local/bin`; add it to PATH if prompted.

## Upgrade

Check for updates, then stop all Dewbow daemons before upgrading:

```sh
dewbow upgrade --check
dewbow daemon stop
dewbow upgrade
```
