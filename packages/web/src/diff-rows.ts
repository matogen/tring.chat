/** One rendered line of a file's diff. */
export type Row =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; old: number | null; new: number | null; text: string }

/** Unified hunks into rows carrying old and new line numbers. */
export function patchRows(patch: string): Row[] {
  const rows: Row[] = []
  let o = 0
  let n = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      // A new file's hunk says `-0,0 +1,n`: there is no old line 0 to count
      // from, and the first new line is 1, which is what `n` already holds.
      inHunk = true
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) rows.push({ kind: 'add', old: null, new: n++, text: line.slice(1) })
    else if (line.startsWith('-')) rows.push({ kind: 'del', old: o++, new: null, text: line.slice(1) })
    else if (line.startsWith(' ')) rows.push({ kind: 'ctx', old: o++, new: n++, text: line.slice(1) })
    // `\ No newline at end of file` and blank trailers carry no content.
  }
  return rows
}

export const MIN_WIDTH = 240

/** Panel width in px: at most 75% of the focus cell, never under MIN_WIDTH. */
export function clampWidth(px: number, cellWidth: number): number {
  return Math.round(Math.max(MIN_WIDTH, Math.min(px, cellWidth * 0.75)))
}
