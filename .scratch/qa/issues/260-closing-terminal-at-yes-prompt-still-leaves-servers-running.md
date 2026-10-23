# 260: Closing the terminal at a guarded command's YES prompt still leaves its embedded server running

**Status:** needs-triage
**Category:** bug
**Severity:** medium
**Area:** disp
**Round:** 3

## What I did
Fresh project (`node <repo>/packages/super-deploy/dist/cli.js init`, `git init`, `pnpm install`), two finalized migrations, a shared-server target `scratch` (`postgresTarget({ env: "SCRATCH_DATABASE_URL" })`) deployed and flagged disposable.

Then ran a guarded command in a pseudo-terminal, waited for `Type YES ...`, and closed the terminal (closed the pty master; the program in the terminal is `zsh -fc '...'`, as with a terminal window running a shell):

```python
# closeterm.py: python3 -I closeterm.py <cmd...>
import os, pty, sys, time, select, fcntl, struct, termios
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
    os.execvp(sys.argv[1], sys.argv[1:])
buf = b""
while b"Type YES" not in buf:
    r,_,_ = select.select([fd],[],[],1)
    if r: buf += os.read(fd, 65536)
time.sleep(1)
os.close(fd)                      # the terminal window closes
os.waitpid(pid, 0)
```

```sh
python3 -I closeterm.py zsh -fc 'pnpm exec super-deploy rebuild --target scratch --to 2; echo done'
sleep 15
# list processes whose cwd is in the project
```

Same with `python3 -I closeterm.py pnpm exec super-deploy disposable --target dev --set yes`.

## Expected
README, "Interrupting a command": "closing the terminal (SIGHUP) stops the running command. It cleans up first ... and the embedded servers the command started are stopped."

## Actual
The CLI process is gone, but the embedded server it started is still running 15+ seconds later (and stays up until the next command takes it over):

- after `rebuild --target scratch`: the server in `.super-deploy/rehearsal` (postmaster pid 26887, cwd `/tmp/sd-qa3/disp/p1/.super-deploy/rehearsal`);
- after `disposable --target dev`: the server in `.super-deploy/dev` (postmaster pid 19181).

Reproduced 3 times (twice for `rebuild`, with and without a shell between the terminal and pnpm; once for `disposable --target dev`).

For comparison, the same prompt with a plain SIGHUP sent only to the node CLI process (terminal left open) cleans up correctly: prints `Interrupted by SIGHUP: cleaning up ...`, `Target dev is unchanged: the interruption came before the flag change started.`, exits 129, and the dev server stops. SIGTERM to the process group also cleans up. Only the real terminal close leaves the server behind.

The target itself is fine (`status` shows it unchanged and no attempt recorded), and the next command that uses the server takes it over and stops it, as the README says.

## Notes
Guess: once the terminal is gone, the CLI's write of `Interrupted by SIGHUP: ...` (or the prompt's cursor-restore escape) to the dead tty fails with EIO and the process dies before it stops the servers. The `closeterm.py` script itself also saw EIO on the master when the shell exited.
