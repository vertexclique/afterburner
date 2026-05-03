#!/bin/sh
# POSIX-sh installer for the `burn` CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/vertexclique/afterburner/master/install.sh | sh
#
# Honors:
#   BURN_VERSION   pinned tag (e.g. v0.1.0). Defaults to "latest".
#   BURN_INSTALL   install dir. Defaults to $HOME/.local/bin (no sudo).
#
# Tested under bash, zsh, dash, ash (Alpine BusyBox), ksh, mksh.

set -eu

repo="vertexclique/afterburner"
install_dir="${BURN_INSTALL:-${HOME}/.local/bin}"

die() {
    printf 'burn install: %s\n' "$1" >&2
    exit 1
}

# ----- platform detection -----------------------------------------------

uname_s=$(uname -s 2>/dev/null || echo unknown)
uname_m=$(uname -m 2>/dev/null || echo unknown)

case "${uname_s}" in
    Linux*)             os="unknown-linux-gnu"; archive="tar.gz" ;;
    Darwin*)            os="apple-darwin";       archive="tar.gz" ;;
    MINGW*|MSYS*|CYGWIN*) os="pc-windows-msvc";  archive="zip"    ;;
    *) die "unsupported OS '${uname_s}'" ;;
esac

case "${uname_m}" in
    x86_64|amd64)   arch="x86_64"  ;;
    aarch64|arm64)  arch="aarch64" ;;
    *) die "unsupported architecture '${uname_m}'" ;;
esac

target="${arch}-${os}"

# ----- pick a downloader -----------------------------------------------

if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$1" -o "$2"; }
    fetch_stdout() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -q -O "$2" "$1"; }
    fetch_stdout() { wget -q -O- "$1"; }
else
    die "neither 'curl' nor 'wget' is installed"
fi

# ----- version ----------------------------------------------------------

version="${BURN_VERSION:-latest}"
if [ "${version}" = "latest" ]; then
    api="https://api.github.com/repos/${repo}/releases/latest"
    # Parse `"tag_name": "vX.Y.Z"` without depending on jq. The
    # POSIX `sed` regex is intentionally simple — the field is well-
    # formed JSON from GitHub's API.
    tag=$(fetch_stdout "${api}" \
        | tr -d '\r' \
        | grep -m1 '"tag_name"' \
        | sed -e 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    [ -z "${tag}" ] && die "could not resolve latest release tag"
else
    tag="${version}"
fi

ver="${tag#v}"
stem="burn-${ver}-${target}"
asset="${stem}.${archive}"
url="https://github.com/${repo}/releases/download/${tag}/${asset}"

# ----- download + verify ------------------------------------------------

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t burnXXXXXX)
trap 'rm -rf "${tmp}"' EXIT INT TERM HUP

printf 'burn install: %s -> %s\n' "${tag}" "${target}"
printf '  fetching %s\n' "${url}"

fetch "${url}" "${tmp}/${asset}"
fetch "${url}.sha256" "${tmp}/${asset}.sha256" 2>/dev/null || true

# Verify checksum if we got one. Pick whichever sha256 tool the
# system ships — sha256sum (Linux), shasum -a 256 (macOS/BSD).
if [ -s "${tmp}/${asset}.sha256" ]; then
    expected=$(awk 'NF{print $1; exit}' "${tmp}/${asset}.sha256")
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "${tmp}/${asset}" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "${tmp}/${asset}" | awk '{print $1}')
    else
        actual=""
    fi
    if [ -n "${actual}" ]; then
        if [ "${expected}" != "${actual}" ]; then
            die "SHA-256 mismatch (expected ${expected}, got ${actual})"
        fi
        printf '  sha256 ok\n'
    fi
fi

# ----- extract ----------------------------------------------------------

case "${archive}" in
    tar.gz)
        ( cd "${tmp}" && tar -xzf "${asset}" )
        bin_src="${tmp}/${stem}/burn"
        ;;
    zip)
        if command -v unzip >/dev/null 2>&1; then
            ( cd "${tmp}" && unzip -q "${asset}" )
        else
            die "'unzip' is required to extract ${asset}"
        fi
        bin_src="${tmp}/burn.exe"
        ;;
esac

[ -f "${bin_src}" ] || die "expected ${bin_src} after extraction"

# ----- install ---------------------------------------------------------

mkdir -p "${install_dir}"
case "${archive}" in
    zip) target_bin="${install_dir}/burn.exe" ;;
    *)   target_bin="${install_dir}/burn"     ;;
esac

cp "${bin_src}" "${target_bin}"
chmod +x "${target_bin}"

printf '\n  installed: %s\n' "${target_bin}"
case ":${PATH}:" in
    *":${install_dir}:"*) ;;
    *)
        printf '  note: %s is not on $PATH — add it to your shell rc\n' "${install_dir}"
        ;;
esac
printf '  run: burn --version\n'
