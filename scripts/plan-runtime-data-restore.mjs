import { planRuntimeRestore } from "./lib/runtime-data-restore.mjs";

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--dry-run") {
      values.set(name, true);
      continue;
    }
    if (!name.startsWith("--") || index + 1 >= argv.length) {
      throw new Error("Invalid runtime restore arguments");
    }
    values.set(name, argv[index + 1]);
    index += 1;
  }
  if (!values.get("--dry-run")) throw new Error("Only --dry-run is available from this command");
  for (const name of ["--source", "--destination", "--active-count"]) {
    if (!values.has(name)) throw new Error(`Missing ${name}`);
  }
  if (values.get("--active-count") !== "0") {
    throw new Error("Runtime restore dry-run requires --active-count 0");
  }
  return values;
}

const args = readArguments(process.argv.slice(2));
const plan = await planRuntimeRestore({
  sourceRoot: args.get("--source"),
  destinationRoot: args.get("--destination"),
  activeCount: 0,
});

process.stdout.write(JSON.stringify({
  sourceCount: plan.sourceCount,
  destinationCount: plan.destinationCount,
  commonCount: plan.commonCount,
  unionCount: plan.unionCount,
  missingCount: plan.missingProjects.length,
  sameScopeDifferentId: plan.sameScopeDifferentId.length,
  conflicts: plan.conflicts.length,
  requiresActiveCount: plan.requiresActiveCount,
}));
