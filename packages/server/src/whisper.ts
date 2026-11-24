import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

/**
 * Local speech recognition for the desktop microphone: whisper.cpp running on
 * this machine, so the audio never leaves it.
 *
 * Optional. The browser's own speech recognition is the default; this is
 * installed from Settings, which shows the model recommended for this PC's
 * hardware first. Everything it downloads is checked against the checksum
 * its publisher gives — GitHub's digest for whisper.cpp's prebuilt binaries,
 * Hugging Face's LFS hash for the models — before it is used.
 *
 * whisper.cpp's own `whisper-server` does the work: started on loopback on
 * first use, kept while it is being used, stopped after a quiet spell so the
 * model is not holding the GPU for nothing.
 */

const run = promisify(execFile)

export interface Hardware {
  platform: NodeJS.Platform
  arch: string
  cpu: string
  /** Logical cores: what whisper.cpp's threads run on. */
  cores: number
  ramGB: number
  gpu: { name: string; vramGB: number } | null
}

export async function detectHardware(): Promise<Hardware> {
  let gpu: Hardware['gpu'] = null
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 5000, encoding: 'utf8' })
    const [name, mib] = (stdout.trim().split(/\r?\n/)[0] ?? '').split(',').map((s) => s.trim())
    if (name) gpu = { name, vramGB: Math.round(Number(mib) / 1024) }
  } catch {
    // No NVIDIA GPU, or no driver: the CPU builds it is.
  }
  const cpus = os.cpus()
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus[0]?.model.trim() ?? 'CPU',
    cores: cpus.length,
    ramGB: Math.round(os.totalmem() / 2 ** 30),
    gpu,
  }
}

export const MODELS = {
  'large-v3-turbo-q8_0': { file: 'ggml-large-v3-turbo-q8_0.bin', sizeMB: 834, label: 'large-v3-turbo (8-bit)' },
  'large-v3-turbo-q5_0': { file: 'ggml-large-v3-turbo-q5_0.bin', sizeMB: 547, label: 'large-v3-turbo (5-bit)' },
  'small.en-q5_1': { file: 'ggml-small.en-q5_1.bin', sizeMB: 181, label: 'small.en (5-bit)' },
  'base.en': { file: 'ggml-base.en.bin', sizeMB: 141, label: 'base.en' },
} as const
export type ModelId = keyof typeof MODELS
export const isModel = (v: unknown): v is ModelId => typeof v === 'string' && v in MODELS

export interface Build {
  /** The release asset's name on GitHub. */
  name: string
  sizeMB: number
  gpu: boolean
}

export interface Recommendation {
  model: ModelId
  modelLabel: string
  modelMB: number
  /** whisper.cpp's prebuilt binary for this machine, or null where there is none (macOS). */
  build: Build | null
  /** What there is to download, all told. */
  downloadMB: number
  /** Why this model, for this machine, in a sentence. */
  reason: string
  /** How long a sentence takes, roughly. */
  speed: string
  /** What the user must do first, where tring cannot install the program itself. */
  manual: string | null
}

/**
 * The model and build for this machine. The large-v3-turbo models are the
 * accurate ones on technical words (and take a vocabulary hint); on an NVIDIA
 * GPU they are fast too. A CPU-only machine gets them only if it is strong;
 * otherwise a smaller English model, quicker but weaker on jargon.
 */
