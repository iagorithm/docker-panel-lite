# Correction history

## 2026-07-22T14:28:04+00:00 · applied

- Run: `0d5d669c96b349d3`
- Requested by: `christ.ibarrac@gmail.com`
- Branch: `fix/fix-pid-check-implement-pid-running-and-remove-s-0d5d66`
- Delivery: `branch`

Confirmed error
- Logs show repeated "ngrok failed with ERR_NGROK_314" and inspection found a bug: _pid_running returned None for positive pids and a stray pid-check try/except was incorrectly placed after a return in _ngrok_error_message.

Minimal fix prepared for review, not committed
- Implemented a correct _pid_running(pid: int) -> bool that returns True when the pid exists (os.kill(pid, 0)), and removed the unreachable try/except block from _ngrok_error_message so that function only formats messages.

Exact code change
- File changed: services/worker/worker/core/ngrok.py
- Replaced the broken _pid_running implementation:
  - Old: returned False for pid<=0 and nothing otherwise.
  - New: returns False for pid<=0, else calls os.kill(pid, 0) and returns True; catches OSError and returns False.
- Removed stray try/except (os.kill(pid, 0) ... ) mistakenly placed after a return in _ngrok_error_message.

Complete pending proposal
- Optional: add unit tests for _pid_running and NgrokService current()/stop(). Not implemented here to keep the change minimal and focused.

Changed path
- services/worker/worker/core/ngrok.py

Notes
- Edit is surgical and preserves all other behavior, interfaces, imports, comments, and file structure. The write reason/commit message: "Fix pid check: implement _pid_running and remove stray unreachable try/except in _ngrok_error_message"
