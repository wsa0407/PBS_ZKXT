import { computed, defineComponent, ref, watch } from "vue";
import { api, call } from "./api.js";
import { approvalSelectionIssue } from "../shared/understanding.js";

export const expertLabels = { materials: "材料拆解专家", understanding: "需求理解专家", pbs: "PBS专家", human: "我", all: "专家群", system: "协作提示" };
export const exchangeStatus = { received: "已接收", waiting: "等待答复", delivered: "已送达", processing: "正在处理", answered: "已答复", adjusted: "已据此调整", requires_confirmation: "需你确认", needs_clarification: "仍待澄清", read_only: "已答复", paused: "已暂停" };
export const ExpertDetails = defineComponent({
  props: { message: Object, open: Function },
  setup(props) {
    const openReference = (ref) => props.open(/^SC/.test(ref) ? "scenarios" : /^R/.test(ref) ? "requirements" : /^M\d+:/.test(ref) ? "materials" : "pbs", ref.startsWith("pbs:") ? Number(ref.slice(4)) : ref);
    const meaningfulStatus = (status) => ["waiting", "requires_confirmation", "needs_clarification", "paused"].includes(status) ? exchangeStatus[status] : "";
    return { expertLabels, exchangeStatus, openReference, meaningfulStatus };
  },
  template: `<div class="exchange-details">
    <div v-if="message.payload.nature" class="muted" style="font-size:11px;margin-top:6px">{{ ({source_fact:'原文事实',human_confirmed:'人工已确认范围',analysis:'专家分析建议',unknown:'仍待澄清'})[message.payload.nature] }}</div>
    <div v-if="message.payload.references?.length" class="exchange-refs"><button v-for="r in message.payload.references" :key="r" @click="openReference(r)">{{ r }}</button></div>
    <details v-if="message.payload.evidence?.length || message.payload.unknowns?.length || message.payload.coverage || message.payload.detail">
      <summary>{{ message.payload.detail ? '查看未完成原因' : '查看依据与待核对内容' }}</summary>
      <div v-for="e in message.payload.evidence || []" :key="e.evidence_id" class="exchange-evidence"><blockquote>{{ e.quote }}</blockquote><button @click="open('materials', e.evidence_id)">{{ e.evidence_id }}</button><small> · 原文版本 {{ e.document_version.slice(0, 8) }}</small></div>
      <div v-for="u in message.payload.unknowns || []" :key="u">待明确：{{ u }}</div>
      <div v-for="d in message.payload.coverage || []" :key="d.title">{{ d.title }}：已处理 {{ d.total_sections - d.remaining }}/{{ d.total_sections }} 段，剩余 {{ d.remaining }} 段</div>
      <p v-if="message.payload.detail">{{ message.payload.detail }}</p>
    </details>
    <details v-if="message.payload.reviewScope"><summary>查看本轮确认范围</summary><p>需求：{{ message.payload.reviewScope.requirements.join('、') }}</p><p>场景：{{ message.payload.reviewScope.scenarios.join('、') || '无' }}</p><p v-for="q in message.payload.reviewScope.questions" :key="q.id">待澄清：{{ q.question }}</p></details>
    <div v-if="message.payload.consultationId || meaningfulStatus(message.payload.status)" class="exchange-actions">
      <span>{{ meaningfulStatus(message.payload.status) }}</span>
      <span v-if="message.payload.consultationId" title="同一编号表示同一段专家讨论">讨论 {{ message.payload.consultationId.slice(0, 6) }}</span>
    </div>
  </div>`,
});

