import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { HealthScore, computeHealthScore, getHealthGrade } from './HealthScore';

type Inputs = { collateral: bigint; required: bigint; reserve: bigint };

function render(inputs: Inputs): string {
  return renderToStaticMarkup(<HealthScore {...inputs} />);
}

// React may separate adjacent text nodes with <!-- --> in server output.
const SEP = '(?:<!-- -->)?\\s*';

function scoreText(html: string): string {
  const m = html.match(/<p aria-live="polite" class="[^"]*">([^<]*)<\/p>/);
  assert.ok(m, 'score paragraph not found');
  return m[1];
}

function gradeEl(html: string): { text: string; className: string } {
  const m = html.match(/<p class="([^"]*min-w-20[^"]*)">([^<]*)<\/p>/);
  assert.ok(m, 'grade paragraph not found');
  return { className: m[1], text: m[2] };
}

function ratioText(html: string, label: 'Coverage' | 'Reserve'): string {
  const re = new RegExp(`${label} \\((?:70|30)% weight\\):${SEP}<span[^>]*>([^<]*)</span>`);
  const m = html.match(re);
  assert.ok(m, `${label} ratio not found`);
  return m[1];
}

function contributionText(html: string, label: 'Coverage' | 'Reserve'): string {
  const re = new RegExp(`<span>${label} Contribution</span><span[^>]*>([^<]*?)${SEP}pts</span>`);
  const m = html.match(re);
  assert.ok(m, `${label} contribution not found`);
  return m[1].trim();
}

function progressBar(html: string): { className: string; width: string } {
  const m = html.match(/<div class="(h-full transition-all[^"]*)" style="width:\s*([^;"]+);?"><\/div>/);
  assert.ok(m, 'progress bar not found');
  return { className: m[1].replace(/\s+/g, ' ').trim(), width: m[2] };
}

function hasClasses(className: string, ...classes: string[]): void {
  const tokens = className.split(/\s+/);
  for (const c of classes) assert.ok(tokens.includes(c), `expected class "${c}" in "${className}"`);
}

describe('Issue #653 - HealthScore Good grade boundaries (60 and 79)', () => {
  // coverage 60 -> 42 pts, reserve 60 -> 18 pts
  const at60: Inputs = { collateral: 60n, required: 100n, reserve: 36n };
  // coverage 100 -> 70 pts, reserve 30 -> 9 pts
  const at79: Inputs = { collateral: 100n, required: 100n, reserve: 30n };

  it('fixtures produce exactly 60 and 79', () => {
    assert.equal(computeHealthScore(at60.collateral, at60.required, at60.reserve).healthScore, 60);
    assert.equal(computeHealthScore(at79.collateral, at79.required, at79.reserve).healthScore, 79);
  });

  for (const [score, inputs] of [
    [60, at60],
    [79, at79],
  ] as const) {
    it(`renders "Good" with accent classes at ${score}`, () => {
      const html = render(inputs);
      assert.equal(scoreText(html), String(score));
      const grade = gradeEl(html);
      assert.equal(grade.text, 'Good');
      assert.notEqual(grade.text, 'Excellent');
      hasClasses(grade.className, 'text-accent', 'bg-accent/10');
    });

    it(`progress bar fills to ${score}% at ${score}`, () => {
      const bar = progressBar(render(inputs));
      assert.equal(bar.width, `${score}%`);
      // The bar colour follows the alert thresholds (default warning 60), not the grade.
      hasClasses(bar.className, 'bg-success');
    });
  }

  it('grade helper flips to Excellent at 80 and Fair at 59', () => {
    assert.equal(getHealthGrade(80).grade, 'excellent');
    assert.equal(getHealthGrade(79).grade, 'good');
    assert.equal(getHealthGrade(60).grade, 'good');
    assert.equal(getHealthGrade(59).grade, 'fair');
    assert.equal(getHealthGrade(60).gradeColor, 'text-accent bg-accent/10');
    assert.equal(getHealthGrade(79).gradeColor, 'text-accent bg-accent/10');
  });
});

