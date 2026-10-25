#!/usr/bin/env bash
# Anonymous read-only preview smoke. Never submit forms, log in or send LINE notifications.
set -Eeuo pipefail
TARGET_URL="$1"
export TARGET_URL
OUT="evidence/browseract"
mkdir -p "$OUT"
python3 - <<'PY'
import os
from urllib.parse import urlparse
u = urlparse(os.environ["TARGET_URL"])
allowed = {
  "integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app",
  "develop--memberwebsocket-dev-netlify.netlify.app",
}
if (u.scheme != "https" or u.hostname not in allowed or u.username or u.password
        or u.port or u.query or u.fragment or u.path not in ("", "/")):
    raise SystemExit("Refusing non-preview, non-HTTPS, credentialed or non-root URL")
PY

# Creation is called ONLY from manually-dispatched workflow with explicit opt-in.
NAME="browseract-ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
SESSION="browseract-ci-$GITHUB_RUN_ID"
trap 'browser-act --session "$SESSION" session close "$SESSION" >/dev/null 2>&1 || true' EXIT
browser-act get-skills advanced > "$OUT/advanced.txt"
cat "$OUT/advanced.txt"
browser-act --format json browser create --type chrome --name "$NAME" \
  --desc "Approved anonymous read-only CI smoke for Netlify preview" > "$OUT/create.json"
browser-act --format json browser list > "$OUT/browsers.json"

BROWSER_ID="$(python3 - "$NAME" "$OUT/create.json" "$OUT/browsers.json" <<'PY'
import json, pathlib, sys
name = sys.argv[1]
def find(node):
    if isinstance(node, dict):
        if node.get("name") == name and node.get("id"):
            return str(node["id"])
        for obj in node.values():
            result = find(obj)
            if result: return result
    if isinstance(node, list):
        for obj in node:
            result = find(obj)
            if result: return result
    return None
for filepath in sys.argv[2:]:
    try: doc = json.loads(pathlib.Path(filepath).read_text(encoding="utf-8"))
    except json.JSONDecodeError: continue
    result = find(doc)
    if result:
        print(result)
        break
else:
    sys.exit("BrowserAct did not expose the newly created browser ID")
PY
)"

browser-act --session "$SESSION" browser open "$BROWSER_ID" "$TARGET_URL/"
for page in home member booking points admin; do
  if [[ "$page" != home ]]; then
    browser-act --session "$SESSION" navigate "$TARGET_URL/$page/"
  fi
  browser-act --session "$SESSION" wait stable
  browser-act --session "$SESSION" state > "$OUT/$page-state.txt"
  browser-act --session "$SESSION" eval \
    "(() => { if (!document.body || document.readyState === 'loading') throw Error('PAGE_NOT_READY'); return document.title || 'untitled'; })()" \
    > "$OUT/$page-assertion.txt"
  browser-act --session "$SESSION" screenshot "$OUT/$page.png"
  echo "Read-only BrowserAct smoke complete: $page"
done
