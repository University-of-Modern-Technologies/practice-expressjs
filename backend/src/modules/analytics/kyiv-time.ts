/**
 * The calendar every report is cut on: Kyiv's, not UTC's.
 *
 * The people reading these reports live in Kyiv, and the client draws every
 * date in Kyiv. A day that ended at UTC midnight would put an order placed at
 * half past midnight in Kyiv into the previous day's bar, and a report for
 * "1 March" would silently start two or three hours late. So a day here starts
 * at Kyiv midnight, whichever offset Kyiv happens to be on — UTC+2 in winter,
 * UTC+3 in summer.
 *
 * The offset is read from the time-zone database rather than written down, so
 * a change to Ukraine's clock rules is a database update and not a code change.
 * The sibling backend reads the same database through `zoneinfo`, and resolves
 * the one ambiguous case the same way: a wall-clock time that a clock change
 * skips or repeats is read with the offset in force *before* the change
 * (Python's `fold=0`). Midnight is never such a time in Kyiv, whose clocks move
 * at three and four in the morning, so the rule only matters for an explicit
 * zone-less time inside that hour.
 */

/** The zone the reports are cut in, as both the code and the SQL name it. */
export const REPORT_TIME_ZONE = 'Europe/Kyiv';

const DAY_MS = 86_400_000;

const kyivClock = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** What a clock in Kyiv shows at `instant`, to the second. */
const kyivWallClockAt = (instant: number): WallClock => {
  const parts = new Map(
    kyivClock.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.get(type));
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
};

/** Kyiv's offset from UTC at `instant`, in milliseconds. */
const kyivOffsetAt = (instant: number): number => {
  const wall = kyivWallClockAt(instant);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
};

/**
 * The instant at which a Kyiv clock shows the given wall-clock time.
 *
 * `wallClock` is the wall-clock reading encoded as if it were UTC — what
 * `Date.UTC(year, monthIndex, day, …)` returns. A reading a clock change skips
 * or repeats takes the offset in force before the change, as described above.
 */
export const kyivWallClockToInstant = (wallClock: number): number => {
  const before = kyivOffsetAt(wallClock - DAY_MS);
  const after = kyivOffsetAt(wallClock + DAY_MS);
  const asBefore = wallClock - before;
  if (before === after) return asBefore;
  const beforeHolds = kyivOffsetAt(asBefore) === before;
  const afterHolds = kyivOffsetAt(wallClock - after) === after;
  // Only one reading is real: the change is near, but this time is clear of it.
  if (afterHolds && !beforeHolds) return wallClock - after;
  // Both real (the repeated hour) or neither (the skipped one): the offset
  // before the change, as `fold=0` reads it.
  return asBefore;
};

/** The instant a day of the Kyiv calendar begins. `monthIndex` is zero-based. */
export const kyivMidnight = (year: number, monthIndex: number, day: number): Date =>
  new Date(kyivWallClockToInstant(Date.UTC(year, monthIndex, day)));

/** The next Kyiv midnight after `now`: the exclusive end of today, in Kyiv. */
export const nextKyivMidnight = (now: number = Date.now()): string => {
  const today = kyivWallClockAt(now);
  return kyivMidnight(today.year, today.month - 1, today.day + 1).toISOString();
};

/**
 * Where the default report window starts: Kyiv midnight of 1 January 2026,
 * where the demonstration data begins. The shared reporting window names the
 * same calendar day; this is that day's start on the calendar reports use.
 */
export const DEFAULT_KYIV_WINDOW_FROM = kyivMidnight(2026, 0, 1).toISOString();

/** The end of the default report window: the close of today in Kyiv. */
export const defaultKyivWindowTo = (now: number = Date.now()): string => nextKyivMidnight(now);
