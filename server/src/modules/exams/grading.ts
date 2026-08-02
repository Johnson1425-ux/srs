export interface Band {
  grade: string;
  minScore: number;
  maxScore: number;
  points: number;
  remark: string | null;
}

export interface GradeOutcome {
  grade: string | null;
  points: number | null;
  remark: string | null;
}

/**
 * Maps a raw score onto a grading band. Scores are normalised to a percentage
 * first so a paper marked out of 40 grades the same as one marked out of 100.
 */
export function gradeFor(score: number, maxScore: number, bands: Band[]): GradeOutcome {
  if (maxScore <= 0) return { grade: null, points: null, remark: null };

  const percentage = (score / maxScore) * 100;
  const band = bands.find((b) => percentage >= b.minScore && percentage <= b.maxScore);

  if (!band) return { grade: null, points: null, remark: null };
  return { grade: band.grade, points: band.points, remark: band.remark };
}

export interface SubjectOutcome {
  score: number | null;
  maxScore: number;
  points: number | null;
  isAbsent: boolean;
}

export interface Aggregate {
  totalScore: number;
  totalMax: number;
  average: number;
  gpa: number | null;
  subjectsCounted: number;
}

/**
 * Aggregates a student's subject results into the totals shown on a report
 * card. Absent papers are excluded from the average rather than counted as
 * zero — a missed exam is not the same as a failed one.
 */
export function aggregate(outcomes: SubjectOutcome[]): Aggregate {
  const counted = outcomes.filter((o) => !o.isAbsent && o.score !== null);

  const totalScore = counted.reduce((acc, o) => acc + (o.score ?? 0), 0);
  const totalMax = counted.reduce((acc, o) => acc + o.maxScore, 0);
  const withPoints = counted.filter((o) => o.points !== null);

  return {
    totalScore,
    totalMax,
    average: totalMax > 0 ? Number(((totalScore / totalMax) * 100).toFixed(2)) : 0,
    gpa: withPoints.length
      ? Number(
          (withPoints.reduce((acc, o) => acc + (o.points ?? 0), 0) / withPoints.length).toFixed(2),
        )
      : null,
    subjectsCounted: counted.length,
  };
}

export interface Rankable {
  studentId: string;
  average: number;
}

/**
 * Assigns competition ranking (1, 2, 2, 4) so tied students share a position.
 */
export function rank<T extends Rankable>(rows: T[]): Array<T & { position: number }> {
  const sorted = [...rows].sort((a, b) => b.average - a.average);

  let lastAverage: number | null = null;
  let lastPosition = 0;

  return sorted.map((row, index) => {
    const position = lastAverage !== null && row.average === lastAverage ? lastPosition : index + 1;
    lastAverage = row.average;
    lastPosition = position;
    return { ...row, position };
  });
}
