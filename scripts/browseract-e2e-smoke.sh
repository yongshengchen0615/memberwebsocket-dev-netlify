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

# Creation requires user-approved manual dispatch or one explicitly tagged, one-shot branch push.
NAME="browseract-ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
SESSION="browseract-ci-$GITHUB_RUN_ID"
trap 'browser-act session close "$SESSION" >/dev/null 2>&1 || true' EXIT
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
  if [[ "$page" == home ]]; then
    URL="$TARGET_URL/"
  else
    URL="$TARGET_URL/$page/"
  fi
  # HTTP status checked separately, as the DOM may render an appealing error page.
  curl -sSL --retry 2 --max-time 30 -o "$OUT/$page-response.html" \
    -w '%{http_code}\n%{url_effective}\n' "$URL" > "$OUT/$page-http.txt"
  python3 - "$page" "$OUT/$page-http.txt" <<'PY'
import os, sys
from urllib.parse import urlparse
page, path = sys.argv[1:]
lines = open(path, encoding="utf-8").read().splitlines()
status = int(lines[0]) if lines else 0
final = urlparse(lines[1]) if len(lines) > 1 else None
host = urlparse(os.environ["TARGET_URL"]).hostname
if status != 200 or not final or final.hostname != host or final.scheme != "https":
    raise SystemExit(f"HTTP_OR_REDIRECT_FAILURE: {page}: status={status}; final={lines[1:]}")
PY
  if [[ "$page" != home ]]; then
    browser-act --session "$SESSION" navigate "$URL"
  fi
  browser-act --session "$SESSION" wait stable
  browser-act --session "$SESSION" state > "$OUT/$page-state.txt"
  # Do not retain OAuth state, code challenge, or redirect query strings in artifacts.
  sed -i -E 's@https://access\.line\.me/[^[:space:]]+@https://access.line.me/[REDACTED]@g' "$OUT/$page-state.txt"
  browser-act --session "$SESSION" eval \
    "(() => {
      if (!document.body || document.readyState === 'loading') throw Error('PAGE_NOT_READY');
      if (location.hostname === 'access.line.me' && location.pathname.startsWith('/oauth2/'))
        return JSON.stringify({status:'AUTH_REQUIRED',provider:'LINE',note:'Anonymous account cannot inspect protected UI'});
      if (!['integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app',
            'develop--memberwebsocket-dev-netlify.netlify.app'].includes(location.hostname))
        throw Error('UNEXPECTED_REDIRECT');
      if (/^(404|not found|page not found)/i.test(document.title.trim()))
        throw Error('NOT_FOUND_DOCUMENT');
      if (!document.body.innerText.trim()) throw Error('EMPTY_DOCUMENT');
      const assets = performance.getEntriesByType('resource')
        .filter(x => /\\.(js|css)(\\?|$)/i.test(x.name) && x.responseStatus >= 400)
        .map(x => ({ url: x.name, status: x.responseStatus }));
      if (assets.length) throw Error('ASSET_HTTP_FAILURE: ' + JSON.stringify(assets));
      return JSON.stringify({url:location.href,title:document.title,
        viewportWidth:innerWidth,viewportHeight:innerHeight,
        bodyLength:document.body.innerText.length,failedAssets:assets});
    })()" > "$OUT/$page-assertion.txt"
  browser-act --session "$SESSION" network requests > "$OUT/$page-network.txt"
  sed -i -E 's@https://access\.line\.me/[^[:space:]]+@https://access.line.me/[REDACTED]@g' "$OUT/$page-network.txt"
  browser-act --session "$SESSION" screenshot "$OUT/$page.png"
  echo "Read-only BrowserAct smoke complete: $page"
done
