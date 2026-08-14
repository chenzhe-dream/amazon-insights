import { fileURLToPath } from "node:url";

import { validateSkillArchiveSource } from "../server/skills/archive";
import {
  agentDefinitions,
  validateAgentDefinitions,
} from "../server/skills/agent-definitions";
import { SkillRegistry } from "../server/skills/registry";

const skillsRoot = fileURLToPath(new URL("../skills-src/", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const registry = await SkillRegistry.open(skillsRoot);

for (const registeredSkill of registry.list()) {
  await validateSkillArchiveSource(
    `${repositoryRoot}${registeredSkill.id}.zip`,
    `${skillsRoot}${registeredSkill.id}`,
    registeredSkill.id,
  );
  await registry.load(registeredSkill.id, registeredSkill.version);
}
await validateAgentDefinitions(agentDefinitions, registry);

for (const registeredSkill of registry.list()) {
  console.log(
    `${registeredSkill.id}\t${registeredSkill.version}\t${registeredSkill.contentHash}`,
  );
}
