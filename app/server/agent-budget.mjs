const labels = { agent: "本次专家运行", collaboration: "本轮协作" };
const units = { tokens: "累计 token", steps: "个模型步骤", time: "毫秒", activations: "次专家活动" };

export function budgetExceeded(scope, resource, used, limit) {
  const amount = resource === "time" ? `${Math.round(limit / 60000)} 分钟时限` : `${limit.toLocaleString("en-US")} ${units[resource]}上限`;
  const error = new Error(`${labels[scope]}达到 ${amount}，已保存成果保留。`);
  error.code = `${scope.toUpperCase()}_${resource.toUpperCase()}_LIMIT`;
  error.budget = { scope, resource, used, limit };
  return error;
}

// One launch owns one budget. Retrying an activation shares the launch budget.
// Durable agent_runs retain lifetime usage; explicit user continuation starts a new launch.
export function runBudget({ scope = "agent", maxTokens, maxSteps = Infinity, timeoutMs, clock = Date.now }) {
  const started = clock();
  let tokens = 0, steps = 0;
  const check = () => {
    const elapsed = clock() - started;
    if (elapsed >= timeoutMs) return budgetExceeded(scope, "time", elapsed, timeoutMs);
    if (steps > maxSteps) return budgetExceeded(scope, "steps", steps, maxSteps);
    if (tokens >= maxTokens) return budgetExceeded(scope, "tokens", tokens, maxTokens);
    return null;
  };
  return {
    check,
    startStep: () => { steps++; return check(); },
    recordUsage: ({ promptTokens, completionTokens }) => { tokens += promptTokens + completionTokens; return check(); },
  };
}

export const needsFreshContext = error => Boolean(error?.budget || error?.code === "BUDGET_EXHAUSTED"
  || /^(Agent运行预算已用完|协作已达到共同.*预算|本轮协作已达处理预算)/.test(error?.message ?? ""));

export function failureNotice(error) {
  const reason = error.budget ? error.message : error.code === "REPEATED_VALIDATION_FAILURE" ? "同类校验错误连续出现，已停止自动尝试。" : "本轮协作未完成，已保存成果和交流保留。";
  const recovery = error.code === "RUNTIME_CLEANUP_FAILED"
    ? "旧会话尚未确认停止，请检查运行服务后再继续。"
    : needsFreshContext(error) ? "回复“继续”后，将从已保存成果重新读取上下文，处理剩余工作。" : "可查看具体原因后继续处理。";
  return { content: `${reason}${recovery}`, payload: { error: true, code: error.code ?? "RUNTIME_ERROR", detail: error.message.slice(0, 600), ...(error.budget ? { budget: error.budget } : {}), resumable: error.code !== "RUNTIME_CLEANUP_FAILED" } };
}