export const ApprovalDialog = defineComponent({
  props: { modelValue: Boolean, projectId: String, open: Function },
  emits: ["update:modelValue", "started"],
  setup(props, { emit }) {
    const data = ref(null), reqs = ref([]), scenes = ref([]), sending = ref(false), loading = ref(false);
    let requestId;
    const issue = computed(() => approvalSelectionIssue(data.value, reqs.value, scenes.value));
    const pendingQuestions = computed(() => (data.value?.questions ?? []).filter(q => (!q.req_ids.length && !q.scenario_ids.length) || q.req_ids.some(code => reqs.value.includes(code)) || q.scenario_ids.some(code => scenes.value.includes(code))));
    const load = async () => {
      if (loading.value) return;
      loading.value = true;
      data.value = null;
      try {
        const result = await call(() => api(`/projects/${props.projectId}/collaboration/approval`));
        if (result) { data.value = result; reqs.value = result.defaults.requirements; scenes.value = result.defaults.scenarios; requestId = crypto.randomUUID(); }
      } finally { loading.value = false; }
    };
    watch(() => props.modelValue, open => { if (open) load(); });
    const confirm = async () => {
      if (sending.value || issue.value) return;
      sending.value = true;
      try {
        const result = await call(() => api(`/projects/${props.projectId}/collaboration/confirm`, { method: "POST", body: { requestId, version: data.value.version, requirements: reqs.value, scenarios: scenes.value } }));
        if (result) { emit("update:modelValue", false); emit("started", result); }
      } finally { sending.value = false; }
    };
    const includeSceneRequirements = () => {
      const available = new Set(data.value.requirements.map(r => r.code));
      const linked = data.value.scenarios.filter(s => scenes.value.includes(s.code)).flatMap(s => s.links.map(l => l.req_id)).filter(code => available.has(code));
      reqs.value = [...new Set([...reqs.value, ...linked])];
    };
    const selectScenes = () => { scenes.value = data.value.scenarios.map(s => s.code); includeSceneRequirements(); };
    return { data, reqs, scenes, sending, loading, issue, pendingQuestions, load, confirm, selectScenes, includeSceneRequirements };
  },
  template: `<el-dialog :model-value="modelValue" title="确认本轮理解并交给 PBS" width="760px" :close-on-click-modal="!sending" :close-on-press-escape="!sending" :show-close="!sending" @update:model-value="$emit('update:modelValue', $event)">
    <div v-if="data" class="approval-review">
      <p>请只勾选你已审阅的需求与场景。此次确认会保存明确的输入版本；未明确的事项继续保留，专家不会替你回答客户。</p>
      <div class="approval-totals">本轮 {{ reqs.length }} 条需求 · {{ scenes.length }} 个场景 · {{ pendingQuestions.length }} 项关联或项目级待澄清事项<br><small>未纳入：{{ data.requirements.length - reqs.length }} 条需求、{{ data.scenarios.length - scenes.length }} 个场景</small></div>
      <details open><summary>需求范围</summary><button class="text-action" :disabled="sending" @click="reqs = data.requirements.map(r => r.code)">我已审阅，选择全部需求</button>
        <el-checkbox-group v-model="reqs" class="approval-list" :disabled="sending"><el-checkbox v-for="r in data.requirements" :key="r.code" :value="r.code"><b>{{ r.code }}</b> {{ r.text }} <small>（{{ r.status }}）</small></el-checkbox></el-checkbox-group>
      </details>
      <details open><summary>业务场景</summary><button class="text-action" v-if="data.scenarios.length" :disabled="sending" @click="selectScenes">选择全部场景及其关联需求</button>
        <el-checkbox-group v-model="scenes" class="approval-list" :disabled="sending" @change="includeSceneRequirements"><el-checkbox v-for="s in data.scenarios" :key="s.code" :value="s.code"><b>{{ s.code }} {{ s.name }}</b> — {{ s.goal }}<small>（{{ s.status }}）</small></el-checkbox></el-checkbox-group>
        <p v-if="!data.scenarios.length" class="muted">尚未整理业务场景，本次只交接所选需求。</p>
      </details>
      <details><summary>共性约束、待澄清事项与材料版本</summary>
        <p v-for="d in data.dispositions.filter(d => reqs.includes(d.req_id) && d.kinds?.includes('跨场景约束'))" :key="d.req_id">共性约束 {{ d.req_id }} · {{ d.note }}</p>
        <p v-for="q in pendingQuestions" :key="q.id">{{ q.question }}（{{ q.status }}）</p>
        <p v-for="s in data.sources" :key="s.id">{{ s.title }} · {{ s.version.slice(0, 12) }}</p>
      </details>
    </div><div v-else-if="loading">正在读取当前成果……</div><div v-else>确认范围未读取成功。<el-button link type="primary" @click="load">重新读取</el-button></div>
    <template #footer><div v-if="data && issue" class="muted">{{ issue }}</div><el-button :disabled="sending" @click="$emit('update:modelValue', false)">返回审阅</el-button><el-button type="primary" :loading="sending" :disabled="!!issue" @click="confirm">确认所选范围并开始 PBS</el-button></template>
  </el-dialog>`,
});
