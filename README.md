# Dewbow

<p align="center">
  <img src="docs/assets/dewbow-logo.svg" alt="dewbow logo" width="320" />
</p>

Dewbow is a self-hosted CLI and daemon for managing local Codex conversations through Web.

Documentation is in [docs/](docs/).

## Install

The installers download a prebuilt executable with the daemon and Web interface included. Node.js, npm, Rust and Cargo are not required. Install and log in to the independent Codex CLI separately before using Dewbow.

### Linux x64 and macOS ARM64/x64

Requires `curl`, `tar` and `sha256sum` or `shasum`. Linux also requires glibc.

```sh
curl -fsSL https://raw.githubusercontent.com/rovewyn/dewbow/main/scripts/install.sh | sh
```

### Windows x64 (PowerShell)

Requires PowerShell 5.1 or newer and the Windows system `tar.exe`.

```powershell
irm https://raw.githubusercontent.com/rovewyn/dewbow/main/scripts/install.ps1 | iex
```

The scripts are `scripts/install.sh` and `scripts/install.ps1` in this repository. The commands above use their full raw GitHub URLs and execute the scripts directly without saving a script file.

Both installers select the latest stable release, verify its checksum and install to `~/.local/bin`. Add that directory to PATH if prompted, then run `dewbow --version`. To select another version or directory, use `-Version` and `-InstallDir` in PowerShell, or `--version` and `--install-dir` in the shell script.

## Upgrade

Check for a newer stable release:

```sh
dewbow upgrade --check
```

Read the release notes and stop every daemon using this executable, including those in custom state directories. For the default state directory:

```sh
dewbow daemon stop
dewbow upgrade
dewbow --version
dewbow doctor
dewbow web
```

Use `--state-dir <directory>` with `daemon stop` and `upgrade` for a custom state directory. Use `dewbow upgrade --version <version>` to select a newer release explicitly. Upgrade retains a backup of the previous executable.
