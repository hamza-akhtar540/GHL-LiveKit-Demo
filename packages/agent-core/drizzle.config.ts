import { defineConfig } from "drizzle-kit";
import "dotenv/config";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — copy .env.example to .env and fill it in.`);
  return v;
}

export default defineConfig({
  schema: ["./src/conversation/schema.ts", "./src/leads/schema.ts", "./src/social/schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // No hardcoded fallback. A default credential in a config file is the kind
    // of thing that gets copied into a real environment and quietly works until
    // it doesn't — better to fail immediately and say what is missing.
    url: requireEnv("DATABASE_URL"),
  },
});
