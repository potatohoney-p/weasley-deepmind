function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid corpus: ${message}`);
}
function object(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), label);
  requireValue(Object.keys(value).every(key => keys.includes(key)), `unknown field in ${label}`);
}
function id(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value); }
function content(value) { return typeof value === "string" && value.length > 0 && value.length <= 4000; }
function answers(value, label) {
  requireValue(Array.isArray(value), label);
  const ids = new Set();
  for (const row of value) {
    object(row, ["id", "content"], label);
    requireValue(id(row.id) && content(row.content) && !ids.has(row.id), `invalid/duplicate answer in ${label}`);
    ids.add(row.id);
  }
}

export function validateCorpus(corpus) {
  object(corpus, ["version", "name", "budgets", "episodes"], "root");
  requireValue(corpus.version === 1 && id(corpus.name), "version/name");
  requireValue(Array.isArray(corpus.budgets) && corpus.budgets.length === 3 &&
    corpus.budgets.every((value, i, values) => Number.isSafeInteger(value) && value > 0 &&
      value <= 10000 && (i === 0 || value > values[i - 1])), "three increasing positive budgets");
  requireValue(Array.isArray(corpus.episodes) && corpus.episodes.length > 0 && corpus.episodes.length <= 10, "episodes");
  const episodes = new Set();
  for (const episode of corpus.episodes) {
    object(episode, ["id", "language", "events", "checkpoints"], "episode");
    requireValue(id(episode.id) && !episodes.has(episode.id), "invalid/duplicate episode");
    requireValue(["en", "ko", "ja"].includes(episode.language), "language");
    episodes.add(episode.id);
    requireValue(Array.isArray(episode.events) && episode.events.length > 0 && episode.events.length <= 40, "events");
    const known = new Set();
    const live = new Set();
    const current = new Map();
    const prefixes = [];
    for (const event of episode.events) {
      object(event, ["op", "id", "content", "importance"], "event");
      requireValue(id(event.id) && ["put", "supersede", "amend", "delete"].includes(event.op), "event operation/id");
      if (event.op === "put") {
        requireValue(!known.has(event.id), "put IDs must be unique, including after deletion");
        known.add(event.id); live.add(event.id);
        current.set(event.id, { id: event.id, content: event.content });
      } else {
        requireValue(live.has(event.id), "mutation target must exist");
        if (event.op === "delete") live.delete(event.id);
        if (event.op === "delete" || event.op === "supersede") current.delete(event.id);
        if (event.op === "amend" && current.has(event.id)) current.set(event.id, { id: event.id, content: event.content });
      }
      if (event.op === "put" || event.op === "amend") requireValue(content(event.content), "event content");
      else requireValue(event.content === undefined, "content only applies to put/amend");
      if (event.importance !== undefined) requireValue(event.op === "put" &&
        Number.isFinite(event.importance) && event.importance >= 0 && event.importance <= 1, "importance");
      prefixes.push([...current.values()]);
    }
    requireValue(known.size <= 25, "at most 25 candidates per episode (below the production hot-cache bound)");
    requireValue(Array.isArray(episode.checkpoints) && episode.checkpoints.length > 0 && episode.checkpoints.length <= 10, "checkpoints");
    const checkpoints = new Set();
    for (const checkpoint of episode.checkpoints) {
      object(checkpoint, ["id", "after", "expected", "admissible"], "checkpoint");
      requireValue(id(checkpoint.id) && !checkpoints.has(checkpoint.id), "invalid/duplicate checkpoint");
      checkpoints.add(checkpoint.id);
      requireValue(Number.isSafeInteger(checkpoint.after) && checkpoint.after > 0 &&
        checkpoint.after <= episode.events.length, "checkpoint position");
      answers(checkpoint.expected, "expected"); answers(checkpoint.admissible, "admissible");
      const prefix = prefixes[checkpoint.after - 1];
      requireValue(checkpoint.admissible.length === prefix.length && checkpoint.admissible.every(row =>
        prefix.some(active => active.id === row.id && active.content === row.content)),
      "admissible oracle must exactly match live content in the event prefix");
      requireValue(checkpoint.expected.every(row => checkpoint.admissible.some(allowed =>
        allowed.id === row.id && allowed.content === row.content)), "expected must be admissible");
    }
  }
  return corpus;
}

// The only ingest payload: no held-out answers, language labels or later queries.
export function replayEpisodes(corpus) {
  return corpus.episodes.map(episode => ({
    id: episode.id,
    events: episode.events.map(event => ({ ...event })),
    checkpoints: episode.checkpoints.map(({ id, after }) => ({ id, after }))
  }));
}
