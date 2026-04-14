# Terminal title sync for GitLab Duo CLI
# Adds spinner/checkmark to terminal tab based on Duo CLI log output.
# Source this file or add to ~/.zshrc
#
# Managed by: opencode-terminal-title
# Do not edit between the markers below — changes will be overwritten by install/uninstall.

# --- BEGIN opencode-terminal-title ---
_tt_duo_log_dir="${TMPDIR:-/tmp}gitlab-duo-cli"
_tt_bin_dir="${HOME}/.config/opencode/bin"

_tt_write_title() {
  printf '\033]2;%s\007\033]0;%s\007' "$1" "$1" > /dev/tty 2>/dev/null
}

_tt_spinner_pid=""
_tt_title=""

_tt_start_spinner() {
  _tt_stop_spinner
  (
    while true; do
      for f in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do
        _tt_write_title "$f $_tt_title"
        sleep 0.1
      done
    done
  ) &
  _tt_spinner_pid=$!
}

_tt_stop_spinner() {
  [ -n "$_tt_spinner_pid" ] && kill "$_tt_spinner_pid" 2>/dev/null && wait "$_tt_spinner_pid" 2>/dev/null
  _tt_spinner_pid=""
}

_tt_show_done() {
  _tt_stop_spinner
  _tt_write_title "✓ $_tt_title"
  # Poll for tab focus to clear checkmark
  if [ -x "$_tt_bin_dir/active-terminal-tab" ]; then
    (
      while true; do
        sleep 0.5
        active=$("$_tt_bin_dir/active-terminal-tab" 2>/dev/null)
        case "$active" in
          *"$_tt_title"*) _tt_write_title "$_tt_title"; break ;;
        esac
      done
    ) &
  fi
}

# Override duo command with title-tracking version
duo() {
  local log_file watcher_pid

  # Run the real duo
  command duo "$@" &
  local duo_pid=$!

  # Wait briefly for the log file to appear
  sleep 0.5
  log_file=$(ls -t "$_tt_duo_log_dir"/duo-cli-log-*.log 2>/dev/null | head -1)

  if [ -n "$log_file" ]; then
    # Tail the log and react to patterns
    tail -f "$log_file" 2>/dev/null | while IFS= read -r line; do
      case "$line" in
        *"Running workflow"*|*"start_duo_workflow_execution"*)
          _tt_start_spinner
          ;;
        *"Workflow completed successfully"*)
          _tt_show_done
          ;;
      esac
    done &
    watcher_pid=$!
  fi

  # Wait for duo to finish
  wait "$duo_pid" 2>/dev/null
  local exit_code=$?

  # Cleanup
  _tt_stop_spinner
  [ -n "$watcher_pid" ] && kill "$watcher_pid" 2>/dev/null
  _tt_write_title ""

  return $exit_code
}
# --- END opencode-terminal-title ---
