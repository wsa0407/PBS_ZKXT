import { defineComponent, inject } from "vue";
import { api, runJob } from "../../api.js";
import Requirements from "./requirements.js";
import Scenarios from "./scenarios.js";
import Questions from "./questions.js";

export default defineComponent({
  components: { Requirements, Scenarios, Questions },
  setup() {
    const { id, view, reload } = inject("project");
    const { understandingPane: pane, open } = inject("workspace");
    const analyze = async () => {
      if (await runJob("理解客户材料", () => api(`/projects/${id}/analyze`, { method: "POST", body: {} }))) await reload();
    };
    return { view, pane, open, analyze };
  },
  template: `
  <div class="understanding-header">
    <div><b>需求理解</b><p class="muted">逐条核对客户要求，按业务场景组织，并持续补全未明确的内容。</p></div>
    <el-button type="primary" :disabled="!view.materials.length || view.job?.status === '处理中'" @click="analyze">{{ view.job?.status === '处理中' ? '正在处理材料…' : view.steps.materials.pending ? '理解待处理材料（' + view.steps.materials.pending + '）' : view.requirements.length ? '继续理解与完善' : '开始理解材料' }}</el-button>
  </div>
  <div class="understanding-views" role="tablist" aria-label="需求理解视图">
    <button role="tab" :aria-selected="pane === 'requirements'" :class="{ active: pane === 'requirements' }" @click="open('requirements')"><b>需求条目 <span>{{ view.steps.requirements.total }}</span></b><small>具体要求与原文依据</small></button>
    <button role="tab" :aria-selected="pane === 'scenarios'" :class="{ active: pane === 'scenarios' }" @click="open('scenarios')"><b>业务场景 <span>{{ view.scenarioCoverage.active }}</span></b><small>这些要求支撑什么工作</small></button>
    <button role="tab" :aria-selected="pane === 'questions'" :class="{ active: pane === 'questions' }" @click="open('questions')"><b>待澄清事项 <span>{{ view.steps.questions.open + view.steps.questions.answered }}</span></b><small>尚未明确或待应用的答复</small></button>
  </div>
  <Requirements v-if="pane === 'requirements'" />
  <Scenarios v-else-if="pane === 'scenarios'" />
  <Questions v-else />`,
});
