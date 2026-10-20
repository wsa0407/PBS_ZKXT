// Portable dsh Agent composition. The host binds business tools and infrastructure.
export function pbsPreset({ instructions, skillsDirectory }) {
  return [
    { id: "pbs-persona", name: "@deepseek-ai/dsh-persona", config: { prefix: instructions, includeRuntimeContext: false } },
    { id: "pbs-skills", name: "@deepseek-ai/dsh-skill-filesystem", config: { providerName: "pbs", includeDefaultRoots: false, customSkillDirs: [skillsDirectory], watch: false } },
  ];
}
