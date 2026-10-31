# Agent safety: destructive operations

What an agent may delete, move or overwrite in this repository, and what it must never touch.

This repository is developed on Windows, macOS and Linux, so the rules are written against all
three: a habit that is harmless on one platform is destructive on another. [`AGENTS.md`](../AGENTS.md)
carries the short version and links here for the detail.

Deleting from a shell is permanent on every platform. `rm` and `rd` do not use the recycle bin
(Trash on macOS, `~/.local/share/Trash` on Linux, `$RECYCLE.BIN` on Windows), they stay silent
about failures, and they leave no per-file history to restore from.

## Hard rules

Recursive deletion is allowed only on a path that resolves **strictly inside the checkout the agent
was given**, and only after the path check in [Deleting something safely](#deleting-something-safely).
Never run any of these against a protected path (§ [Protected paths](#protected-paths)) or anything
outside the checkout:

| Category              | Commands                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recursive delete      | `rm -rf`, `rd /s /q`, `rmdir /s /q`, `del /s /q`, `erase /s /q`, `find … -delete`, `find … -exec rm` — inside the checkout only                        |
| Volume destruction    | `format`, `diskpart clean`, `Initialize-Disk`, `Clear-Disk`, `Format-Volume`, `diskutil eraseDisk`, `diskutil apfs deleteContainer`, `mkfs*`, `wipefs` |
| Partition destruction | `parted mklabel`, `fdisk` on a device, `diskpart clean`                                                                                                |
| Raw device write      | `dd of=/dev/…`, `dd of=\\.\PhysicalDrive…`, `shred` on a device                                                                                        |
| Mirrored delete       | `rsync --delete`, `rclone sync`, unless a `--dry-run` pass was reviewed first                                                                          |
| Recursive PowerShell  | `Remove-Item -Recurse` (with or without `-Force`), inside the checkout only                                                                            |
| Recovery removal      | `vssadmin delete shadows`, `tmutil deletelocalsnapshots`, `lvremove` of a snapshot, emptying the recycle bin or Trash                                  |

Never escalate a delete that failed. `sudo`, an elevated shell or "run it as administrator" turns a
permission error — the only thing still protecting the target — into an unrecoverable loss.

## Protected paths

Never write to, move or delete these, however harmless the parent directory looks:

| Platform | Paths                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| All      | the filesystem root (`/`, `C:\`, `D:\`), `$HOME` / `%USERPROFILE%`, this repository's root, `.git`, and the root of any worktree                     |
| Windows  | `C:\`, `D:\`, `%SystemRoot%`, `%ProgramFiles%`, `%USERPROFILE%`, `$RECYCLE.BIN`, `System Volume Information`, and every directory above the checkout |
| macOS    | `/`, `/System`, `/Library`, `/Applications`, `/Users`, `/Volumes`, `/private`                                                                        |
| Linux    | `/`, `/etc`, `/usr`, `/var`, `/boot`, `/home`, `/dev`, `/proc`, `/sys`                                                                               |

Write only inside the checkout you were given. Recursive deletion is allowed only below its root;
the checkout root, `.git` and a worktree root are never deletion targets. `git worktree remove`,
`git clean` and any build step must be scoped to it.

Never write recovered or restored data back to its source disk. A restore target is another physical
disk; recovering onto the volume being recovered destroys what is left.

## Deleting something safely

Use `bun scripts/safe-delete.ts <file>` for a file, or
`bun scripts/safe-delete.ts --recursive <dir>` for a directory tree inside the checkout. It
refuses symlinks, missing paths, the checkout root, `.git`, a Git worktree root and paths outside
the checkout. Do not hand-roll `Remove-Item` cleanup in a script without the path check below.

1. Delete a worktree only with Git: `git worktree remove <path>`, then `git worktree prune`.
   Never reconstruct that step with `rm -rf` or `rd`.
2. Resolve the path and print **what it resolved to**, not what you typed:

   ```bash
   realpath -- "$target"        # macOS without coreutils: cd -- "$target" && pwd -P
   ```

   ```powershell
   (Resolve-Path -LiteralPath $target -ErrorAction Stop).Path
   ```

   The result must be **strictly inside** this checkout, and must not be `/`, `$HOME`, `/Users`, a
   drive root, the checkout root, `.git` or a worktree root. Recursive deletion is allowed only
   after this check passes.

3. Fail closed on an empty value. In a shell script: `set -euo pipefail` and `${target:?target is
   unset}`. An empty variable in `rm -rf "$target/"` becomes `rm -rf /`.
4. Quote every expansion, and never put a glob in front of a delete: `rm -rf -- "$target"` is
   allowed only after step 2, never `rm -rf $target/*`. With an empty `$target` the unquoted form
   becomes `rm -rf /*`.
5. Use `--` before a path that could start with `-`, and `-LiteralPath` in PowerShell, so a name
   cannot be read as an option.
6. For a batch delete, enumerate every path in a dry run, get the list confirmed, then delete.
7. Prefer the platform's trash over a permanent delete where one is available: `gio trash` or
   `trash-put` on Linux, `trash` on macOS, the recycle-bin API on Windows.
8. Before deleting anything irreplaceable, take a snapshot or a backup and say where it is.

Inside the checkout, after the resolved path check:

```powershell
Remove-Item -LiteralPath .\packages\server\data -Recurse -Force
bun scripts/safe-delete.ts --recursive .\packages\server\data
```

Never: `$HOME`, `C:\`, the checkout root, `.git`, a worktree root, or a target whose resolved path
escapes the checkout through `..`, a symlink or a junction.

## Shell traps by platform

### Windows: `cmd` and PowerShell

A quoted path that ends in `\` is parsed twice: once by the shell that builds the argument list, and
again by `cmd` itself. The second parse sees the backslash as escaping the closing quote, so the
path collapses and the argument becomes `\` — the root of the current drive. This is why
`cmd /c "..."` with nested quotes is not allowed here; use `Remove-Item -LiteralPath` instead.

`\` always means "root of the current drive", independent of how deep the working directory is. A
session whose cwd is on `D:` therefore turns `\` into `D:\` — the depth of the workspace offers no
protection.

In PowerShell, `-Path` expands wildcards and `-LiteralPath` does not. A filename containing `[` or `]`
is a pattern to `-Path` and a name to `-LiteralPath`; use the latter for anything derived from input.

If a `cmd` internal is genuinely required, echo the arguments first and read them:

```bat
cmd /d /s /c echo <command>
```

#### `$home` is `$HOME`

PowerShell variable names are case-insensitive. `$home` is the read-only automatic variable
`$HOME`, so `$home = Join-Path ...` fails with a **non-terminating** error. Without
`$ErrorActionPreference = 'Stop'` the script continues, `$home` still points at the user profile,
and `Remove-Item -Recurse -Force $home` deletes it. This exact shape happened in this repository:
the command removed files under `%USERPROFILE%\.bun` before it errored on a missing nested path.
Recursion inside the checkout is allowed only after the path check; that command resolved outside
it and was never legitimate.

Never use `$home`, `$profile` or an `$env:` name as scratch storage, and never combine create, run
and delete in one command. Use a named path under the checkout, fail-fast, and the helper (add
`--recursive` when the whole temporary tree may go):

```powershell
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scratch = Join-Path (Get-Location) '.scratch\locale-test'
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
# ... write and run the temporary program here ...

bun scripts/safe-delete.ts --recursive "$scratch"
```

### macOS

- `rm` is BSD `rm`: there is no `--no-preserve-root`, so `rm -rf /` is not refused by the tool. Only
  SIP and file permissions stop it, and they do not cover `/Users`.
- The default APFS volume is **case-insensitive**: `Docs` and `docs` are the same entry, so a script
  that assumes two distinct paths can delete the wrong one.
- `~` and `$HOME` expand in the calling shell, before `sudo` elevates. `sudo rm -rf ~/build` deletes
  root's home, not yours — and `sudo` will happily do it.
- `diskutil` acts on whole volumes with no undo. Read `diskutil list` before naming a device, and
  never pass a device you did not just identify.

### Linux

- `rm -rf /` needs `--no-preserve-root`, but `rm -rf /*`, `rm -rf -- $VAR` and `find / -delete` do
  not. The flag is not a guard against the shapes that actually happen.
- `find … -delete` and `find … -exec rm` print nothing and confirm nothing: a wrong `-path` filter
  deletes silently.
- Container state is easy to lose for good: `docker system prune -a`, `docker volume rm`,
  `docker compose down -v`.
- `sudo` runs a command whose expansions already happened as your user: `sudo rm -rf $DIR/*` is
  expanded unprivileged, then executed as root.
- On WSL the drive mounts under `/mnt/c` and `/mnt/d`; a Windows path is not a Unix path, and
  `rm -rf /mnt/d/...` is still a delete of the Windows volume.

## Sandbox and approval

`workspace-write` is the default sandbox. `danger-full-access` is temporary, only with the user's
explicit agreement, and reverted when the task ends. Never widen the sandbox, turn off approval, or
request an escalation to get a command through — stop and ask instead.

## After a mistake

Stop. Do not "try again to put it back": the second attempt is usually the destructive one. Report:

1. the command that was intended;
2. the command that actually ran, with its expanded arguments;
3. what was deleted or overwritten, and whether it is reversible;
4. every write already performed, so nothing overwrites recoverable data.

Then wait for instructions.
