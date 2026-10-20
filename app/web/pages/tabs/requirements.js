import { computed, defineComponent, inject, nextTick, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, meta } from "../../api.js";
import { highlight, TIER_TYPE, REVIEW_HELP, reviewLabel, requirementStatusLabel } from "../../ui.js";
import { questionPending, questionsForRequirement } from "../../understanding.js";

export default defineComponent({
  setup() {
    const { id, view, reload } = inject("project");
    const { open, focus } = inject("workspace");
    const filter = ref({ status: "", tier: "", category: "", kw: "", needsClarification: false });
    const selected = ref([]);
    const source = ref(null);
    const editing = ref(null);
    const adding = ref(null);
    const paramEdit = ref(null);
    const relatedQuestions = computed(() => new Map(view.value.requirements.map((r) => [r.code, questionsForRequirement(r, view.value.questions)])));
    const pendingQuestions = (r) => (relatedQuestions.value.get(r.code) ?? []).filter(questionPending);
    const openQuestions = r => open("questions", { requirementCode: r.code });

    const segByUid = computed(() => new Map([...view.value.sourceSnapshots, ...view.value.segments].map((s) => [s.uid, s])));
    const rows = computed(() =>
      view.value.requirements.filter((r) => {
        const f = filter.value;
        if (f.status && r.status !== f.status) return false;
        if (!f.status && r.status === "已删除") return false;
        if (f.needsClarification && !pendingQuestions(r).length) return false;
        if (f.tier && r.review !== f.tier) return false;
        if (f.category && r.category !== f.category) return false;
        if (f.kw && !r.text.includes(f.kw)) return false;
        return true;
      }),
    );
    const selectedCodes = computed(() => rows.value.filter(r => r.status === "待确认" && selected.value.some(s => s.code === r.code)).map(r => r.code));
    const counts = computed(() => {
      const c = { 待确认: 0, 已确认: 0, 已删除: 0 };
      view.value.requirements.forEach((r) => (c[r.status] = (c[r.status] ?? 0) + 1));
      return c;
    });
    const usedParams = computed(() => {
      const rejected = new Set(view.value.requirements.filter((r) => r.status !== "已删除").flatMap((r) => r.rejected_params.map((p) => p.name)));
      return view.value.params.filter((p) => p.value !== null || p.candidates.length || rejected.has(p.name));
    });

    const segLabel = (r) => {
      const s = segByUid.value.get(r.seg_uid);
      return s ? `材料${s.material_no} · ${s.seg_id}` : r.source_note || r.origin;
    };
    const openSource = (r) => {
      const s = segByUid.value.get(r.seg_uid);
      if (!s) return;
      const siblings = [...view.value.sourceSnapshots].filter((x) => x.material_no === s.material_no);
      const i = siblings.findIndex(x => x.uid === s.uid);
      source.value = { req: r, seg: s, context: i < 0 ? [s] : siblings.slice(Math.max(0, i - 2), i + 3) };
    };
    watch(() => focus.value, async (code) => {
      const r = view.value.requirements.find((r) => r.code === code);
      if (!r) return;
      filter.value = { status: r.status === "已删除" ? "已删除" : "", tier: "", category: "", kw: "", needsClarification: false };
      await nextTick();
      document.getElementById(`requirement-${r.code}`)?.scrollIntoView({ block: "nearest" });
    }, { immediate: true });

    const confirm = async (codes) => {
      if (!codes.length) return;
      await call(() => api(`/projects/${id}/requirements/confirm`, { method: "POST", body: { codes } }), `已确认 ${codes.length} 条需求描述`);
      selected.value = [];
      reload();
    };

    const save = async () => {
      const r = editing.value;
      if (await call(() => api(`/projects/${id}/requirements/${r.code}`, { method: "PUT", body: { text: r.text, category: r.category, priority: r.priority } }), "已保存，请重新核对描述")) { editing.value = null; reload(); }
    };
    const remove = async (r) => {
      const { value: reason } = await ElMessageBox.prompt(`删除 ${r.code}「${r.text}」的原因`, "删除需求", { inputPattern: /\S/, inputErrorMessage: "请填写原因", confirmButtonText: "删除" });
      await call(() => api(`/projects/${id}/requirements/${r.code}`, { method: "PUT", body: { status: "已删除", reason } }), "已删除，可在“已删除”中恢复");
      reload();
    };
    const restore = async (r) => {
      await call(() => api(`/projects/${id}/requirements/${r.code}`, { method: "PUT", body: { status: "待确认" } }), "已恢复");
      reload();
    };
    const add = async () => {
      const ok = await call(() => api(`/projects/${id}/requirements`, { method: "POST", body: adding.value }), "已新增");
      if (ok) {
        adding.value = null;
        reload();
      }
    };
    const saveParam = async (value) => {
      if (await call(() => api(`/projects/${id}/params/${paramEdit.value.name}`, { method: "PUT", body: { value } }), "已更新取值方式，相关自动数量已重新计算")) { paramEdit.value = null; reload(); }
    };

    return { view, filter, rows, counts, selected, selectedCodes, source, editing, adding, paramEdit, usedParams, meta, open, focus, openQuestions, pendingQuestions, segByUid, segLabel, openSource, confirm, save, remove, restore, add, saveParam, highlight, TIER_TYPE, REVIEW_HELP, reviewLabel, requirementStatusLabel };
  },
  template: `
  <div v-if="!view.requirements.length" class="empty">
    还没有需求条目。<el-button link type="primary" @click="open('materials')">去添加材料并开始理解</el-button>，或
    <el-button link type="primary" @click="adding = { text: '', category: '功能', priority: '重要', source_note: '' }">手动新增一条</el-button>
  </div>
  <template v-else>
    <div v-if="usedParams.length" class="understanding-params">
        <div class="l">测算参数 <span class="muted">（点击修改）</span></div>
        <div class="param-list">
          <button v-for="p in usedParams" :key="p.name" class="param" :class="{ unconfirmed: !p.confirmed }" :aria-label="'核对测算参数：' + p.label" @click="paramEdit = { ...p, input: p.value }">
            {{ p.label }} <b>{{ p.value ?? '待确认' }}</b>{{ p.value === null ? '' : p.unit }}<em>{{ p.status === '缺失' ? '暂无可用值' : p.status }}</em>
          </button>
          <span v-if="!usedParams.length" class="muted">没有识别到测算参数</span>
        </div>
    </div>

    <div class="toolbar">
      <el-radio-group v-model="filter.status" size="small">
        <el-radio-button value="">当前需求</el-radio-button>
        <el-radio-button value="待确认">待审阅 {{ counts['待确认'] }}</el-radio-button>
        <el-radio-button value="已确认">描述已确认 {{ counts['已确认'] }}</el-radio-button>
        <el-radio-button value="已删除">已删除 {{ counts['已删除'] || 0 }}</el-radio-button>
      </el-radio-group>
      <el-select v-model="filter.tier" placeholder="核对提示" clearable size="small" style="width:120px">
        <el-option v-for="t in ['必审', '抽检', '批量确认']" :key="t" :value="t" :label="reviewLabel(t)" />
      </el-select>
      <el-select v-model="filter.category" placeholder="类别" clearable size="small" style="width:110px">
        <el-option v-for="c in meta.categories" :key="c" :value="c" :label="c" />
      </el-select>
      <el-input v-model="filter.kw" placeholder="搜索" clearable size="small" style="width:160px" />
      <el-checkbox v-model="filter.needsClarification">有关联待处理问题</el-checkbox>
      <span style="flex:1"></span>
      <el-button size="small" :disabled="!selectedCodes.length" @click="confirm(selectedCodes)">确认所选描述（{{ selectedCodes.length }}）</el-button>
      <el-button size="small" @click="adding = { text: '', category: '功能', priority: '重要', source_note: '' }">新增需求</el-button>
    </div>

    <el-card shadow="never" body-style="padding:0">
      <el-table :data="rows" @selection-change="(v) => (selected = v)" row-key="code" empty-text="没有符合条件的需求">
        <el-table-column type="selection" width="38" :selectable="(r) => r.status === '待确认'" />
        <el-table-column label="编号" prop="code" width="66" />
        <el-table-column label="需求" min-width="320">
          <template #default="{ row }">
            <span :id="'requirement-' + row.code" :class="{ deleted: row.status === '已删除', 'requirement-focus': focus === row.code }">{{ row.text }}</span>
            <div v-if="row.status !== '已删除'" class="requirement-state">
              <span class="requirement-review" :class="{ confirmed: row.status === '已确认' }">{{ row.status === '已确认' ? '描述已确认' : '描述待审阅' }}</span>
              <el-button v-if="pendingQuestions(row).length" link type="warning" @click="openQuestions(row)">查看关联问题（{{ pendingQuestions(row).length }}）</el-button>
            </div>
            <el-tooltip v-if="row.star || row.triangle" content="材料中的重点标记，具体含义及响应要求以该招标文件说明为准。"><el-tag :type="row.star ? 'danger' : 'warning'" size="small" effect="plain">{{ row.star ? '★' : '▲' }} 标注条款</el-tag></el-tooltip>
            <el-tag v-if="row.inferred" type="warning" size="small">推断</el-tag>
            <el-tag v-if="row.origin !== '系统'" type="primary" size="small">{{ row.origin }}</el-tag>
            <el-tag v-if="row.edited" size="small" type="info">已修改</el-tag>
            <div v-if="row.status === '已删除'" class="muted">删除原因：{{ row.delete_reason }}</div>
            <div v-if="row.params.length || row.rejected_params.length" class="muted">
              <code v-for="p in row.params" :key="p.name">{{ p.label }}={{ p.value }}</code>
              <div v-for="p in row.rejected_params" :key="'x' + p.name" class="param-not-used"><b>{{ p.label }}={{ p.value }}{{ p.unit }} · 未用于数量测算</b><div v-if="p.quote">参数引用：“{{ p.quote }}”</div><div>{{ p.reason }}。请核对原文，必要时在“测算参数”中指定确认值；不影响本条需求保留。</div></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="150">
          <template #default="{ row }">
            <el-button v-if="segByUid.has(row.seg_uid)" link type="primary" @click="openSource(row)">{{ segLabel(row) }}</el-button>
            <span v-else class="muted">{{ segLabel(row) }}</span>
            <div v-if="row.seg_uid && !row.quote_verified" class="muted" style="color:#b42318">原文引用待核对</div>
          </template>
        </el-table-column>
        <el-table-column label="类别" prop="category" width="64" />
        <el-table-column label="优先级" prop="priority" width="70" />
        <el-table-column label="核对提示" width="100">
          <template #default="{ row }"><el-tooltip v-if="row.review && row.status === '待确认'" :content="REVIEW_HELP[row.review]"><el-tag :type="TIER_TYPE[row.review]" size="small" effect="plain">{{ reviewLabel(row.review) }}</el-tag></el-tooltip><span v-else class="muted">{{ requirementStatusLabel(row.status) }}</span></template>
        </el-table-column>
        <el-table-column label="场景与要求归类" width="150"><template #default="{ row }"><el-button v-for="code in row.scenario_ids" :key="code" link type="primary" @click="open('scenarios', code)">{{ code }}</el-button><div class="muted">{{ row.disposition?.kinds.join('、') || '尚未归类' }}</div></template></el-table-column>
        <el-table-column label="承接 PBS" width="110">
          <template #default="{ row }">
            <el-tag v-for="c in row.leaves" :key="c" size="small" type="info">{{ c }}</el-tag>
            <span v-if="!row.leaves.length && view.items.length && row.deliverable && row.status !== '已删除'" class="muted">尚未关联</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <div class="ops">
              <el-button v-if="row.status === '已删除'" link type="primary" @click="restore(row)">恢复</el-button>
              <template v-else>
                <el-button v-if="row.status === '待确认'" link type="success" @click="confirm([row.code])">确认描述</el-button>
                <el-button link type="primary" @click="editing = { ...row }">修改</el-button>
                <el-button link type="danger" @click="remove(row)">删除</el-button>
              </template>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </template>

  <el-drawer :model-value="!!source" @close="source = null" title="原文" size="45%">
    <template v-if="source">
      <div class="muted">材料{{ source.seg.material_no }}「{{ source.seg.material_title }}」{{ source.seg.chapter ? ' · ' + source.seg.chapter : '' }}</div>
      <div v-for="s in source.context" :key="s.uid" class="seg-line" :class="{ hit: s.uid === source.seg.uid }">
        <span class="id">{{ s.seg_id }}</span><span v-html="s.uid === source.seg.uid ? highlight(s.text, source.req.quote_verified ? source.req.quote : '') : highlight(s.text)"></span>
      </div>
      <el-divider />
      <div><b>{{ source.req.code }}</b> {{ source.req.text }}</div>
      <div class="muted" style="margin-top:6px">{{ source.req.quote_verified ? '高亮引用可在原文定位；请继续核对需求描述是否准确。' : '尚无可逐字定位的引用，请对照原文核对需求描述。' }}</div>
    </template>
  </el-drawer>

  <el-dialog :model-value="!!editing" @close="editing = null" title="修改需求" width="560px">
    <el-form v-if="editing" label-width="64px">
      <el-form-item label="内容"><el-input v-model="editing.text" type="textarea" :rows="3" /></el-form-item>
      <el-form-item label="类别"><el-select v-model="editing.category"><el-option v-for="c in meta.categories" :key="c" :value="c" :label="c" /></el-select></el-form-item>
      <el-form-item label="优先级"><el-radio-group v-model="editing.priority"><el-radio-button v-for="p in ['必须', '重要', '一般']" :key="p" :value="p">{{ p }}</el-radio-button></el-radio-group></el-form-item>
    </el-form>
    <div class="muted">修改内容后需重新确认描述。人工修改会保留，相关 PBS 项会提示复核。</div>
    <template #footer><el-button @click="editing = null">取消</el-button><el-button type="primary" :disabled="!editing?.text.trim()" @click="save">保存</el-button></template>
  </el-dialog>

  <el-dialog :model-value="!!adding" @close="adding = null" title="新增需求" width="560px">
    <el-form v-if="adding" label-width="64px">
      <el-form-item label="内容"><el-input v-model="adding.text" type="textarea" :rows="3" /></el-form-item>
      <el-form-item label="类别"><el-select v-model="adding.category"><el-option v-for="c in meta.categories" :key="c" :value="c" :label="c" /></el-select></el-form-item>
      <el-form-item label="优先级"><el-radio-group v-model="adding.priority"><el-radio-button v-for="p in ['必须', '重要', '一般']" :key="p" :value="p">{{ p }}</el-radio-button></el-radio-group></el-form-item>
      <el-form-item label="来源"><el-input v-model="adding.source_note" placeholder="例如：客户电话确认、现场调研" /></el-form-item>
    </el-form>
    <div class="muted">人工新增会记为“描述已确认”；原文依据与澄清事项仍需单独核对。</div>
    <template #footer><el-button @click="adding = null">取消</el-button><el-button type="primary" :disabled="!adding?.text.trim()" @click="add">新增并确认描述</el-button></template>
  </el-dialog>

  <el-dialog :model-value="!!paramEdit" @close="paramEdit = null" :title="'测算参数：' + (paramEdit?.label ?? '')" width="480px">
    <template v-if="paramEdit">
      <div class="muted" style="margin-bottom:8px">当前取值：{{ paramEdit.value === null ? '暂无可用数值' : paramEdit.value + paramEdit.unit + '（' + paramEdit.status + '）' }}</div>
      <div v-for="c in paramEdit.candidates" :key="c.req_id" class="muted">{{ c.req_id }}：“{{ c.quote }}” → {{ c.value }}</div>
      <div class="row" style="margin-top:12px"><el-input-number v-model="paramEdit.input" :controls="false" /> {{ paramEdit.unit }}</div>
      <div class="muted" style="margin-top:8px">人工设定的值优先于材料中的数字，用到该参数的自动数量会重新计算；人工指定的数量保留。取消指定会重新按来源、推算或默认值取值，可能仍需确认。</div>
    </template>
    <template #footer>
      <el-button @click="paramEdit = null">取消</el-button>
      <el-button v-if="['客户确认', '人工设定'].includes(paramEdit?.status)" title="取消指定后重新按来源、推算或默认值取值，可能仍需确认" @click="saveParam(null)">取消指定值</el-button>
      <el-button type="primary" :disabled="!Number.isFinite(paramEdit?.input)" @click="saveParam(paramEdit.input)">确认并使用此值</el-button>
    </template>
  </el-dialog>`,
});
