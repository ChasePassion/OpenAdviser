# Changelog

## 1.2.0

### Changed

- **Flash notification instead of foreground stealing**: Replaced all OS-level foreground-stealing logic (PowerShell AttachThreadInput, minimize-restore tricks) with Chrome's `drawAttention` API. The worker window now flashes the taskbar to notify the user instead of aggressively stealing focus. This is less disruptive when the user is actively using the computer.
- Removed `--no-focus` CLI flag and `OPENADVISER_SKIP_FOCUS` environment variable (no longer needed).

## 1.1.0

### Improved

- **Wait initial delay**: `wait` command now waits 60 seconds before the first read poll, giving the web AI time to start generating. Previously it polled immediately, wasting extension cycles on empty reads. Configurable via `--initial-delay <ms>`.
- **Reliable window foreground on Windows**: Each read now forces the provider popup window to the foreground via a minimize-restore cycle. This bypasses the Windows foreground-lock restriction that prevented `focused: true` from working when another application held the foreground.

## 1.0.9

- Add relevant code evidence support to OpenAdviser skill.

## 1.0.3

- Refocus worker window during adviser waits.
- Use visible worker window for provider runs.

## 1.0.2

- Add wait command and full-read extraction.

## 1.0.1

- Initial public release.
