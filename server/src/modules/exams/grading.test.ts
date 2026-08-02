import { describe, expect, it } from 'vitest';
import { type Band, aggregate, gradeFor, rank } from './grading.js';

const bands: Band[] = [
  { grade: 'A', minScore: 75, maxScore: 100, points: 5, remark: 'Excellent' },
  { grade: 'B', minScore: 65, maxScore: 74.99, points: 4, remark: 'Very Good' },
  { grade: 'C', minScore: 45, maxScore: 64.99, points: 3, remark: 'Good' },
  { grade: 'D', minScore: 30, maxScore: 44.99, points: 2, remark: 'Pass' },
  { grade: 'F', minScore: 0, maxScore: 29.99, points: 1, remark: 'Fail' },
];

describe('gradeFor', () => {
  it('maps a score onto the matching band', () => {
    expect(gradeFor(80, 100, bands)).toEqual({ grade: 'A', points: 5, remark: 'Excellent' });
    expect(gradeFor(46, 100, bands)).toEqual({ grade: 'C', points: 3, remark: 'Good' });
    expect(gradeFor(0, 100, bands)).toEqual({ grade: 'F', points: 1, remark: 'Fail' });
  });

  it('normalises to a percentage so papers out of 40 grade the same', () => {
    // 32/40 is 80% — an A, even though the raw score would fall in the D band.
    expect(gradeFor(32, 40, bands).grade).toBe('A');
  });

  it('handles band boundaries inclusively', () => {
    expect(gradeFor(75, 100, bands).grade).toBe('A');
    expect(gradeFor(74.99, 100, bands).grade).toBe('B');
  });

  it('returns nulls when the paper has no marks available', () => {
    expect(gradeFor(10, 0, bands)).toEqual({ grade: null, points: null, remark: null });
  });
});

describe('aggregate', () => {
  it('totals scores and averages as a percentage', () => {
    const result = aggregate([
      { score: 80, maxScore: 100, points: 5, isAbsent: false },
      { score: 60, maxScore: 100, points: 3, isAbsent: false },
    ]);

    expect(result.totalScore).toBe(140);
    expect(result.totalMax).toBe(200);
    expect(result.average).toBe(70);
    expect(result.gpa).toBe(4);
    expect(result.subjectsCounted).toBe(2);
  });

  it('excludes absent papers instead of scoring them zero', () => {
    const result = aggregate([
      { score: 80, maxScore: 100, points: 5, isAbsent: false },
      { score: null, maxScore: 100, points: null, isAbsent: true },
    ]);

    expect(result.average).toBe(80);
    expect(result.subjectsCounted).toBe(1);
  });

  it('reports a zero average when nothing was sat', () => {
    const result = aggregate([{ score: null, maxScore: 100, points: null, isAbsent: true }]);
    expect(result.average).toBe(0);
    expect(result.gpa).toBeNull();
  });
});

describe('rank', () => {
  it('orders by average, highest first', () => {
    const ranked = rank([
      { studentId: 'a', average: 55 },
      { studentId: 'b', average: 91 },
      { studentId: 'c', average: 72 },
    ]);

    expect(ranked.map((r) => r.studentId)).toEqual(['b', 'c', 'a']);
    expect(ranked.map((r) => r.position)).toEqual([1, 2, 3]);
  });

  it('gives tied students the same position and skips the next one', () => {
    const ranked = rank([
      { studentId: 'a', average: 80 },
      { studentId: 'b', average: 80 },
      { studentId: 'c', average: 70 },
    ]);

    expect(ranked.map((r) => r.position)).toEqual([1, 1, 3]);
  });
});
