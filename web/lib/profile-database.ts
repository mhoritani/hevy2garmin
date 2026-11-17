import postgres from "postgres";
import { ensureSchema } from "./schema";
import { resolveDatabaseUrl, DATABASE_URL_HINT } from "./database-url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
export type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  json: <T>(value: T) => unknown;
};
const clients = new Map<string, ReturnType<typeof postgres>>();
const tags = new Map<string, SqlTag>();

export function profileSchema(id: string): string {
  if (id === "default") return "public";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new Error("Invalid profile identifier.");
  }
  return "h2g_" + id.replaceAll("-", "");
}

/** Scope garmin-auth's independent pg connections too, without a public fallback. */
export function profileDatabaseUrl(id: string, databaseUrl = resolveDatabaseUrl()): string {
  if (!databaseUrl) throw new Error(`No Postgres connection string. Set one of: ${DATABASE_URL_HINT}`);
  const url = new URL(databaseUrl);
  const previous = url.searchParams.get("options");
  url.searchParams.set("options", [previous, `-c search_path=${profileSchema(id)}`].filter(Boolean).join(" "));
  return url.toString();
}

/** Internal raw client for transactional profile provisioning. */
export function profileClient(id = "default") {
  const schema = profileSchema(id);
  let client = clients.get(schema);
  if (!client) {
    client = postgres(profileDatabaseUrl(id), { prepare: false, max: 5 });
    clients.set(schema, client);
  }
  return client;
}

export function profileSql(id = "default"): SqlTag {
  const schema = profileSchema(id);
  let tag = tags.get(schema);
  if (tag) return tag;
  const client = profileClient(id);
  tag = ((strings: TemplateStringsArray, ...values: unknown[]) => ensureSchema(client)
    .then(() => (client as unknown as SqlTag)(strings, ...values))
    .then((rows) => Array.from(rows))) as SqlTag;
  tag.json = <T,>(value: T) => client.json(value as Parameters<typeof client.json>[0]);
  tags.set(schema, tag);
  return tag;
}

export async function closeProfileDatabases(): Promise<void> {
  await Promise.all(Array.from(clients.values(), (client) => client.end()));
  clients.clear();
  tags.clear();
}