export function recommend(hw: Hardware): Recommendation {
  const winX64 = hw.platform === 'win32' && hw.arch === 'x64'
  // whisper.cpp only ships GPU builds for Windows; elsewhere the CPU ones.
  const gpu = !!hw.gpu && hw.gpu.vramGB >= 4 && winX64
  const build: Build | null = hw.platform === 'win32'
    ? hw.arch === 'arm64' ? { name: 'whisper-bin-win-cpu-arm64.zip', sizeMB: 4, gpu: false }
      : gpu ? { name: 'whisper-bin-win-cuda-12.4.0-x64.zip', sizeMB: 701, gpu: true }
      : { name: 'whisper-blas-bin-x64.zip', sizeMB: 21, gpu: false }
    : hw.platform === 'linux' ? { name: hw.arch === 'arm64' ? 'whisper-bin-ubuntu-arm64.tar.gz' : 'whisper-bin-ubuntu-x64.tar.gz', sizeMB: 10, gpu: false }
    : null
  const appleSilicon = hw.platform === 'darwin' && hw.arch === 'arm64'
  const strong = hw.cores >= 8 && hw.ramGB >= 16

  let model: ModelId
  let reason: string
  let speed: string
  if (gpu) {
    model = 'large-v3-turbo-q8_0'
    reason = `Your ${hw.gpu!.name} (${hw.gpu!.vramGB} GB) runs the most accurate of these models on its GPU.`
    speed = 'about a second for a sentence'
  } else if (appleSilicon) {
    model = 'large-v3-turbo-q8_0'
    reason = 'Apple Silicon runs the most accurate of these models on its GPU (Metal).'
    speed = 'about a second for a sentence'
  } else if (strong) {
    model = 'large-v3-turbo-q5_0'
    reason = `No GPU to use, but your ${hw.cpu} (${hw.cores} threads, ${hw.ramGB} GB) runs the accurate model on the CPU.`
    speed = 'a few seconds for a sentence'
  } else if (hw.cores >= 4) {
    model = 'small.en-q5_1'
    reason = 'A smaller English model keeps this CPU quick; it is weaker on ticket numbers and code terms.'
    speed = 'a second or two for a sentence'
  } else {
    model = 'base.en'
    reason = 'The smallest English model, for a modest CPU; noticeably weaker on technical words.'
    speed = 'a second or two for a sentence'
  }
  const m = MODELS[model]
  return {
    model,
    modelLabel: m.label,
    modelMB: m.sizeMB,
    build,
    downloadMB: m.sizeMB + (build?.sizeMB ?? 0),
    reason,
    speed,
    manual: build ? null : 'Install whisper.cpp first (on a Mac: brew install whisper-cpp); tring then downloads the model and uses its whisper-server.',
  }
}

/**
 * Words for Whisper to expect, from what tring knows: ticket numbers,
 * branches, projects and tile names. Whisper reads a prompt as the text that
 * came before, so the right spellings in it ("CHV-3384", "worktree") are the
 * ones it then writes.
 */
/** Words a coding agent is asked about all day, which a general model mishears. */
export const DEV_TERMS = ['pull request', 'worktree', 'rebase', 'Claude Code', 'tring', 'orchestrator', 'repo', 'npm']

export function vocabulary(names: string[], limit = 600): string {
  const terms: string[] = []
  const add = (t: string): void => {
    const s = t.trim()
    if (s.length < 3 || s.length > 60 || terms.some((x) => x.toLowerCase() === s.toLowerCase())) return
    terms.push(s)
  }
  // Ticket numbers first: they are what dictation gets wrong most. Then the
  // words every request to an agent leans on ("pool request", heard live),
  // then tring's own names, cut short before any of those are.
  for (const n of names) for (const m of n.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g)) add(m[0])
  for (const t of DEV_TERMS) add(t)
  for (const n of names) add(n.replace(/^[✳*·•\s]+/, ''))
  let out = ''
  for (const t of terms) {
    const next = out ? `${out}, ${t}` : t
    if (next.length > limit) break
    out = next
  }
  return out ? `Terms: ${out}.` : ''
}

/** What Whisper writes for silence and noise, which is no text at all. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE)\]|\((silence|music|noise|inaudible|blank audio)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface WhisperStatus {
  hardware: Hardware
  recommendation: Recommendation
  /** The model and the whisper.cpp program are both here. */
  installed: boolean
  enabled: boolean
  model: ModelId | null
  installing: { step: string; doneMB: number; totalMB: number } | null
  error: string | null
}

interface Saved {
  enabled?: boolean
  model?: string
}

