import { computed, defineComponent, inject, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call } from "../../api.js";
import { SCENARIO_FIELD_LABELS, scenarioFieldLabel, questionStatusLabel, requirementStatusLabel, originLabel } from "../../ui.js";
import { questionLinkLabel } from "../../understanding.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const empty = () => ({ name: "", goal: "", actors: [], context: "", trigger: "", activities: [], outcomes: [], boundaries: [], assumptions: [], links: [], evidence: [], supersedes: [] });
const textFields = { goal: "业务目标", context: "时间、地点与条件", trigger: "触发条件" };
const arrayFields = { actors: "参与角色", outcomes: "预期结果与验收条件", boundaries: "范围、约束与依赖" };
const dispositions = ["场景关联", "跨场景约束", "交付与服务", "商务与资质", "背景", "范围外", "待归类"];
const typeOf = (status) => ({ 已确认: "success", 待复核: "warning", 已归档: "info", 待确认: "primary" })[status];

const ScenarioForm = defineComponent({
  props: ["draft", "requirements", "sources"],
  setup() {
    const evidenceFields = (draft) => [...Object.keys(SCENARIO_FIELD_LABELS), ...draft.activities.map((_, i) => `activities.${i}.text`), ...draft.outcomes.map((_, i) => `outcomes.${i}`), ...draft.boundaries.map((_, i) => `boundaries.${i}`)];
    const removeActivity = (draft, index) => {
      draft.activities.splice(index, 1);
      draft.evidence = draft.evidence.filter((e) => !e.field_path.startsWith(`activities.${index}.`)).map((e) => {
        const match = e.field_path.match(/^activities\.(\d+)(.*)$/);
        return match && Number(match[1]) > index ? { ...e, field_path: `activities.${Number(match[1]) - 1}${match[2]}` } : e;
      });
    };
    return { textFields, arrayFields, scenarioFieldLabel, evidenceFields, removeActivity };
  },
  template: `
  <el-form label-position="top">
    <el-form-item label="场景名称"><el-input v-model="draft.name" placeholder="角色在什么条件下完成什么业务目标" /></el-form-item>
    <el-form-item v-for="(label, field) in textFields" :key="field" :label="label"><el-input v-model="draft[field]" type="textarea" :rows="2" placeholder="材料未明确时留空" /></el-form-item>
    <el-form-item v-for="(label, field) in arrayFields" :key="field" :label="label + '（每行一项）'">
      <el-input :model-value="draft[field].join('\\n')" @update:model-value="(v) => draft[field] = v.split('\\n').filter((s) => s.trim())" type="textarea" :rows="2" />
    </el-form-item>
    <el-divider>具体要求与活动</el-divider>
    <div v-for="(link, n) in draft.links" :key="n" class="toolbar">
      <el-select v-model="link.req_id" filterable style="flex:1" placeholder="选择原始需求"><el-option v-for="r in requirements" :key="r.code" :value="r.code" :label="r.code + ' ' + r.text" /></el-select>
      <el-select v-model="link.role" style="width:125px"><el-option v-for="role in ['核心要求', '支撑要求', '适用约束']" :key="role" :value="role" /></el-select>
      <el-button link type="danger" @click="draft.links.splice(n, 1)">移除</el-button>
    </div>
    <el-button size="small" @click="draft.links.push({ req_id: '', role: '核心要求' })">关联原始需求</el-button>
    <el-form-item v-for="(a, n) in draft.activities" :key="n" :label="'活动 ' + (n + 1)">
      <el-input v-model="a.text" placeholder="业务活动" />
      <el-select v-model="a.req_ids" multiple style="width:100%;margin-top:6px" placeholder="这项活动依据哪些已关联需求"><el-option v-for="l in draft.links.filter((l) => l.req_id)" :key="l.req_id" :value="l.req_id" :label="l.req_id" /></el-select>
      <el-button link type="danger" @click="removeActivity(draft, n)">移除活动</el-button>
    </el-form-item>
    <el-button size="small" @click="draft.activities.push({ text: '', req_ids: [] })">添加业务活动</el-button>
    <el-divider>分析推断与原文依据</el-divider>
    <div class="muted">仅为分析推断的内容填在这里，不要写成客户已经确定的要求。</div>
    <div v-for="(a, n) in draft.assumptions" :key="n" style="margin:8px 0">
      <el-input v-model="a.text" placeholder="推断内容" /><el-input v-model="a.reason" placeholder="推断理由" />
      <el-button link type="danger" @click="draft.assumptions.splice(n, 1)">移除推断</el-button>
    </div>
    <el-button size="small" @click="draft.assumptions.push({ text: '', reason: '' })">添加推断</el-button>
    <div v-for="(e, n) in draft.evidence" :key="n" class="chunk" style="margin-top:12px">
      <template v-if="e.kind === 'answer'"><div>澄清 Q{{ e.question_id }} · {{ scenarioFieldLabel(e.field_path) }}</div><blockquote>{{ e.quote }}</blockquote></template>
      <template v-else>
        <el-select v-model="e.field_path" placeholder="这段原文支持哪项描述"><el-option v-for="path in evidenceFields(draft)" :key="path" :value="path" :label="scenarioFieldLabel(path)" /></el-select>

        <el-select v-model="e.seg_uid" filterable placeholder="原文片段" style="width:100%;margin:6px 0"><el-option v-for="s in sources" :key="s.uid" :value="s.uid" :label="s.uid + ' ' + s.text.slice(0, 70)" /></el-select>
        <el-input v-model="e.quote" type="textarea" placeholder="连续复制的原文引用，保存时逐字核对" />
      </template>
      <el-button link type="danger" @click="draft.evidence.splice(n, 1)">移除当前引用</el-button>
    </div>
    <el-button size="small" style="margin-top:8px" @click="draft.evidence.push({ field_path: 'goal', seg_uid: '', quote: '' })">添加原文依据</el-button>
  </el-form>`,
});

