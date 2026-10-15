#!/bin/sh
# Install a published standalone binary without Node.js, Rust or root access.
set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }
version=latest
installDir=${DEWBOW_INSTALL_DIR:-"$HOME/.local/bin"}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--install-dir)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      case "$1" in --version) version=$2 ;; --install-dir) installDir=$2 ;; esac
      shift 2 ;;
    --help) printf '%s\n' 'Usage: install.sh [--version <version>] [--install-dir <directory>]'; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
for tool in curl tar uname mktemp; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"; done
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) target=x86_64-unknown-linux-gnu ;;
  Darwin/arm64) target=aarch64-apple-darwin ;;
  Darwin/x86_64) target=x86_64-apple-darwin ;;
  *) fail 'Supported platforms: Linux x64 (glibc), macOS ARM64/x64 and Windows x64 (use install.ps1).' ;;
esac
if [ "$target" = x86_64-unknown-linux-gnu ]; then
  command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -Eiq 'glibc|gnu libc' || fail 'The Linux release requires glibc; musl is unsupported.'
fi
download() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 "$@"; }
if [ "$version" = latest ]; then
  releaseUrl=$(download --head --output /dev/null --write-out '%{url_effective}' https://github.com/rovewyn/dewbow/releases/latest)
  version=${releaseUrl##*/}
fi
# Keep tags and archive names literal, with no path or shell interpretation.
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' || fail 'Expected an unprefixed SemVer version.'
[ -n "$installDir" ] || fail 'Installation directory is empty.'
mkdir -p "$installDir"
installDir=$(cd "$installDir" && pwd -P)
destination=$installDir/dewbow
if [ -e "$destination" ] || [ -L "$destination" ]; then
  fail 'Dewbow already exists in this directory. Use dewbow upgrade.'
fi
stage=$(mktemp -d "$installDir/.dewbow-install-XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
name=dewbow-$version-$target
archive=$name.tar.gz
base=https://github.com/rovewyn/dewbow/releases/download/$version/$archive
download "$base" --output "$stage/$archive"
download "$base.sha256" --output "$stage/checksum"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$stage/$archive" | cut -d ' ' -f 1)
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$stage/$archive" | cut -d ' ' -f 1)
else
  fail 'sha256sum or shasum is required.'
fi
[ "$(cat "$stage/checksum")" = "$actual  $archive" ] || fail 'Release archive checksum does not match.'
tar -tf "$stage/$archive" > "$stage/entries"
awk -v root="$name" '
  $0 == root "/" { next }
  $0 == root "/dewbow" || $0 == root "/CLI.md" || $0 == root "/release.json" { seen[$0]++; count++; next }
  { invalid=1 }
  END { exit(invalid || count != 3 || seen[root "/dewbow"] != 1 || seen[root "/CLI.md"] != 1 || seen[root "/release.json"] != 1) }
' "$stage/entries" || fail 'Unexpected or missing release archive entries.'
tar -tvf "$stage/$archive" > "$stage/details"
LC_ALL=C grep -Ev '^[-d]' "$stage/details" > "$stage/links" || true
[ ! -s "$stage/links" ] || fail 'Links and special files are unsupported in release archives.'
tar -xf "$stage/$archive" -C "$stage"
candidate=$stage/$name/dewbow
[ -f "$candidate" ] && [ ! -L "$candidate" ] || fail 'Expected a regular executable.'
chmod 755 "$candidate"
[ "$("$candidate" --version)" = "dewbow $version" ] || fail 'Downloaded executable reports the wrong version.'
# A hard link publishes the already verified file atomically and refuses to
# overwrite a destination created by a concurrent installer.
ln "$candidate" "$destination" || fail 'Cannot install Dewbow; destination may already exist.'
printf 'Installed Dewbow %s in %s\n' "$version" "$installDir"
case ":${PATH:-}:" in *":$installDir:"*) ;; *) printf 'Add this directory to PATH: %s\n' "$installDir" ;; esac
printf '%s\n' 'Run dewbow --version, then dewbow init and dewbow doctor. Codex is installed separately.'
