import { describe, expect, it } from 'vitest';
import {
  computeTurnActiveSeconds,
  isSessionIdleExpired,
  isTimeExhausted,
  phaseBudgetStatus,
  remainingTimeMinutes,
} from '../../src/domain/time/activeTime.ts';

const at = (iso: string) => new Date(iso);

describe('active interview time (B4, INTERVIEW_STATE v3 §4b)', () => {
  it('counts genuine answering time below the clamp', () => {
    expect(
      computeTurnActiveSeconds({
        presentedAt: at('2026-01-01T10:00:00Z'),
        receivedAt: at('2026-01-01T10:02:00Z'),
        maxCandidateResponseWindowSeconds: 600,
      }),
    ).toBe(120);
  });

  it('clamps an idle tab so it cannot launder idle time into active time', () => {
    // 45 minutes elapsed on one question, clamp is 10 minutes.
    expect(
      computeTurnActiveSeconds({
        presentedAt: at('2026-01-01T10:00:00Z'),
        receivedAt: at('2026-01-01T10:45:00Z'),
        maxCandidateResponseWindowSeconds: 600,
      }),
    ).toBe(600);
  });

  it('floors a negative interval rather than crediting budget back', () => {
    expect(
      computeTurnActiveSeconds({
        presentedAt: at('2026-01-01T10:05:00Z'),
        receivedAt: at('2026-01-01T10:00:00Z'),
        maxCandidateResponseWindowSeconds: 600,
      }),
    ).toBe(0);
  });

  it('derives remainingTimeMinutes from active time, never below zero', () => {
    expect(remainingTimeMinutes(600, 50)).toBe(40);
    expect(remainingTimeMinutes(6000, 50)).toBe(0);
  });

  it('fires TIME_EXHAUSTED on active seconds, not wall clock', () => {
    expect(isTimeExhausted(50 * 60 - 1, 50)).toBe(false);
    expect(isTimeExhausted(50 * 60, 50)).toBe(true);
  });
});

describe('session idle time is a separate clock (B4)', () => {
  it('expires an idle session independently of remaining budget', () => {
    expect(
      isSessionIdleExpired(at('2026-01-01T14:00:00Z'), at('2026-01-01T10:00:00Z'), 120),
    ).toBe(true);
  });

  it('does not expire a session inside the idle window', () => {
    expect(
      isSessionIdleExpired(at('2026-01-01T11:00:00Z'), at('2026-01-01T10:00:00Z'), 120),
    ).toBe(false);
  });

  it('a session can be idle-expired while well within its active budget', () => {
    // Only 2 minutes of active time spent, but idle for 4 hours.
    expect(isTimeExhausted(120, 50)).toBe(false);
    expect(
      isSessionIdleExpired(at('2026-01-01T14:00:00Z'), at('2026-01-01T10:00:00Z'), 120),
    ).toBe(true);
  });
});

describe('phase soft budget is advisory only (C15)', () => {
  it('reports OVER_BUDGET past the phase share without forcing anything', () => {
    // OPENING share 0.10 of 50 min = 300s.
    expect(phaseBudgetStatus(301, 0.1, 50)).toBe('OVER_BUDGET');
    expect(phaseBudgetStatus(299, 0.1, 50)).toBe('ON_TRACK');
  });
});