export default defineComponent({
  components: { ScenarioForm },
  setup() {
    const { id, view, reload } = inject("project");
    const { open, focus } = inject("workspace");
    const filter = ref("active");
    const pane = ref("scenes");
    const selected = ref([]);
    const detailCode = ref(null);
    const editing = ref(null);
    const dispositionEdit = ref(null);
    const historyRows = ref([]);
    const detail = computed(() => view.value.scenarios.find((s) => s.code === detailCode.value));
    const rows = computed(() => view.value.scenarios.filter((s) => filter.value === "all" || (filter.value === "active" ? s.status !== "已归档" : s.status === filter.value)));
    const requirements = computed(() => view.value.requirements.filter((r) => r.status !== "已删除" && r.category !== "范围外"));
    const sources = computed(() => view.value.sourceSnapshots.filter((s) => s.active));
    const mergeCandidates = computed(() => rows.value.filter(s => s.status !== "已归档" && selected.value.some(row => row.code === s.code)));
    const canSave = computed(() => editing.value?.parts.every(d => d.name.trim() && d.links.some(l => requirements.value.some(r => r.code === l.req_id))));
    const req = (code) => view.value.requirements.find((r) => r.code === code);
    watch(() => focus.value, (code) => { if (typeof code === "string" && code.startsWith("SC")) detailCode.value = code; }, { immediate: true });
    watch(detailCode, () => { historyRows.value = []; });

    const startEdit = (scene) => { editing.value = { mode: scene ? "edit" : "add", originals: scene ? [{ code: scene.code, revision: scene.revision }] : [], parts: [clone(scene ?? empty())] }; };
    const confirm = async (scene) => {
      if (await call(() => api(`/projects/${id}/scenarios/confirm`, { method: "POST", body: { scenarios: [{ code: scene.code, revision: scene.revision }] } }), "已确认当前版本，未解决问题仍会保留")) await reload();
    };
    const archive = async (scene) => {
      const { value } = await ElMessageBox.prompt("归档原因（历史记录与原文会保留）", "归档场景", { inputPattern: /\S/, inputErrorMessage: "请填写原因" });
      if (await call(() => api(`/projects/${id}/scenarios/${scene.code}`, { method: "PUT", body: { revision: scene.revision, status: "已归档", reason: value } }), "已归档")) await reload();
    };
    const restore = async (scene) => {
      if (await call(() => api(`/projects/${id}/scenarios/${scene.code}`, { method: "PUT", body: { revision: scene.revision, status: "待确认", reason: "恢复场景，重新审阅" } }))) await reload();
    };
    const merge = () => {
      const originals = mergeCandidates.value;
      if (originals.length < 2) return;
      const data = empty();
      data.name = originals.map((s) => s.name).join("与");
      for (const field of ["goal", "context", "trigger"]) data[field] = originals.map((s) => s[field]).filter(Boolean).join("；");
      for (const field of ["actors", "outcomes", "boundaries"]) data[field] = [...new Set(originals.flatMap((s) => s[field]))];
      for (const field of ["activities", "assumptions"]) data[field] = clone(originals.flatMap((s) => s[field]));
      data.links = [...new Map(originals.flatMap((s) => s.links).map((l) => [l.req_id, clone(l)])).values()];
      data.evidence = clone(originals.flatMap((s) => s.evidence)).map((e) => e.kind === "answer" ? e : ({ ...e, field_path: e.field_path.replace(/\.\d+.*$/, "") }));
      editing.value = { mode: "merge", originals: originals.map((s) => ({ code: s.code, revision: s.revision })), parts: [data] };
    };
    const split = (scene) => {
      const first = clone(scene), second = clone(scene);
      first.name += "（分组一）"; second.name += "（分组二）";
      editing.value = { mode: "split", originals: [{ code: scene.code, revision: scene.revision }], parts: [first, second] };
    };
    const save = async () => {
      if (!canSave.value) return;
      const e = editing.value;
      let path, body, method = "POST";
      if (e.mode === "edit") { path = `/scenarios/${e.originals[0].code}`; body = { ...e.parts[0], revision: e.originals[0].revision, status: "待确认" }; method = "PUT"; }
      else if (e.mode === "add") { path = "/scenarios"; body = e.parts[0]; }
      else { path = "/scenarios/merge"; body = { originals: e.originals, replacements: e.parts }; }
      if (await call(() => api(`/projects/${id}${path}`, { method, body }), "已保存草稿，请审阅后确认")) { editing.value = null; selected.value = []; await reload(); }
    };
    const saveDisposition = async () => {
      const d = dispositionEdit.value;
      if (await call(() => api(`/projects/${id}/requirements/${d.req_id}/disposition`, { method: "PUT", body: d }), "要求归类已保存")) { dispositionEdit.value = null; await reload(); }
    };
    const history = async () => { const result = await call(() => api(`/projects/${id}/scenarios/${detailCode.value}`)); if (result) historyRows.value = result.revisions; };
    return { view, scenarioFieldLabel, questionStatusLabel, questionLinkLabel, requirementStatusLabel, originLabel, open, pane, filter, rows, selected, mergeCandidates, canSave, detailCode, detail, editing, dispositionEdit, historyRows, requirements, sources, req, typeOf, dispositions, clone, empty, textFields, arrayFields, startEdit, confirm, archive, restore, merge, split, save, saveDisposition, history };
  },
  template: `
  <el-alert :closable="false" type="info" title="按客户要完成的工作组织需求。主体明确、细节待澄清的要求也可以形成场景草稿，描述确认与问题解决分别记录。" style="margin-bottom:12px" />
  <div class="toolbar">
    <el-radio-group v-model="pane" size="small"><el-radio-button value="scenes">业务场景</el-radio-button><el-radio-button value="dispositions">要求归类与适用范围 {{ view.scenarioCoverage.classified }}/{{ view.scenarioCoverage.total }}</el-radio-button></el-radio-group>
    <span style="flex:1"></span>
    <el-button size="small" :disabled="!requirements.length" @click="startEdit(null)">新增场景</el-button>
  </div>
  <el-alert v-for="note in view.scenarioNotes" :key="note" :title="note" :closable="false" type="warning" style="margin-bottom:8px" />
  <template v-if="pane === 'scenes'">
    <div class="toolbar">
      <el-select v-model="filter" size="small" style="width:150px"><el-option label="当前场景" value="active" /><el-option v-for="s in ['待确认', '已确认', '待复核', '已归档']" :key="s" :value="s" :label="requirementStatusLabel(s)" /><el-option label="全部含历史" value="all" /></el-select>
      <el-button size="small" :disabled="mergeCandidates.length < 2" @click="merge">合并所选（{{ mergeCandidates.length }}）</el-button>
      <span class="muted">人工编辑和确认内容会保留。部署、安全、服务等要求可单独归类，无需全部形成业务场景。</span>
    </div>
    <el-table :data="rows" row-key="code" @selection-change="(v) => selected = v" empty-text="尚未建立业务场景，可使用上方理解材料入口逐步完善，或手动新增">
      <el-table-column type="selection" width="38" :selectable="(s) => s.status !== '已归档'" />
      <el-table-column label="编号" prop="code" width="70" />
      <el-table-column label="场景、目标与活动" min-width="280"><template #default="{ row }"><el-button link type="primary" @click="detailCode = row.code">{{ row.name }}</el-button><div>{{ row.goal || '业务目标未明确' }}</div><div v-if="row.context" class="muted">{{ row.context }}</div><div v-for="(a, n) in row.activities.slice(0, 2)" :key="n" class="muted">{{ n + 1 }}. {{ a.text }}</div><el-button v-if="row.open_questions.length" link type="warning" @click="open('questions', row.open_questions[0])">{{ row.open_questions.length }} 项待澄清</el-button></template></el-table-column>
      <el-table-column label="关联要求" width="75"><template #default="{ row }">{{ row.links.length }}</template></el-table-column>
      <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="typeOf(row.status)">{{ requirementStatusLabel(row.status) }}</el-tag><div class="muted">版本 {{ row.revision }}</div></template></el-table-column>
      <el-table-column label="待澄清" width="70"><template #default="{ row }">{{ row.open_questions.length }}</template></el-table-column>
      <el-table-column label="操作" width="140"><template #default="{ row }"><el-button v-if="row.status !== '已归档'" link @click="startEdit(row)">修改</el-button><el-button v-if="!['已确认', '已归档'].includes(row.status)" link type="success" @click="confirm(row)">确认描述</el-button><el-button v-if="row.status !== '已归档'" link @click="split(row)">拆分</el-button><el-button v-if="row.status === '已归档'" link @click="restore(row)">恢复</el-button></template></el-table-column>
    </el-table>
  </template>
  <el-table v-else :data="view.dispositions" row-key="req_id">
    <el-table-column label="原始需求" min-width="280"><template #default="{ row }"><b>{{ row.req_id }}</b> {{ req(row.req_id)?.text }}</template></el-table-column>
    <el-table-column label="要求归类" min-width="150"><template #default="{ row }"><el-tag v-for="kind in row.kinds" :key="kind" size="small" :type="kind === '待归类' ? 'warning' : 'info'">{{ kind }}</el-tag><div class="muted">{{ row.note }}</div></template></el-table-column>
    <el-table-column label="关联场景" min-width="125"><template #default="{ row }"><el-button v-for="code in row.linked_scenarios" :key="code" link type="primary" @click="detailCode = code">{{ code }}</el-button><div v-if="row.kinds.includes('跨场景约束')" class="muted">适用：{{ row.scenario_ids.join('、') || '整个项目' }}</div></template></el-table-column>
    <el-table-column label="操作" width="85"><template #default="{ row }"><el-button link @click="dispositionEdit = clone(row)">调整归类</el-button></template></el-table-column>
  </el-table>
  <el-drawer :model-value="!!detail" @close="detailCode = null" :title="detail ? detail.code + ' ' + detail.name : ''" size="960px">
    <template v-if="detail">
      <div class="toolbar"><el-tag :type="typeOf(detail.status)">{{ requirementStatusLabel(detail.status) }}</el-tag><span class="muted">版本 {{ detail.revision }} · {{ originLabel(detail.origin) }}</span><el-button v-if="detail.status !== '已归档'" @click="startEdit(detail)">修改</el-button><el-button v-else @click="restore(detail)">恢复为待审阅</el-button><el-button v-if="detail.status !== '已归档'" link type="danger" @click="archive(detail)">归档</el-button></div>
      <el-alert v-if="detail.review_reason" :title="detail.review_reason" type="warning" :closable="false" />
      <p v-for="issue in detail.issues" :key="issue" class="muted">待核对：{{ issue }}</p>
      <p v-if="detail.supersedes.length">替代场景：{{ detail.supersedes.join('、') }}，原记录和依据保留。</p>
      <el-descriptions :column="1" border>
        <el-descriptions-item v-for="(label, field) in textFields" :key="field" :label="label">{{ detail[field] || '未明确' }}</el-descriptions-item>
        <el-descriptions-item v-for="(label, field) in arrayFields" :key="field" :label="label">{{ detail[field].join('；') || '未明确' }}</el-descriptions-item>
      </el-descriptions>
      <h3>业务活动与具体要求</h3>
      <div v-for="(a, n) in detail.activities" :key="n" class="chunk"><b>{{ n + 1 }}. {{ a.text }}</b><div v-for="code in a.req_ids" :key="code" class="muted">{{ code }} {{ req(code)?.text }}</div></div>
      <div v-for="l in detail.links" :key="l.req_id" class="chunk"><el-tag size="small">{{ l.role }}</el-tag> <b>{{ l.req_id }}</b> {{ req(l.req_id)?.text }} <el-tag v-if="req(l.req_id)?.status === '已删除'" type="warning" size="small">已删除或被替代</el-tag></div>
      <h3>原文与答复依据</h3>
      <div class="muted">引用可定位只说明出处有效，请核对它是否支持对应字段。</div>
      <div v-for="(e, n) in detail.evidence" :key="n" class="chunk"><div class="muted">{{ scenarioFieldLabel(e.field_path) }} · {{ e.material_title || ('澄清 Q' + e.question_id) }} · {{ e.seg_uid || e.answer_source }}</div><blockquote>{{ e.quote }}</blockquote><el-collapse v-if="e.source_text"><el-collapse-item title="查看原文上下文">{{ e.source_text }}</el-collapse-item></el-collapse></div>
      <div v-if="!detail.evidence.length" class="muted">当前为人工描述，尚未关联字段原文。</div>
      <h3>推断与待确认事项</h3>
      <div v-for="(a, n) in detail.assumptions" :key="n" class="chunk"><b>分析推断：</b>{{ a.text }}<div class="muted">{{ a.reason }}</div></div>
      <div v-for="q in view.questions.filter((q) => q.scenario_ids.includes(detail.code))" :key="q.id" class="chunk"><el-tag size="small">{{ questionStatusLabel(q.status) }}</el-tag> {{ q.question }}<div v-if="q.answer">答复：{{ q.answer }}</div><el-button link type="primary" @click="open('questions', q.id)">{{ questionLinkLabel(q) }}</el-button></div>
      <h3>下游 PBS</h3><div v-for="i in view.items.filter((i) => i.scenario_ids.includes(detail.code))" :key="i.id"><el-button link type="primary" @click="open('pbs', i.id)">{{ i.code }} {{ i.name }}</el-button> {{ i.stale }}</div>
      <el-divider /><el-button @click="history">查看修改记录</el-button>
      <el-collapse><el-collapse-item v-for="r in historyRows" :key="r.revision" :title="'版本 ' + r.revision + ' · ' + r.reason"><div>{{ r.at }}</div><div>{{ r.snapshot.name }} · {{ r.snapshot.status }}</div><div>{{ r.snapshot.goal }}</div><div>关联要求：{{ r.snapshot.links.map((l) => l.req_id).join('、') }}</div></el-collapse-item></el-collapse>
    </template>
  </el-drawer>
  <el-dialog :model-value="!!editing" @close="editing = null" :title="editing?.mode === 'split' ? '拆分场景' : editing?.mode === 'merge' ? '合并场景' : editing?.mode === 'add' ? '新增业务场景' : '编辑业务场景'" width="960px">
    <template v-if="editing">
      <el-alert :closable="false" type="info" title="保存后需确认描述。合并或拆分会归档原场景并保留历史，必须关联原场景的全部需求；未知内容可留空。" />
      <div v-for="(draft, n) in editing.parts" :key="n" style="margin-top:16px"><h3 v-if="editing.parts.length > 1">新场景 {{ n + 1 }}</h3><ScenarioForm :draft="draft" :requirements="requirements" :sources="sources" /><el-divider /></div>
      <el-button v-if="editing.mode === 'split'" @click="editing.parts.push(empty())">再增加一个场景</el-button>
    </template>
    <template #footer><span v-if="!canSave" class="muted">每个场景需填写名称并关联有效需求。</span><el-button @click="editing = null">取消</el-button><el-button type="primary" :disabled="!canSave" @click="save">保存草稿</el-button></template>
  </el-dialog>
  <el-dialog :model-value="!!dispositionEdit" @close="dispositionEdit = null" title="调整要求归类与适用范围" width="560px">
    <el-form v-if="dispositionEdit" label-position="top"><p>{{ req(dispositionEdit.req_id)?.text }}</p><el-form-item label="要求归类"><el-select v-model="dispositionEdit.kinds" multiple style="width:100%"><el-option v-for="kind in dispositions" :key="kind" :value="kind" /></el-select></el-form-item><el-form-item label="跨场景约束适用范围（留空表示整个项目）"><el-select v-model="dispositionEdit.scenario_ids" multiple style="width:100%"><el-option v-for="s in view.scenarios.filter((s) => s.status !== '已归档')" :key="s.code" :value="s.code" :label="s.code + ' ' + s.name" /></el-select></el-form-item><el-form-item label="说明"><el-input v-model="dispositionEdit.note" type="textarea" /></el-form-item></el-form>
    <template #footer><el-button @click="dispositionEdit = null">取消</el-button><el-button type="primary" @click="saveDisposition">保存</el-button></template>
  </el-dialog>
  `,
});
