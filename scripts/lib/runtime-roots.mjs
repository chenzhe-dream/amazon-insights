import path from "node:path";

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function explicitAbsoluteRoot(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be absolute`);
  }
  return path.resolve(value);
}

export function resolveRuntimeRoots({
  codeRoot: inputCodeRoot,
  formal = false,
  env = process.env,
  commit,
}) {
  const codeRoot = path.resolve(inputCodeRoot);
  const mode = formal ? "formal" : "development";
  const configuredDataRoot = env.AGENT_DATA_ROOT?.trim();
  const configuredRuntimeRoot = env.AGENT_RUNTIME_ROOT?.trim();

  const dataRoot = configuredDataRoot
    ? explicitAbsoluteRoot("AGENT_DATA_ROOT", configuredDataRoot)
    : formal
      ? explicitAbsoluteRoot("AGENT_DATA_ROOT", configuredDataRoot)
      : path.join(codeRoot, "data");
  const runtimeRoot = configuredRuntimeRoot
    ? explicitAbsoluteRoot("AGENT_RUNTIME_ROOT", configuredRuntimeRoot)
    : formal
      ? explicitAbsoluteRoot("AGENT_RUNTIME_ROOT", configuredRuntimeRoot)
      : path.join(codeRoot, ".runtime");

  if (formal && isWithin(codeRoot, dataRoot)) {
    throw new Error("AGENT_DATA_ROOT must be outside codeRoot");
  }
  if (formal && isWithin(codeRoot, runtimeRoot)) {
    throw new Error("AGENT_RUNTIME_ROOT must be outside codeRoot");
  }

  return Object.freeze({ codeRoot, dataRoot, runtimeRoot, commit, mode });
}
