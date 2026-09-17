/**
 * Which shell to spawn, and how to hand it a command.
 *
 * Windows has no $SHELL, so the POSIX default would spawn /bin/bash and fail
 * every session. And `-c` is a POSIX convention: PowerShell wants -Command,
 * cmd wants /c, and wsl.exe wants a shell of its own to pass it to.
 */

// Split on both separators rather than path.basename: that only treats "\\"
// as a separator when running ON Windows, so the same shell string would be
// read two different ways depending on the host. A shell's name should not.
function base(shell: string): string {
  const name = shell.split(/[\\/]/).pop() ?? shell
  return name.toLowerCase().replace(/\.exe$/, '')
}

export function defaultShell(): string {
  const override = process.env['TRING_SHELL']
  if (override) return override
  if (process.platform === 'win32') {
    // Present on every supported Windows and what developers expect. COMSPEC
    // is the fallback only if PowerShell has been removed.
    return 'powershell.exe'
  }
  return process.env['SHELL'] ?? '/bin/bash'
}

/**
 * How `shell` spells a reference to an environment variable.
 *
 * `$VAR` is POSIX, and neither of the two shells this project ships as Windows
 * defaults understands it: PowerShell wants `$env:VAR` and cmd wants `%VAR%`.
 * A command built with the wrong one does not fail loudly — it passes an empty
 * string, so an agent starts with no tools and nothing says why.
 */
export function envRef(shell: string, name: string): string {
  switch (base(shell)) {
    case 'powershell':
    case 'pwsh':
      return `$env:${name}`
    case 'cmd':
      return `%${name}%`
    // wsl.exe runs bash, so it is POSIX like the default.
    default:
      return `"$${name}"`
  }
}

/** Args that make `shell` run `command`. */
export function commandArgs(shell: string, command: string): string[] {
  switch (base(shell)) {
    case 'powershell':
    case 'pwsh':
      return ['-NoLogo', '-Command', command]
    case 'cmd':
      return ['/c', command]
    case 'wsl':
      // A Windows-native app driving WSL shells — the arrangement chosen in
      // the spec, reachable with `tring --shell wsl.exe`.
      return ['-e', 'bash', '-lc', command]
    default:
      return ['-c', command]
  }
}

/** True when `cd <path>` is the right way to move this shell. */
export function usesPosixCd(shell: string): boolean {
  const b = base(shell)
  return b !== 'cmd' && b !== 'powershell' && b !== 'pwsh'
}

/** Single-quote a path for a POSIX shell, including paths containing quotes. */
export function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/** Args for a plain interactive shell, with no command to run. */
export function interactiveArgs(shell: string): string[] {
  switch (base(shell)) {
    case 'powershell':
    case 'pwsh':
      return ['-NoLogo']
    default:
      return []
  }
}
