#!/usr/bin/env bash
# Launch the Playwright MCP server. In Claude Code cloud containers, use the
# preinstalled Chromium (which runs as root and needs --no-sandbox); elsewhere
# fall back to Playwright MCP's default browser.
set -euo pipefail

args=(--headless --isolated)
if [[ -x /opt/pw-browsers/chromium ]]; then
  args+=(--executable-path /opt/pw-browsers/chromium --no-sandbox)
fi

exec npx -y @playwright/mcp@latest "${args[@]}" "$@"