/** How long whisper-server stays up with nothing to do. */
const IDLE_MS = 10 * 60_000
const RELEASES = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15'
const MODEL_TREE = 'https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main'
const MODEL_URL = (file: string): string => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`

export class Whisper {
  private saved: Saved = {}
  private hw: Hardware | null = null
  private installing: WhisperStatus['installing'] = null
  private error: string | null = null
  private proc: ChildProcess | null = null
  private port = 0
  private starting: Promise<number> | null = null
  private idle: NodeJS.Timeout | null = null

  constructor(private readonly dir: string, private readonly statePath: string) {}

  async load(): Promise<void> {
    try { this.saved = JSON.parse(await readFile(this.statePath, 'utf8')) as Saved } catch { this.saved = {} }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true })
    await writeFile(this.statePath, JSON.stringify(this.saved, null, 2) + '\n', 'utf8')
  }

  private model(): ModelId | null {
    return isModel(this.saved.model) ? this.saved.model : null
  }

  private modelPath(m: ModelId): string {
    return path.join(this.dir, 'models', MODELS[m].file)
  }

  /** whisper-server from the install, or from PATH (a Mac's brew install). */
  private async serverBinary(): Promise<string | null> {
    const exe = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
    const found = await findFile(path.join(this.dir, 'bin'), exe)
    if (found) return found
    try {
      const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', ['whisper-server'], { timeout: 3000, encoding: 'utf8' })
      return stdout.trim().split(/\r?\n/)[0] || null
    } catch {
      return null
    }
  }

  async status(): Promise<WhisperStatus> {
    this.hw ??= await detectHardware()
    const model = this.model()
    const installed = !!model && existsSync(this.modelPath(model)) && (await this.serverBinary()) !== null
    return {
      hardware: this.hw,
      recommendation: recommend(this.hw),
      installed,
      enabled: installed && this.saved.enabled === true,
      model,
      installing: this.installing,
      error: this.error,
    }
  }

  /** Starts installing in the background; status() reports progress. False if one is running. */
  install(model?: ModelId): boolean {
    if (this.installing) return false
    this.error = null
    this.installing = { step: 'starting', doneMB: 0, totalMB: 0 }
    void this.doInstall(model).catch((err: Error) => {
      this.error = err.message
    }).finally(() => {
      this.installing = null
    })
    return true
  }

  private async doInstall(chosen?: ModelId): Promise<void> {
    this.hw ??= await detectHardware()
    const rec = recommend(this.hw)
    const model = chosen ?? rec.model
    const tmp = path.join(this.dir, 'tmp')
    await mkdir(tmp, { recursive: true })

    if (!(await this.serverBinary())) {
      if (!rec.build) throw new Error(rec.manual ?? 'no whisper.cpp build for this machine')
      const asset = await findAsset(rec.build.name)
      const file = path.join(tmp, asset.name)
      await this.download(asset.url, file, `Downloading whisper.cpp (${asset.name})`, asset.digest)
      const bin = path.join(this.dir, 'bin')
      await rm(bin, { recursive: true, force: true })
      await mkdir(bin, { recursive: true })
      this.installing = { step: 'Unpacking whisper.cpp', doneMB: 0, totalMB: 0 }
      await extract(file, bin)
      await rm(file, { force: true })
      if (!(await this.serverBinary())) throw new Error('whisper-server was not in the download')
    }

    const target = this.modelPath(model)
    if (!existsSync(target)) {
      const sha = await modelHash(MODELS[model].file)
      const part = `${target}.part`
      await mkdir(path.dirname(target), { recursive: true })
      await this.download(MODEL_URL(MODELS[model].file), part, `Downloading the ${MODELS[model].label} model`, sha)
      await rename(part, target)
    }
    this.stopServer()
    this.saved = { enabled: true, model }
    await this.save()
  }

  /** Streams `url` to `file`, counting progress, and refuses it if its SHA-256 is not `sha256`. */
  private async download(url: string, file: string, step: string, sha256: string | null): Promise<void> {
    // A program to run and a model to load are only taken with their checksum.
    if (!sha256) throw new Error(`${step}: its publisher gave no checksum to check it against, so it was not downloaded`)
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'tring' } })
    if (!res.ok || !res.body) throw new Error(`${step} failed: HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? 0)
    this.installing = { step, doneMB: 0, totalMB: Math.round(total / 2 ** 20) }
    const hash = createHash('sha256')
    let done = 0
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (c: Buffer) => {
      hash.update(c)
      done += c.length
      if (this.installing) this.installing.doneMB = Math.round(done / 2 ** 20)
    })
    await pipeline(body, createWriteStream(file))
    const got = hash.digest('hex')
    if (got !== sha256) {
      await rm(file, { force: true })
      throw new Error(`${step}: the download did not match its published checksum, so it was not used`)
    }
  }

  async setEnabled(on: boolean): Promise<void> {
    this.saved.enabled = on
    if (!on) this.stopServer()
    await this.save()
  }

  /** 16 kHz mono WAV in, text out. */
  async transcribe(wav: Buffer, prompt: string): Promise<string> {
    const port = await this.ensureServer()
    this.touch()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav')
    form.append('response_format', 'json')
    form.append('temperature', '0')
    if (prompt) form.append('prompt', prompt)
    const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) })
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
    if (!res.ok || body.error) throw new Error(body.error ?? `whisper-server answered ${res.status}`)
    this.touch()
    return cleanTranscript(body.text ?? '')
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stopServer(), IDLE_MS)
    this.idle.unref?.()
  }

  private ensureServer(): Promise<number> {
    if (this.proc && this.port) return Promise.resolve(this.port)
    this.starting ??= this.startServer().finally(() => { this.starting = null })
    return this.starting
  }

  private async startServer(): Promise<number> {
    const model = this.model()
    if (!model || !existsSync(this.modelPath(model))) throw new Error('local Whisper is not installed')
    const bin = await this.serverBinary()
    if (!bin) throw new Error('whisper-server is missing; install local Whisper again from Settings')
    const port = await freePort()
    const threads = Math.max(2, Math.min(8, (this.hw?.cores ?? 4) - 2))
    const proc = spawn(bin, ['-m', this.modelPath(model), '--host', '127.0.0.1', '--port', String(port), '-l', 'en', '-t', String(threads)], {
      cwd: path.dirname(bin), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let log = ''
    const keep = (c: Buffer): void => { log = (log + c.toString()).slice(-2000) }
    proc.stdout?.on('data', keep)
    proc.stderr?.on('data', keep)
    let exited = false
    proc.on('exit', () => {
      exited = true
      if (this.proc === proc) { this.proc = null; this.port = 0 }
    })
    // Loading a model onto the GPU takes a few seconds; on a CPU, longer.
    for (let i = 0; i < 240; i++) {
      if (exited) throw new Error(`whisper-server stopped while starting: ${log.trim().split(/\r?\n/).slice(-2).join(' ')}`)
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
        if (r.status < 500) {
          this.proc = proc
          this.port = port
          return port
        }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 250))
    }
    proc.kill()
    throw new Error('whisper-server did not start within a minute')
  }

  stopServer(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    this.proc?.kill()
    this.proc = null
    this.port = 0
  }
}

