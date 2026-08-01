export const usage = [
  "Usage: memento-mcp backfill",
  "",
  "Backfill missing embedding vectors for existing fragments.",
  "",
  "Options:",
  "  (none — uses POSTGRES_* / EMBEDDING_* env vars)",
  "",
  "Examples:",
  "  memento-mcp backfill",
].join("\n");

export default async function backfill(_args) {
  if (!process.env.DATABASE_URL) {
    const h  = process.env.POSTGRES_HOST || "localhost";
    const p  = process.env.POSTGRES_PORT || "5432";
    const d  = process.env.POSTGRES_DB || "memento";
    const u  = process.env.POSTGRES_USER || "postgres";
    const pw = process.env.POSTGRES_PASSWORD || "";
    process.env.DATABASE_URL = `postgresql://${u}:${encodeURIComponent(pw)}@${h}:${p}/${d}`;
  }
  await import("../../scripts/backfill-embeddings.js");
}
