import * as repo from "./repo.mjs";
import * as svc from "./services.mjs";
import * as chat from "./chat.mjs";
import { runAgent } from "./agent-runner.mjs";

const GOALS = {
  analyze: "理解客户材料：完整读取待处理材料，整理有原文依据的需求条目，并结合客户目标组织业务场景，发现遗漏、冲突及待澄清事项。需求条目、业务场景、澄清事项是同一次需求理解的关联成果，可迭代完善。已有主体明确但细节待澄清的需求可以形成场景草稿；不必等待全部确认。不强造场景，保留部署、安全、服务、商务等约束的处理去向。检查引用和材料覆盖，保留人工成果，不自动确认、不代答客户。此次不生成PBS。",
  generate_scenarios: "从当前原始需求归纳场景需求与澄清事项，建立条款来源映射，保留人工成果。此次不生成PBS。",
  generate_capabilities: "从当前原始需求归纳场景需求与业务活动，保留人工成果。",
  generate_pbs: "基于客户场景与需求，检索产品能力、限制及BOM，生成项目PBS组合草稿并检查覆盖。保留人工成果。",
  resume_agent: "继续上次未完成的工作，先读取项目状态与处理覆盖，保留已保存内容，仅处理剩余事项。",
};
export const agentGoal = (action) => GOALS[action.type];

export async function agentChatTurn(projectId, body, ctx) {
  if (body.actions?.length && body.actions.every((a) => !agentGoal(a))) return chat.chatTurn(projectId, body, ctx);
  const text = String(body.text ?? "").trim();
  const label = text || body.label || (body.attachment ? `上传了文件 ${body.attachment.name}` : "");
  if (!label && !body.actions?.length) throw new Error("请输入内容");
  repo.addChat(projectId, "user", label, body.attachment ? { attachment: { name: body.attachment.name } } : {});
  let goal = text;
  const isMaterial = body.attachment || (text.length > 400 && /(?:^|\n)(?:#{1,3}|第[一二三四五六七八九十\d]+章|\d+\.\d+[.、\s])/.test(text));
  if (isMaterial) {
    const materialText = body.attachment?.text ?? text;
    const id = svc.addMaterial(projectId, { title: body.attachment?.name?.replace(/\.[^.]+$/, ""), fileName: body.attachment?.name, text: materialText, description: body.attachment ? text : "" });
    goal = `用户提供了材料 material:${id}，已保存。${GOALS.analyze}`;
  }
  if (body.actions?.length) {
    if (body.actions.some((a) => !agentGoal(a))) throw new Error("请分别执行生成任务与人工确认操作");
    goal = body.actions.map((a) => agentGoal(a) + (a.all ? "请回查全部材料，但不得覆盖人工成果。" : "")).join("\n");
  }
  try {
    const resume = body.actions?.find((a) => a.type === "resume_agent");
    const result = await runAgent(projectId, goal, { ...ctx, resume: Boolean(resume), resumeRunId: resume?.run_id });
    const view = svc.projectView(projectId);
    const tab = body.actions?.some((a) => a.type === "generate_pbs") || (!body.actions?.length && !isMaterial && /生成|调整|组合/.test(text) && /PBS/i.test(text)) ? "pbs" : /需求|场景|澄清|材料/.test(goal) ? "understanding" : null;
    const messageId = repo.addChat(projectId, "assistant", result.reply || result.report.finished?.summary || "本次工作已记录，请查看成果和待审事项。", { execution: "deepseek-harness", runId: result.runId, cards: result.cards, results: [], open: tab ? { tab } : null, suggestions: chat.suggestions(view) });
    return { messageId, runId: result.runId };
  } catch (error) {
    repo.addChat(projectId, "assistant", ctx.signal?.aborted ? "任务已停止，已保存的草稿保留，可继续处理。" : `本次工作未完成：${error.message}`, { error: !ctx.signal?.aborted, suggestions: error.agentRunId ? [{ label: "继续未完成的工作", actions: [{ type: "resume_agent", run_id: error.agentRunId }] }] : [] });
    throw error;
  }
}
