#!/usr/bin/env bash
# Personal build: the latest official release tag plus this branch's commits,
# installed over the official "Open Design.app".
#
#   scripts/custom-mac-install.sh            # rebase onto the newest release tag, build, install
#   scripts/custom-mac-install.sh --no-rebase  # build and install the branch as it is
#
# The build keeps the official identity (bundle id, release-stable data, MCP
# paths) and copies the official config values from the installed app. The
# in-app updater is pointed at a dead address: an official update would
# replace this build with one that lacks the branch's commits.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_LINK="/Applications/Open Design.app"
BACKUP_DIR="$HOME/Library/Application Support/Open Design/custom-build-backups"

if [[ "${1:-}" != "--no-rebase" ]]; then
  git diff --quiet && git diff --cached --quiet || { echo "commit or stash tracked changes first" >&2; exit 1; }
  git fetch origin --tags --quiet
  latest=$(git tag -l 'open-design-v*' --sort=-v:refname | grep -E '^open-design-v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
  base=$(git describe --tags --abbrev=0 --match 'open-design-v[0-9]*' HEAD)
  if [[ "$latest" != "$base" ]]; then
    echo "rebasing $(git branch --show-current) from $base onto $latest"
    git rebase --onto "$latest" "$base"
  fi
fi
version=$(git describe --tags --abbrev=0 --match 'open-design-v[0-9]*' HEAD | sed 's/^open-design-v//')

corepack pnpm install --frozen-lockfile
corepack pnpm --filter @open-design/tools-pack build

target=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$APP_LINK")
config="$target/Contents/Resources/open-design-config.json"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$config"   # fail here, not with empty build values
read_config() {
  python3 -c 'import json,sys
v = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): v = v.get(k, "") if isinstance(v, dict) else ""
print(v)' "$config" "$1"
}
export OPEN_DESIGN_AMR_PROFILE=$(read_config amrProfile)
export OPEN_DESIGN_TELEMETRY_RELAY_URL=$(read_config telemetryRelayUrl)
export POSTHOG_KEY=$(read_config posthogKey)
export POSTHOG_HOST=$(read_config posthogHost)
export OD_VELA_WEB_URL=$(read_config velaWebUrl)
export OD_VELA_WEB_URL_PROD=$(read_config velaWebUrls.prod)
export OD_VELA_WEB_URL_TEST=$(read_config velaWebUrls.test)
export OD_VELA_WEB_URL_FEATURE_TEST=$(read_config velaWebUrls.feature-test)
export OD_UPDATE_METADATA_URL="http://127.0.0.1:9/open-design-custom-build-updates-disabled/metadata.json"

# A plain x.y.z version carries no channel, so name the stable namespace the
# way the official stable build does; otherwise the app opens "default" data.
built=$(corepack pnpm --silent tools-pack mac build --app-version "$version" --namespace release-stable --portable --to app --json \
  | python3 -c 'import json,sys; s=sys.stdin.read(); i=0 if s.startswith("{") else s.find("\n{")+1; print(json.loads(s[i:])["appPath"])')
[[ -d "$built" ]] || { echo "build did not report an app path" >&2; exit 1; }

# Quit the running app through its normal quit path so the daemon shuts down cleanly.
python3 - <<'EOF'
import time
from AppKit import NSRunningApplication
apps = NSRunningApplication.runningApplicationsWithBundleIdentifier_("io.open-design.desktop")
for a in apps: a.terminate()
for _ in range(60):
    if all(a.isTerminated() for a in apps): break
    time.sleep(0.5)
else:
    raise SystemExit("Open Design did not quit; install skipped")
EOF

# This build never updates in place, so a downloaded official payload could
# only run instead of it: the launcher prefers a newer one and rolls back to
# an older "last successful" one. Drop them all.
rm -rf "$HOME/Library/Application Support/Open Design/launcher/channels/stable/namespaces/release-stable/versions/"*

# Keep at most two backups: the last official app and the last custom build.
mkdir -p "$BACKUP_DIR"
if [[ -d "$target" ]]; then
  kind=custom
  signature=$(codesign -dv "$target" 2>&1 || true)
  [[ "$signature" == *"TeamIdentifier=236R69AWW2"* ]] && kind=official
  backup="$BACKUP_DIR/$kind-$(date +%Y%m%d-%H%M%S).zip"
  ditto -c -k --keepParent "$target" "$backup"
  find "$BACKUP_DIR" -name "$kind-*.zip" ! -path "$backup" -delete
fi
# Copy beside the old app first, so a failed copy leaves the old app in place.
rm -rf "$target.new"
ditto "$built" "$target.new"
rm -rf "$target"
mv "$target.new" "$target"
echo "installed Open Design $version (custom) at $target"
