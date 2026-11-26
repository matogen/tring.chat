import type { Strategy, StrategyAdvice } from '@tring/shared/workflow'

/** A planner's strategy advice for test plans: complete, recommending `recommended`. */
export function advice(recommended: Strategy = 'stacked'): StrategyAdvice {
  return {
    recommended,
    factors: [
      { factor: 'coupling', note: 'the API reads the table', favours: 'stacked' },
      { factor: 'overlap', note: 'no file is owned twice', favours: null },
      { factor: 'size', note: 'about 600 lines in all', favours: null },
      { factor: 'repos', note: 'one repo', favours: null },
      { factor: 'review', note: 'two small PRs', favours: 'stacked' },
      { factor: 'shipping', note: 'the table can ship alone', favours: 'stacked' },
    ],
    means: {
      independent: 'Not without re-planning: the API needs the table.',
      stacked: 'Two PRs, the API on the table; merge bottom up.',
      single: 'One PR with two commits, table then API.',
    },
  }
}