async function findFile(dir: string, name: string): Promise<string | null> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return path.join(dir, e.name)
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const found = await findFile(path.join(dir, e.name), name)
    if (found) return found
  }
  return null
}

/** The newest release that carries `name` (whisper.cpp attaches binaries to its build tags). */
async function findAsset(name: string): Promise<{ name: string; url: string; digest: string | null }> {
  const res = await fetch(RELEASES, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'tring' } })
  if (!res.ok) throw new Error(`cannot list whisper.cpp releases: HTTP ${res.status}`)
  const releases = (await res.json()) as Array<{ assets?: Array<{ name: string; browser_download_url: string; digest?: string }> }>
  for (const r of releases) {
    const a = r.assets?.find((x) => x.name === name)
    if (a) return { name: a.name, url: a.browser_download_url, digest: a.digest?.startsWith('sha256:') ? a.digest.slice(7) : null }
  }
  throw new Error(`no whisper.cpp release has ${name}`)
}

/** The model's SHA-256 as Hugging Face publishes it (its LFS object id). */
async function modelHash(file: string): Promise<string | null> {
  try {
    const res = await fetch(MODEL_TREE, { headers: { 'user-agent': 'tring' } })
    const tree = (await res.json()) as Array<{ path: string; lfs?: { oid?: string } }>
    return tree.find((f) => f.path === file)?.lfs?.oid ?? null
  } catch {
    return null
  }
}

/** Unpacks a release archive with the system's tar (bsdtar on Windows reads zip too). */
async function extract(archive: string, into: string): Promise<void> {
  const tar = process.platform === 'win32' ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const args = archive.endsWith('.tar.gz') ? ['-xzf', archive, '-C', into] : ['-xf', archive, '-C', into]
  await run(tar, args, { timeout: 300_000 })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}
