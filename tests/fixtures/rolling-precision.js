// Newest feedback has the smallest age; IDs break timestamp ties.
const row = (id, session, age, relevant, sufficient = relevant) =>
  ({ id, session, age, relevant, sufficient });
const ten = (olderRelevant, newerRelevant, tied = false) => Array.from({ length: 10 }, (_, i) =>
  row(i + 1, "a", tied ? 1 : 10 - i, i < 5 ? olderRelevant : newerRelevant));

export const rollingPrecisionCases = [
  {
    name: "older positive feedback cannot fill the latest five negative slots",
    rows: ten(true, false), window: 100, precision: 0, sufficient: 0.5, sessions: 1
  },
  {
    name: "older negative feedback does not dilute the latest five positive slots",
    rows: ten(false, true), window: 100, precision: 1, sufficient: 0.5, sessions: 1
  },
  {
    name: "timestamp ties use descending feedback IDs",
    rows: ten(true, false, true), window: 100, precision: 0, sufficient: 0.5, sessions: 1
  },
  {
    name: "short sessions divide by available feedback",
    rows: [row(1, "a", 3, true), row(2, "a", 2, false), row(3, "a", 1, true)],
    window: 100, precision: 2 / 3, sufficient: 2 / 3, sessions: 1
  },
  {
    name: "sessions contribute equally rather than in proportion to their length",
    rows: [...ten(true, false), row(11, "b", 1, true)],
    window: 100, precision: 0.5, sufficient: 0.75, sessions: 2
  },
  {
    name: "the session limit selects the most recently active session",
    rows: [...ten(true, false), row(11, "b", 0, true)],
    window: 1, precision: 1, sufficient: 1, sessions: 1
  },
  {
    name: "tied session activity is ordered deterministically by session ID",
    rows: [row(1, "b", 1, true), row(2, "a", 1, false)],
    window: 1, precision: 0, sufficient: 0, sessions: 1
  },
  {
    name: "old and anonymous feedback do not enter the sample",
    rows: [row(1, "a", 31 * 86400, true), row(2, null, 0, true)],
    window: 100, precision: null, sufficient: null, sessions: 0
  },
  {
    name: "the 30-day boundary is excluded before ranking and counting",
    rows: [row(1, "a", 30 * 86400, true), row(2, "a", 1, false)],
    window: 100, precision: 0, sufficient: 0, sessions: 1
  },
  {
    name: "empty feedback returns null rates and no sampled sessions",
    rows: [], window: 100, precision: null, sufficient: null, sessions: 0
  }
];
