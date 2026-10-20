// SDK Agents need an explicit preset binding before their first model request.
export const name = "pbs-sdk-preset-binding";
export const inject = ["agentPresets", "sessionProjections"];
export function apply(ctx) {
  ctx.on("agent/created", async ({ agent }) => {
    const stored = ctx.sessionProjections.stateOf(agent.session, "agentPreset");
    const { id } = await ctx.agentPresets.mount(agent.ctx, stored ?? "pbs");
    if (!stored) agent.session.append("agent-preset/selected", { agentPreset: id });
  });
}
