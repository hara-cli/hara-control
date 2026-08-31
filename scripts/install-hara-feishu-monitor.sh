#!/usr/bin/env bash
set -euo pipefail

CONTROL_URL=""
KEY_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --control-url)
      CONTROL_URL="${2:-}"
      shift 2
      ;;
    --key-file)
      KEY_FILE="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$CONTROL_URL" in
  https://*|http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "--control-url must use HTTPS or loopback HTTP" >&2; exit 2 ;;
esac

[ -n "$KEY_FILE" ] || { echo "--key-file is required" >&2; exit 2; }
[ -f "$KEY_FILE" ] || { echo "key file does not exist: $KEY_FILE" >&2; exit 2; }
[ ! -L "$KEY_FILE" ] || { echo "key file must not be a symbolic link" >&2; exit 2; }
key_mode="$(stat -f '%Lp' "$KEY_FILE")"
[ "$key_mode" = "600" ] || { echo "key file must use mode 600" >&2; exit 2; }
key_owner="$(stat -f '%u' "$KEY_FILE")"
[ "$key_owner" = "$(id -u)" ] || { echo "key file must be owned by the current user" >&2; exit 2; }

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/hara-feishu-monitor.py"
AUTOMATION_DIR="$HOME/.codex/automations/hara-feishu-monitor"
DESTINATION="$AUTOMATION_DIR/monitor.py"
PLIST="$HOME/Library/LaunchAgents/com.nanhara.codex-feishu-mention-monitor.plist"
LABEL="com.nanhara.codex-feishu-mention-monitor"

[ -f "$SOURCE" ] || { echo "monitor source is missing: $SOURCE" >&2; exit 1; }
[ -f "$PLIST" ] || { echo "existing LaunchAgent is missing: $PLIST" >&2; exit 1; }
mkdir -p "$AUTOMATION_DIR"
temporary="$AUTOMATION_DIR/.monitor.py.$$"
install -m 700 "$SOURCE" "$temporary"
"$temporary" --self-test
mv -f "$temporary" "$DESTINATION"

set_plist_value() {
  local setting_name="$1"
  local setting_value="$2"
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:${setting_name} ${setting_value}" "$PLIST" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:${setting_name} string ${setting_value}" "$PLIST"
}
set_plist_value HARA_FEEDBACK_CONTROL_URL "$CONTROL_URL"
set_plist_value HARA_FEEDBACK_INTAKE_KEY_FILE "$KEY_FILE"
chmod 600 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Hara Feishu monitor installed and restarted."
