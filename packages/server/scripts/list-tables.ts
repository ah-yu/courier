import { Database } from "bun:sqlite";

const db = new Database("data/courier.db");
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as { name: string }[];

if (tables.length === 0) {
  console.log("No tables found.");
} else {
  for (const t of tables) {
    console.log(`  ${t.name}`);
  }
}
