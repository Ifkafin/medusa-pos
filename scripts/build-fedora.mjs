import { access } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(repository, ".env");

try {
  await access(envPath);
  loadEnvFile(envPath);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const requiredVariables = ["VITE_BACKEND_URL"];
const missingVariables = requiredVariables.filter((name) => !process.env[name]?.trim());
if (missingVariables.length > 0) {
  console.error(`Missing required build variable${missingVariables.length === 1 ? "" : "s"}: ${missingVariables.join(", ")}`);
  console.error("Copy .env.example to .env and set the deployed Medusa HTTPS origin.");
  process.exit(1);
}

let backendUrl;
try {
  backendUrl = new URL(process.env.VITE_BACKEND_URL);
} catch {
  console.error("VITE_BACKEND_URL must be a valid URL.");
  process.exit(1);
}
if (backendUrl.protocol !== "https:" || backendUrl.username || backendUrl.password) {
  console.error("VITE_BACKEND_URL must be an HTTPS URL without embedded credentials.");
  process.exit(1);
}

const requiredCommands = ["cargo", "rustc", "rpmbuild"];
const missingCommands = requiredCommands.filter(
  (command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status !== 0,
);
if (missingCommands.length > 0) {
  console.error(`Missing Fedora build command${missingCommands.length === 1 ? "" : "s"}: ${missingCommands.join(", ")}`);
  if (missingCommands.includes("rpmbuild")) console.error("Install RPM tooling with: sudo dnf install rpm-build");
  console.error("Install the remaining Tauri prerequisites described in README.md, then rerun this command.");
  process.exit(1);
}

console.log(`Fedora build configuration is valid for ${backendUrl.origin}.`);
if (process.argv.includes("--check")) process.exit(0);

const tauri = join(repository, "node_modules", ".bin", "tauri");
const child = spawn(tauri, ["build", "--bundles", "rpm", "--ci"], {
  cwd: repository,
  env: process.env,
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
