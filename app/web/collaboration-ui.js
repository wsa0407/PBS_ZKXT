import { computed, defineComponent, ref, watch } from "vue";
import { api, call } from "./api.js";
import { approvalSelectionIssue, understandingBoard } from "../shared/understanding.js";

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
    const data = ref(null), extraReqs = ref([]), scenes = ref([]), sending = ref(false), loading = ref(false);
    const board = computed(() => understandingBoard(data.value ?? {}));
    const requiredCodes = computed(() => [...new Set(board.value.groups.filter(g => scenes.value.includes(g.scene.code)).flatMap(g => [...g.rows, ...g.constraints].map(e => e.req.code)))]);
    const reqs = computed(() => [...new Set([...requiredCodes.value, ...extraReqs.value])]);
    const otherRequirements = computed(() => board.value.requirements.filter(r => !requiredCodes.value.includes(r.code)));
    let requestId;
    const issue = computed(() => approvalSelectionIssue(data.value, reqs.value, scenes.value));
    const pendingQuestions = computed(() => (data.value?.questions ?? []).filter(q => (!q.req_ids.length && !q.scenario_ids.length) || q.req_ids.some(code => reqs.value.includes(code)) || q.scenario_ids.some(code => scenes.value.includes(code))));
    const load = async () => {
      if (loading.value) return;
      loading.value = true;
      data.value = null;
      try {
        const result = await call(() => api(`/projects/${props.projectId}/collaboration/approval`));
        if (result) {
          data.value = result;
          scenes.value = result.scenarios.map(s => s.code);
          extraReqs.value = result.requirements.filter(r => !requiredCodes.value.includes(r.code) && !["背景", "范围外"].includes(r.category)).map(r => r.code);
          requestId = crypto.randomUUID();
        }
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
    return { data, board, reqs, extraReqs, scenes, sending, loading, issue, pendingQuestions, otherRequirements, load, confirm };
  },
  template: `<el-dialog :model-value="modelValue" title="确认本轮理解并交给 PBS" width="760px" :close-on-click-modal="!sending" :close-on-press-escape="!sending" :show-close="!sending" @update:model-value="$emit('update:modelValue', $event)">
    <div v-if="data" class="approval-review">
      <p>场景与支撑需求一起确认。以下是建议纳入的本轮范围，可取消本轮不处理的场景；关联需求及适用约束随场景一并纳入。待明确的问题继续保留。</p>
      <div class="approval-totals">本轮 {{ scenes.length }} 个场景 · {{ reqs.length }} 条独立需求 · {{ pendingQuestions.length }} 项待明确<br><small>未纳入：{{ data.scenarios.length - scenes.length }} 个场景、{{ data.requirements.length - reqs.length }} 条需求</small></div>
      <el-checkbox-group v-model="scenes" :disabled="sending" class="approval-scene-list">
        <section v-for="g in board.groups" :key="g.scene.code" class="approval-scene">
          <el-checkbox :value="g.scene.code"><b>{{ g.scene.code }} {{ g.scene.name }}</b></el-checkbox>
          <p v-if="g.scene.goal" class="muted">{{ g.scene.goal }}</p>
          <div v-for="e in g.rows" :key="e.req.code" class="approval-linked"><span class="record-code">{{ e.req.code }} · {{ e.role }}</span><div>{{ e.req.text }}</div></div>
          <div v-if="g.constraints.length" class="muted">同时适用的共性约束：</div>
          <div v-for="e in g.constraints" :key="e.req.code" class="approval-linked"><span class="record-code">{{ e.req.code }}</span> {{ e.req.text }}</div>
          <p v-if="g.missing.length" class="stale">关联已失效：{{ g.missing.join('、') }}。请先调整场景关联。</p>
          <p v-if="g.needsUpdate" class="stale">{{ g.scene.review_reason || '关联需求已变化，请核对以上最新内容。' }}</p>
        </section>
      </el-checkbox-group>
      <details v-if="otherRequirements.length" open><summary>其他要求（{{ otherRequirements.length }}）</summary><p class="muted">交付、商务、共性约束及未纳入所选场景的要求。只勾选本轮需要交接的内容。</p>
        <el-checkbox-group v-model="extraReqs" class="approval-list" :disabled="sending"><el-checkbox v-for="r in otherRequirements" :key="r.code" :value="r.code"><b>{{ r.code }}</b> {{ r.text }} <small>（{{ r.category }}）</small></el-checkbox></el-checkbox-group>
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
