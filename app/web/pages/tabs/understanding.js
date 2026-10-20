import { computed, defineComponent, inject, ref } from "vue";
import { api, call } from "../../api.js";
import { ApprovalDialog } from "../../collaboration-ui.js";
import Requirements from "./requirements.js";
import Scenarios from "./scenarios.js";
import Questions from "./questions.js";
import { understandingAction } from "../../understanding.js";

export default defineComponent({
  components: { Requirements, Scenarios, Questions, ApprovalDialog },
  setup() {
    const { id, view, reload } = inject("project");
    const { understandingPane: pane, open } = inject("workspace");
    const approvalVisible = ref(false);
    const action = computed(() => understandingAction(view.value));
    const starting = ref(false);
    const analyze = async () => {
      if (starting.value || !action.value || view.value.job?.status === "处理中") return;
      starting.value = true;
      try { if (await call(() => api(`/projects/${id}/${action.value.path}`, { method: "POST", body: action.value.body }))) await reload(); }
      finally { starting.value = false; }
    };
    const started = async () => { await reload(); open("pbs"); };
    return { id, view, pane, open, analyze, action, starting, approvalVisible, started };
  },
  template: `
  <div class="understanding-header">
    <div><b>需求理解</b><p class="muted">逐条核对客户要求，按业务场景组织，并持续补全未明确的内容。</p></div>
    <el-button v-if="view.steps.requirements.total" :disabled="starting || view.job?.status === '处理中'" @click="approvalVisible = true">审阅本轮 PBS 输入范围</el-button>
    <el-button v-if="action" type="primary" :loading="starting" :disabled="view.job?.status === '处理中'" @click="analyze">{{ action.label }}</el-button>
  </div>
  <div class="understanding-views" role="tablist" aria-label="需求理解视图">
    <button role="tab" :aria-selected="pane === 'requirements'" :class="{ active: pane === 'requirements' }" @click="open('requirements')"><b>需求条目 <span>{{ view.steps.requirements.total }}</span></b><small>具体要求与原文依据</small></button>
    <button role="tab" :aria-selected="pane === 'scenarios'" :class="{ active: pane === 'scenarios' }" @click="open('scenarios')"><b>业务场景 <span>{{ view.scenarioCoverage.active }}</span></b><small>这些要求支撑什么工作</small></button>
    <button role="tab" :aria-selected="pane === 'questions'" :class="{ active: pane === 'questions' }" @click="open('questions')"><b>待澄清事项 <span>{{ view.steps.questions.open + view.steps.questions.answered }}</span></b><small>信息缺口与待采纳的答复</small></button>
  </div>
  <Requirements v-if="pane === 'requirements'" />
  <Scenarios v-else-if="pane === 'scenarios'" />
  <Questions v-else />
  <ApprovalDialog v-model="approvalVisible" :project-id="id" :open="open" @started="started" />`,
});