describe('Issue #654 - HealthScore Fair (40-59) and Poor (<40) boundaries', () => {
  // coverage 40 -> 28 pts, reserve 40 -> 12 pts
  const at40: Inputs = { collateral: 40n, required: 100n, reserve: 16n };
  // coverage 30 -> 21 pts, reserve 60 -> 18 pts
  const at39: Inputs = { collateral: 30n, required: 100n, reserve: 18n };
  const floor: Inputs = { collateral: 0n, required: 100n, reserve: 0n };

  it('fixtures produce exactly 40, 39 and 0', () => {
    assert.equal(computeHealthScore(at40.collateral, at40.required, at40.reserve).healthScore, 40);
    assert.equal(computeHealthScore(at39.collateral, at39.required, at39.reserve).healthScore, 39);
    assert.equal(computeHealthScore(floor.collateral, floor.required, floor.reserve).healthScore, 0);
  });

  it('renders "Fair" with yellow-500 classes at 40', () => {
    const html = render(at40);
    assert.equal(scoreText(html), '40');
    const grade = gradeEl(html);
    assert.equal(grade.text, 'Fair');
    hasClasses(grade.className, 'text-yellow-500', 'bg-yellow-500/10');
  });

  it('renders "Poor" with danger classes at 39', () => {
    const html = render(at39);
    assert.equal(scoreText(html), '39');
    const grade = gradeEl(html);
    assert.equal(grade.text, 'Poor');
    hasClasses(grade.className, 'text-danger', 'bg-danger/10');
  });

  it('renders 0 / Poor with a 0% progress bar in the floor case', () => {
    const html = render(floor);
    assert.equal(scoreText(html), '0');
    const grade = gradeEl(html);
    assert.equal(grade.text, 'Poor');
    hasClasses(grade.className, 'text-danger', 'bg-danger/10');
    const bar = progressBar(html);
    assert.equal(bar.width, '0%');
    hasClasses(bar.className, 'bg-danger');
    assert.ok(!html.includes('NaN'));
  });
});

describe('Issue #655 - HealthScore treats zero required collateral as 100% coverage', () => {
  it('coverageRatio is 100 and contributes the full 70 points', () => {
    const r = computeHealthScore(50n, 0n, 0n);
    assert.equal(r.coverageRatio, 100);
    assert.equal(r.coverageScore, 100);
    assert.equal(r.coverageScore * 0.7, 70);
    assert.equal(r.healthScore, 70);
  });

  it('does not divide by zero when collateral is also 0n', () => {
    assert.doesNotThrow(() => computeHealthScore(0n, 0n, 0n));
    const r = computeHealthScore(0n, 0n, 0n);
    assert.equal(r.coverageRatio, 100);
    assert.equal(r.reserveRatio, 0);
    assert.equal(r.healthScore, 70);
    assert.ok(Number.isFinite(r.healthScore));
  });

  for (const inputs of [
    { collateral: 0n, required: 0n, reserve: 0n },
    { collateral: 50n, required: 0n, reserve: 10n },
    { collateral: 100n, required: 0n, reserve: 100n },
  ]) {
    it(`renders Coverage 100% and 70.0 pts (collateral=${inputs.collateral}, reserve=${inputs.reserve})`, () => {
      let html = '';
      assert.doesNotThrow(() => {
        html = render(inputs);
      });
      assert.equal(ratioText(html, 'Coverage'), '100%');
      assert.equal(contributionText(html, 'Coverage'), '70.0');
      assert.ok(!html.includes('NaN'));
      assert.ok(!html.includes('Infinity'));
    });
  }

  it('reaches 100 when reserve is also full', () => {
    const html = render({ collateral: 100n, required: 0n, reserve: 100n });
    assert.equal(scoreText(html), '100');
    assert.equal(gradeEl(html).text, 'Excellent');
  });
});

describe('Issue #656 - HealthScore reserveRatio is 0 when collateral is zero', () => {
  const badState: Inputs = { collateral: 0n, required: 100n, reserve: 50n };

  it('reserveRatio and reserveScore are 0, not NaN', () => {
    const r = computeHealthScore(badState.collateral, badState.required, badState.reserve);
    assert.equal(r.reserveRatio, 0);
    assert.equal(r.reserveScore, 0);
    assert.ok(!Number.isNaN(r.reserveScore));
    assert.equal(r.reserveScore * 0.3, 0);
    assert.equal(r.healthScore, 0);
    assert.ok(Number.isFinite(r.healthScore));
  });

  it('reserveScore adds nothing on top of coverage', () => {
    // collateral 0 against required 100 => coverage 0, so the composite is exactly 0.
    const withReserve = computeHealthScore(0n, 100n, 1_000_000n);
    const withoutReserve = computeHealthScore(0n, 100n, 0n);
    assert.equal(withReserve.healthScore, withoutReserve.healthScore);
  });

  it('renders without throwing and shows Reserve 0%', () => {
    let html = '';
    assert.doesNotThrow(() => {
      html = render(badState);
    });
    assert.equal(ratioText(html, 'Reserve'), '0%');
    assert.equal(contributionText(html, 'Reserve'), '0.0');
    assert.equal(scoreText(html), '0');
    assert.equal(gradeEl(html).text, 'Poor');
    assert.ok(!html.includes('NaN'));
  });

  it('a nonzero reserve still counts normally once collateral exists', () => {
    const r = computeHealthScore(100n, 100n, 50n);
    assert.equal(r.reserveRatio, 50);
    assert.equal(r.healthScore, 85);
  });
});
