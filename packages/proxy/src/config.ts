import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse, stringify } from "yaml";
import { watch } from "chokidar";
import { ConfigSchema, type Config } from "./types/config.js";

let currentConfig: Config;
let configPath: string;
let rawContent: string;

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

function resolveConfigEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveConfigEnvVars);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveConfigEnvVars(v);
    }
    return result;
  }
  return obj;
}

const DEFAULT_CONFIG = `server:
  port: 3456
  host: 0.0.0.0
providers: []
tokens: []
`;

export function loadConfig(filePath?: string): Config {
  const defaultPath = path.join(os.homedir(), ".tokenparty", "config.yaml");
  configPath = filePath ?? defaultPath;

  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, DEFAULT_CONFIG, "utf-8");
    console.log(`[tokenparty] Created default config at ${configPath}`);
  }

  rawContent = fs.readFileSync(configPath, "utf-8");
  const parsed = parse(rawContent);
  const resolved = resolveConfigEnvVars(parsed);
  currentConfig = ConfigSchema.parse(resolved);

  const configDir = path.dirname(configPath);
  currentConfig.server.logDir = path.resolve(configDir, currentConfig.server.logDir);
  currentConfig.server.dataDir = path.resolve(configDir, currentConfig.server.dataDir);

  fs.mkdirSync(currentConfig.server.logDir, { recursive: true });
  fs.mkdirSync(currentConfig.server.dataDir, { recursive: true });

  return currentConfig;
}

export function getConfig(): Config {
  return currentConfig;
}

export function watchConfig(onChange?: (config: Config) => void) {
  const watcher = watch(configPath, { ignoreInitial: true });
  watcher.on("change", () => {
    try {
      const newConfig = loadConfig(configPath);
      onChange?.(newConfig);
      console.log("[config] Reloaded config.yaml");
    } catch (e) {
      console.error("[config] Failed to reload:", e);
    }
  });
  return watcher;
}

export function updateConfig(mutator: (raw: Record<string, unknown>) => void): Config {
  const parsed = parse(rawContent);
  mutator(parsed);
  const newYaml = stringify(parsed, { lineWidth: 120 });
  fs.writeFileSync(configPath, newYaml, "utf-8");
  return loadConfig(configPath);
}

// Test helper: inject a config object directly without touching disk.
// The schema is the same one used by loadConfig, so a Config parsed
// here is interchangeable with one loaded from YAML.
export function _setConfigForTest(config: Config): void {
  currentConfig = config;
}
