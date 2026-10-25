#!/usr/bin/env bash
# Run locally in an interactive, PRIVATE terminal. Never put Remote Assist URLs in
# GitHub Actions logs, PRs, tickets or public artifacts.
set -Eeuo pipefail

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  echo "Usage: bash scripts/browseract-live-handoff.sh <https-preview-root> [existing-test-browser-id]" >&2
  exit 2
fi
TARGET_URL="$1"
EXISTING_BROWSER_ID="${2:-}"
export TARGET_URL
python3 - <<'PY'
import os
from urllib.parse import urlparse
u = urlparse(os.environ["TARGET_URL"])
allowlist = {
    "integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app",
    "develop--memberwebsocket-dev-netlify.netlify.app",
}
if (u.scheme != "https" or u.hostname not in allowlist or u.username or u.password
        or u.port or u.query or u.fragment or u.path not in ("", "/")):
    raise SystemExit("SECURITY: only an allowlisted HTTPS Netlify preview root is permitted")
PY

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "A private interactive terminal is required. Do NOT run this in GitHub Actions." >&2
  exit 2
fi
if ! command -v browser-act >/dev/null 2>&1; then
  echo "BrowserAct CLI missing. Install it with: uv tool install browser-act-cli --python 3.12" >&2
  exit 2
fi

browser-act --version
browser-act get-skills core --skill-version 2.0.2 >/dev/null
browser-act get-skills advanced >/dev/null

NOW="$(date +%s)"
NAME="memberwebsocket-live-$NOW-$$"
SESSION="$NAME"
TEMP_DIR="$(mktemp -d)"
chmod 700 "$TEMP_DIR"
opened=0
cleanup() {
  if [[ "$opened" == 1 ]]; then
    browser-act session close "$SESSION" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

if [[ -n "$EXISTING_BROWSER_ID" ]]; then
  echo "Existing browser ID supplied. Ensure it contains only an approved TEST account."
  browser-act browser list "$EXISTING_BROWSER_ID" >/dev/null
  BROWSER_ID="$EXISTING_BROWSER_ID"
else
  echo
  echo "Browser to create: $NAME"
  echo "Type: chrome (isolated, starts blank; does NOT import your Chrome login profile)"
  echo "Target: $TARGET_URL"
  printf 'Type CREATE to explicitly approve browser creation: '
  read -r APPROVAL
  if [[ "$APPROVAL" != CREATE ]]; then
    echo "No browser was created."
    exit 1
  fi

  # BrowserAct's browser-management Confirmation Gate requires advanced skill above.
  browser-act --format json browser create --type chrome --name "$NAME" \
    --desc "Isolated manual handoff for anonymous MemberWebsocket Netlify preview" \
    > "$TEMP_DIR/create.json"
  browser-act --format json browser list > "$TEMP_DIR/browsers.json"

  BROWSER_ID="$(python3 - "$NAME" "$TEMP_DIR/create.json" "$TEMP_DIR/browsers.json" <<'PY'
import json, pathlib, sys
name = sys.argv[1]
def find(node):
    if isinstance(node, dict):
        if node.get("name") == name and node.get("id"):
            return str(node["id"])
        for val in node.values():
            candidate = find(val)
            if candidate:
                return candidate
    elif isinstance(node, list):
        for val in node:
            candidate = find(val)
            if candidate:
                return candidate
    return None
for name_of_file in sys.argv[2:]:
    try:
        data = json.loads(pathlib.Path(name_of_file).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        continue
    browser_id = find(data)
    if browser_id:
        print(browser_id)
        break
else:
    raise SystemExit("Browser creation could not be verified; no session was opened")
PY
)"
fi

# Opening does not type, submit forms, log in, or modify preview data.
browser-act --session "$SESSION" browser open "$BROWSER_ID" "$TARGET_URL/"
opened=1

echo
echo "BrowserAct Remote Assist will generate a private browser-control URL."
echo "Keep this terminal open. NEVER publish the URL or use a production account."
echo "If the CLI requests BrowserAct authentication, follow its private login flow."
echo "The browser will be paused for the human handoff."
echo

# DO NOT pipe, tee or upload output. The live link is an access credential.
browser-act --session "$SESSION" remote-assist \
  --objective "Let the owner privately observe and manually take over an isolated preview browser; no production access or mutations"

echo
echo "Use the Remote Assist URL above from your phone or computer."
echo "Once finished, come back to THIS terminal and press Enter to close the session."
printf 'Press Enter to close: '
read -r _
echo "Session closed. The independent browser profile remains until separately deleted."
