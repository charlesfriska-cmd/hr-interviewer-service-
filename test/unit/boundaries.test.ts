import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Architectural boundaries, enforced as a failing test rather than a convention.
 * These are the rules the specification states as "never"; a lint config can be
 * bypassed with an inline disable, a red build cannot be ignored as easily.
 */
const sources = globSync('src/**/*.ts');

const readAll = (paths: string[]) => paths.map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));

describe('provider SDK isolation', () => {
  it('is imported only inside the Claude adapter', () => {
    const offenders = readAll(sources)
      .filter((f) => /from '@anthropic-ai\/sdk'|require\('@anthropic-ai\/sdk'\)/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual(['src/llm/providers/claude/ClaudeProvider.ts']);
  });

  it('keeps the SDK out of domain, application, persistence and api layers', () => {
    const layered = sources.filter((p) =>
      /^src\/(domain|application|persistence|api)\//.test(p),
    );
    for (const f of readAll(layered)) {
      expect(f.text, f.path).not.toContain('@anthropic-ai/sdk');
    }
  });
});

describe('layer dependency direction', () => {
  it('keeps the domain free of I/O and framework imports', () => {
    const banned = ['@anthropic-ai/sdk', "from 'pg'", "from 'express'", "from 'ajv'"];
    for (const f of readAll(sources.filter((p) => p.startsWith('src/domain/')))) {
      for (const b of banned) expect(f.text, `${f.path} imports ${b}`).not.toContain(b);
    }
  });

  it('keeps pg and express out of the application layer', () => {
    for (const f of readAll(sources.filter((p) => p.startsWith('src/application/')))) {
      expect(f.text, f.path).not.toContain("from 'express'");
      // FinalizeInterviewService uses a pg.Pool type only; it must not construct one.
      expect(f.text, f.path).not.toContain('new pg.Pool');
    }
  });

  it('keeps the competency track from importing requirement-side scoring (C5)', () => {
    // The two tracks are computed independently and never numerically merged.
    // Only recommendation.ts may see both, and it consumes the requirement side
    // purely as a cap. Matches import statements, not prose in comments.
    const competency = readFileSync('src/domain/scoring/competencyTrack.ts', 'utf8');
    const imports = [...competency.matchAll(/^import .*?from '(.+?)';$/gm)].map((m) => m[1]!);
    expect(imports.some((i) => /requirementFit|gates/.test(i))).toBe(false);
  });
});

describe('composition root is the only provider selection point', () => {
  it('names concrete providers nowhere else', () => {
    const offenders = readAll(sources)
      .filter((f) => /new ClaudeProvider\(|new MockHRInterviewerProvider\(/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !p.startsWith('src/composition/') && !p.startsWith('src/llm/providers/'));
    expect(offenders).toEqual([]);
  });
});
