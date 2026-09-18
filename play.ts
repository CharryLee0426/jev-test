#!/usr/bin/env node
/**
 * jev-test launcher: run any game agent in this repo from the root.
 *
 *   node play.ts --list                     games available
 *   node play.ts --check-key                validate TYPESAFE_API_KEY from ./.env
 *   node play.ts flappy-bird --target-score 20
 *
 * A game is a folder with a game.json ({ name, title, description, entry }).
 * The TypeSafe API key lives in ./.env here in the root and is handed to the
 * game through the environment; each game runs with its own folder as the
 * working directory, so per-game files such as agent.config.json apply.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

interface Game {
  name: string;
  title: string;
  description: string;
  entry: string;
  dir: string;
}

function loadGames(): Game[] {
  const games: Game[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const manifestPath = join(root, entry.name, "game.json");
    if (!existsSync(manifestPath)) continue;
    let m: Partial<Game>;
    try {
      m = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<Game>;
    } catch (err) {
      console.error(`skipping ${entry.name}: game.json is not valid JSON (${(err as Error).message})`);
      continue;
    }
    games.push({
      name: m.name ?? entry.name,
      title: m.title ?? entry.name,
      description: m.description ?? "",
      entry: m.entry ?? "src/main.ts",
      dir: join(root, entry.name),
    });
  }
  return games.sort((a, b) => a.name.localeCompare(b.name));
}

function loadRootEnv(): string | null {
  const path = join(root, ".env");
  if (!existsSync(path)) return null;
  try {
    process.loadEnvFile(path);
    return path;
  } catch (err) {
    console.error(`could not read ${path}: ${(err as Error).message}`);
    return null;
  }
}

function usage(games: Game[]): string {
  const list = games.length === 0 ? "  (none found: add a folder with a game.json)" : games.map((g) => `  ${g.name.padEnd(14)} ${g.title}`).join("\n");
  return `jev-test: run TypeSafe Jev game agents.

Usage
  node play.ts <game> [game options...]    run a game (options are passed through; try --help)
  node play.ts --list                      list games with descriptions
  node play.ts --check-key                 validate TYPESAFE_API_KEY in ./.env

Games
${list}

The API key is read from ${join(root, ".env")} (copy .env.example there).
`;
}

async function checkKey(): Promise<number> {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) {
    console.error("TYPESAFE_API_KEY is not set. Create ./.env from .env.example.");
    return 1;
  }
  const base = process.env.TYPESAFE_BASE_URL?.replace(/\/+$/, "") || "https://api.typesafe.ai";
  const res = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (!res.ok) {
    console.error(`Key check failed: HTTP ${res.status} ${res.statusText}`);
    return 1;
  }
  const body = (await res.json()) as { models?: { name: string; description?: string }[] };
  const names = (body.models ?? []).map((m) => m.name);
  console.log(`API key OK. Models available: ${names.join(", ") || "(none listed)"}`);
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const games = loadGames();
  const envPath = loadRootEnv();
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(usage(games));
    return;
  }
  if (args[0] === "--list" || args[0] === "-l") {
    for (const g of games) console.log(`${g.name}\n  ${g.title}\n  ${g.description}\n  entry: ${join(g.dir, g.entry)}`);
    if (games.length === 0) console.log("no games found");
    return;
  }
  if (args[0] === "--check-key") {
    process.exitCode = await checkKey();
    return;
  }
  const game = games.find((g) => g.name === args[0]);
  if (!game) {
    console.error(`unknown game "${args[0]}". Known games: ${games.map((g) => g.name).join(", ") || "none"}`);
    process.exitCode = 2;
    return;
  }
  const entry = join(game.dir, game.entry);
  if (!existsSync(entry)) {
    console.error(`${game.name}: entry ${entry} does not exist`);
    process.exitCode = 2;
    return;
  }
  console.log(`Launching ${game.title}${envPath ? ` (key from ${envPath})` : " (no .env in the root: set TYPESAFE_API_KEY or the game will not start)"}`);
  const child = spawn(process.execPath, [entry, ...args.slice(1)], { cwd: game.dir, stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
