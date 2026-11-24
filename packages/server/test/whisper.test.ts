import { describe, expect, it } from 'vitest'
import { cleanTranscript, recommend, vocabulary, type Hardware } from '../src/whisper.ts'

const hw = (over: Partial<Hardware> = {}): Hardware => ({
  platform: 'win32', arch: 'x64', cpu: '12th Gen Intel(R) Core(TM) i7-12700', cores: 20, ramGB: 32, gpu: null, ...over,
})

describe('recommend', () => {
  it('this PC: an RTX 3050 gets the accurate model on the GPU build', () => {
    const r = recommend(hw({ gpu: { name: 'NVIDIA GeForce RTX 3050', vramGB: 8 } }))
    expect(r.model).toBe('large-v3-turbo-q8_0')
    expect(r.build).toEqual({ name: 'whisper-bin-win-cuda-12.4.0-x64.zip', sizeMB: 701, gpu: true })
    expect(r.downloadMB).toBe(834 + 701)
    expect(r.reason).toMatch(/RTX 3050 \(8 GB\)/)
    expect(r.manual).toBeNull()
  })
  it('a small GPU, or none, is a CPU build; a strong CPU still gets the accurate model', () => {
    expect(recommend(hw({ gpu: { name: 'GT 1030', vramGB: 2 } })).build?.gpu).toBe(false)
    const r = recommend(hw())
    expect(r.model).toBe('large-v3-turbo-q5_0')
    expect(r.build?.name).toBe('whisper-blas-bin-x64.zip')
  })
  it('a modest CPU gets a smaller English model, and says what that costs', () => {
    const r = recommend(hw({ cores: 4, ramGB: 8 }))
    expect(r.model).toBe('small.en-q5_1')
    expect(r.reason).toMatch(/weaker on ticket numbers/)
    expect(recommend(hw({ cores: 2, ramGB: 4 })).model).toBe('base.en')
  })
  it('Linux gets the CPU build even with an NVIDIA GPU; macOS installs whisper.cpp itself', () => {
    expect(recommend(hw({ platform: 'linux', gpu: { name: 'RTX 4090', vramGB: 24 } })).build).toEqual({ name: 'whisper-bin-ubuntu-x64.tar.gz', sizeMB: 10, gpu: false })
    const mac = recommend(hw({ platform: 'darwin', arch: 'arm64' }))
    expect(mac.build).toBeNull()
    expect(mac.model).toBe('large-v3-turbo-q8_0')
    expect(mac.manual).toMatch(/brew install whisper-cpp/)
  })
})

describe('vocabulary', () => {
  it('puts ticket numbers first, then the developer terms, then names, once each', () => {
    expect(vocabulary(['feature/CHV-3384-hide-reports-checklist', 'tring.chat', '✳ AI-powered feature ideas', 'CHV-3384 REPORTS', 'tring.chat']))
      .toBe('Terms: CHV-3384, pull request, worktree, rebase, Claude Code, tring, orchestrator, repo, npm, feature/CHV-3384-hide-reports-checklist, tring.chat, AI-powered feature ideas, CHV-3384 REPORTS.')
  })
  it('stays short, and keeps the developer terms even when the names are many', () => {
    expect(vocabulary(Array.from({ length: 200 }, (_, i) => `branch-name-${i}`)).length).toBeLessThan(620)
    expect(vocabulary([])).toMatch(/^Terms: pull request, /)
  })
})

describe('cleanTranscript', () => {
  it('drops what Whisper writes for silence and noise', () => {
    expect(cleanTranscript(' [BLANK_AUDIO] ')).toBe('')
    expect(cleanTranscript('Move CHV-3384 to testing. (silence)')).toBe('Move CHV-3384 to testing.')
  })
})
