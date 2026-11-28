import { readFile } from 'node:fs/promises'
import { DEFAULT_WORKFLOW, mergeWorkflow, type WorkflowSettings } from '@tring/shared/workflow'
import { writeAtomic } from '../card-store.ts'

/**
 * Settings → Workflow, kept in `~/.config/tring/workflow.json`.
 *
 * In the daemon rather than the browser (unlike the ring size) because what
 * reads it — the orchestrator's tools and the stack engine — runs here, and
 * every device must agree on whether the workflow is on.
 */
export class WorkflowSettingsStore {
  private current: WorkflowSettings = { ...DEFAULT_WORKFLOW }
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  /** What was saved, checked field by field; the defaults on a first run. */
  async load(): Promise<void> {
    let raw: unknown = null
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      // No file yet, or not JSON: the defaults.
    }
    this.current = mergeWorkflow({ ...DEFAULT_WORKFLOW }, raw)
  }

  get(): WorkflowSettings {
    return { ...this.current }
  }

  /** Applies what `patch` names validly, saves, and returns the result. */
  async update(patch: unknown): Promise<WorkflowSettings> {
    this.current = mergeWorkflow(this.current, patch)
    const text = JSON.stringify(this.current, null, 2) + '\n'
    // Chained, so two quick changes cannot land out of order.
    this.writing = this.writing.then(() => writeAtomic(this.file, text)).catch(() => {})
    await this.writing
    return this.get()
  }
}
