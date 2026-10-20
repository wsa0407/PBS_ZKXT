import { computed, defineComponent, inject, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, meta } from "../../api.js";
import { highlight, TIER_TYPE } from "../../ui.js";
import Questions from "./questions.js";
import { questionPending, questionsForRequirement } from "../../understanding.js";

export default defineComponent({
  components: { Questions },
  setup() {
    const { id, view, reload } = inject("project");
    const { open, focus } = inject("workspace");
    const filter = ref({ status: "", tier: "", category: "", kw: "", needsClarification: false });
    const selected = ref([]);
    const source = ref(null);
    const editing = ref(null);
    const adding = ref(null);
    const paramEdit = ref(null);
    const clarifying = ref(null);
    const clarifiedRequirement = computed(() => view.value.requirements.find((r) => r.code === clarifying.value));
    const relatedQuestions = computed(() => new Map(view.value.requirements.map((r) => [r.code, questionsForRequirement(r, view.value.questions)])));
    const pendingQuestions = (r) => (relatedQuestions.value.get(r.code) ?? []).filter(questionPending);

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
    const counts = computed(() => {
      const c = { 待确认: 0, 已确认: 0, 已删除: 0 };
      view.value.requirements.forEach((r) => (c[r.status] = (c[r.status] ?? 0) + 1));
      return c;
    });
    const usedParams = computed(() => view.value.params.filter((p) => p.value !== null || p.candidates.length));

    const segLabel = (r) => {
      const s = segByUid.value.get(r.seg_uid);
      return s ? `材料${s.material_no} · ${s.seg_id}` : r.source_note || r.origin;
    };
    const openSource = (r) => {
      const s = segByUid.value.get(r.seg_uid);
      if (!s) return;
      const siblings = [...view.value.sourceSnapshots].filter((x) => x.material_no === s.material_no);
      const i = siblings.indexOf(s);
      source.value = { req: r, seg: s, context: siblings.slice(Math.max(0, i - 2), i + 3) };
    };
    watch(() => focus.value, (code) => {
      const r = view.value.requirements.find((r) => r.code === code);
      if (!r) return;
      filter.value = { status: r.status === "已删除" ? "已删除" : "", tier: "", category: "", kw: "", needsClarification: false };
      if (r.seg_uid) openSource(r);
      else clarifying.value = r.code;
    }, { immediate: true });

    const confirm = async (codes) => {
      if (!codes.length) return;
      await call(() => api(`/projects/${id}/requirements/confirm`, { method: "POST", body: { codes } }), `已确认 ${codes.length} 条`);
      selected.value = [];
      reload();
    };
    const confirmBatchable = () => confirm(view.value.requirements.filter((r) => r.status === "待确认" && r.review === "批量确认").map((r) => r.code));

    const save = async () => {
      const r = editing.value;
      await call(() => api(`/projects/${id}/requirements/${r.code}`, { method: "PUT", body: { text: r.text, category: r.category, priority: r.priority } }), "已保存");
      editing.value = null;
      reload();
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
      await call(() => api(`/projects/${id}/params/${paramEdit.value.name}`, { method: "PUT", body: { value } }), "已更新，相关数量已重算");
      paramEdit.value = null;
      reload();
    };

    return { view, filter, rows, counts, selected, source, editing, adding, paramEdit, usedParams, meta, open, clarifying, clarifiedRequirement, pendingQuestions, segLabel, openSource, confirm, confirmBatchable, save, remove, restore, add, saveParam, highlight, TIER_TYPE };
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
          <span v-for="p in usedParams" :key="p.name" class="param" :class="{ unconfirmed: !p.confirmed }" @click="paramEdit = { ...p, input: p.value }">
            {{ p.label }} <b>{{ p.value ?? '?' }}</b>{{ p.unit }}<em>{{ p.status }}</em>
          </span>
          <span v-if="!usedParams.length" class="muted">没有识别到测算参数</span>
        </div>
    </div>

    <div class="toolbar">
      <el-radio-group v-model="filter.status" size="small">
        <el-radio-button value="">全部有效</el-radio-button>
        <el-radio-button value="待确认">待审阅 {{ counts['待确认'] }}</el-radio-button>
        <el-radio-button value="已确认">描述已确认 {{ counts['已确认'] }}</el-radio-button>
        <el-radio-button value="已删除">已删除 {{ counts['已删除'] || 0 }}</el-radio-button>
      </el-radio-group>
      <el-select v-model="filter.tier" placeholder="审核分级" clearable size="small" style="width:120px">
        <el-option v-for="t in ['必审', '抽检', '批量确认']" :key="t" :value="t" :label="t" />
      </el-select>
      <el-select v-model="filter.category" placeholder="类别" clearable size="small" style="width:110px">
        <el-option v-for="c in meta.categories" :key="c" :value="c" :label="c" />
      </el-select>
      <el-input v-model="filter.kw" placeholder="搜索" clearable size="small" style="width:160px" />
      <el-checkbox v-model="filter.needsClarification">只看仍需澄清</el-checkbox>
      <span style="flex:1"></span>
      <el-button size="small" :disabled="!selected.length" @click="confirm(selected.map((r) => r.code))">确认所选（{{ selected.length }}）</el-button>
      <el-button size="small" type="success" plain @click="confirmBatchable">一键确认“批量确认”级</el-button>
      <el-button size="small" @click="adding = { text: '', category: '功能', priority: '重要', source_note: '' }">新增需求</el-button>
    </div>

    <el-card shadow="never" body-style="padding:0">
      <el-table :data="rows" @selection-change="(v) => (selected = v)" row-key="code" empty-text="没有符合条件的需求">
        <el-table-column type="selection" width="38" :selectable="(r) => r.status === '待确认'" />
        <el-table-column label="编号" prop="code" width="66" />
        <el-table-column label="需求" min-width="320">
          <template #default="{ row }">
            <span :class="{ deleted: row.status === '已删除' }">{{ row.text }}</span>
            <div v-if="row.status !== '已删除'" class="requirement-state">
              <span class="requirement-review" :class="{ confirmed: row.status === '已确认' }">{{ row.status === '已确认' ? '描述已确认' : '描述待审阅' }}</span>
              <el-button v-if="pendingQuestions(row).length" link type="warning" @click="clarifying = row.code">仍有 {{ pendingQuestions(row).length }} 项待澄清</el-button>
              <span v-else class="muted">暂无待澄清事项</span>
            </div>
            <div v-if="pendingQuestions(row).length" class="requirement-questions">
              <div v-for="q in pendingQuestions(row).slice(0, 2)" :key="q.id"><el-button link type="primary" @click="clarifying = row.code">Q{{ q.id }} · {{ q.question }}</el-button></div>
              <el-button link type="primary" @click="clarifying = row.code">录入答复 / 处理澄清</el-button>
            </div>
            <el-tag v-if="row.star" type="danger" size="small" effect="plain">★ 废标项</el-tag>
            <el-tag v-if="row.triangle" type="warning" size="small" effect="plain">▲</el-tag>
            <el-tag v-if="row.inferred" type="warning" size="small">推断</el-tag>
            <el-tag v-if="row.origin !== '系统'" type="primary" size="small">{{ row.origin }}</el-tag>
            <el-tag v-if="row.edited" size="small" type="info">已修改</el-tag>
            <div v-if="row.status === '已删除'" class="muted">删除原因：{{ row.delete_reason }}</div>
            <div v-if="row.params.length || row.rejected_params.length" class="muted">
              <code v-for="p in row.params" :key="p.name">{{ p.label }}={{ p.value }}</code>
              <el-tooltip v-for="p in row.rejected_params" :key="'x' + p.name" :content="p.reason"><code class="rejected">{{ p.label }}={{ p.value }} 已拦截</code></el-tooltip>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="150">
          <template #default="{ row }">
            <el-button v-if="row.seg_uid" link type="primary" @click="openSource(row)">{{ segLabel(row) }}</el-button>
            <span v-else class="muted">{{ segLabel(row) }}</span>
            <div v-if="row.seg_uid && !row.quote_verified" class="muted" style="color:#b42318">引用未通过校验</div>
          </template>
        </el-table-column>
        <el-table-column label="类别" prop="category" width="64" />
        <el-table-column label="优先级" prop="priority" width="70" />
        <el-table-column label="审核" width="84">
          <template #default="{ row }"><el-tag v-if="row.review && row.status === '待确认'" :type="TIER_TYPE[row.review]" size="small" effect="plain">{{ row.review }}</el-tag><span v-else class="muted">{{ row.status }}</span></template>
        </el-table-column>
        <el-table-column label="场景与去向" width="150"><template #default="{ row }"><el-button v-for="code in row.scenario_ids" :key="code" link type="primary" @click="open('scenarios', code)">{{ code }}</el-button><div class="muted">{{ row.disposition?.kinds.join('、') || '历史需求' }}</div></template></el-table-column>
        <el-table-column label="承接 PBS" width="110">
          <template #default="{ row }">
            <el-tag v-for="c in row.leaves" :key="c" size="small" type="info">{{ c }}</el-tag>
            <span v-if="!row.leaves.length && view.items.length && row.deliverable && row.status !== '已删除'" class="muted">未承接</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <div class="ops">
              <el-button v-if="row.status === '已删除'" link type="primary" @click="restore(row)">恢复</el-button>
              <template v-else>
                <el-button v-if="row.status === '待确认'" link type="success" @click="confirm([row.code])">确认</el-button>
                <el-button v-else link class="ghost" disabled tabindex="-1">确认</el-button>
                <el-button link type="primary" @click="editing = { ...row }">修改</el-button>
                <el-button link type="primary" @click="clarifying = row.code">澄清</el-button>
                <el-button link type="danger" @click="remove(row)">删除</el-button>
              </template>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </template>

  <el-drawer :model-value="!!clarifiedRequirement" @close="clarifying = null" :title="clarifying + ' · 需求与澄清'" size="85%">
    <template v-if="clarifiedRequirement">
      <p><b>{{ clarifiedRequirement.text }}</b></p>
      <div class="toolbar"><el-tag :type="clarifiedRequirement.status === '已确认' ? 'success' : 'info'">{{ clarifiedRequirement.status === '已确认' ? '描述已确认' : '描述待审阅' }}</el-tag><span class="muted">描述审核与澄清处理分别记录</span><el-button v-if="clarifiedRequirement.seg_uid" link type="primary" @click="openSource(clarifiedRequirement)">查看原文依据</el-button></div>
      <Questions :requirement-code="clarifying" embedded />
    </template>
  </el-drawer>

  <el-drawer :model-value="!!source" @close="source = null" title="原文" size="45%">
    <template v-if="source">
      <div class="muted">材料{{ source.seg.material_no }}「{{ source.seg.material_title }}」{{ source.seg.chapter ? ' · ' + source.seg.chapter : '' }}</div>
      <div v-for="s in source.context" :key="s.uid" class="seg-line" :class="{ hit: s.uid === source.seg.uid }">
        <span class="id">{{ s.seg_id }}</span><span v-html="s.uid === source.seg.uid ? highlight(s.text, source.req.quote_verified ? source.req.quote : '') : highlight(s.text)"></span>
      </div>
      <el-divider />
      <div><b>{{ source.req.code }}</b> {{ source.req.text }}</div>
      <div class="muted" style="margin-top:6px">{{ source.req.quote_verified ? '高亮部分是模型引用的原文，已逐字校验' : '模型给出的引用在原文中找不到，请人工核对' }}</div>
    </template>
  </el-drawer>

  <el-dialog :model-value="!!editing" @close="editing = null" title="修改需求" width="560px">
    <el-form v-if="editing" label-width="64px">
      <el-form-item label="内容"><el-input v-model="editing.text" type="textarea" :rows="3" /></el-form-item>
      <el-form-item label="类别"><el-select v-model="editing.category"><el-option v-for="c in meta.categories" :key="c" :value="c" :label="c" /></el-select></el-form-item>
      <el-form-item label="优先级"><el-radio-group v-model="editing.priority"><el-radio-button v-for="p in ['必须', '重要', '一般']" :key="p" :value="p">{{ p }}</el-radio-button></el-radio-group></el-form-item>
    </el-form>
    <div class="muted">修改后自动标为已确认；以后重新抽取不会覆盖。承接它的 PBS 项会标记“建议复核”。</div>
    <template #footer><el-button @click="editing = null">取消</el-button><el-button type="primary" @click="save">保存</el-button></template>
  </el-dialog>

  <el-dialog :model-value="!!adding" @close="adding = null" title="新增需求" width="560px">
    <el-form v-if="adding" label-width="64px">
      <el-form-item label="内容"><el-input v-model="adding.text" type="textarea" :rows="3" /></el-form-item>
      <el-form-item label="类别"><el-select v-model="adding.category"><el-option v-for="c in meta.categories" :key="c" :value="c" :label="c" /></el-select></el-form-item>
      <el-form-item label="优先级"><el-radio-group v-model="adding.priority"><el-radio-button v-for="p in ['必须', '重要', '一般']" :key="p" :value="p">{{ p }}</el-radio-button></el-radio-group></el-form-item>
      <el-form-item label="来源"><el-input v-model="adding.source_note" placeholder="例如：客户电话确认、现场调研" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="adding = null">取消</el-button><el-button type="primary" :disabled="!adding?.text.trim()" @click="add">新增</el-button></template>
  </el-dialog>

  <el-dialog :model-value="!!paramEdit" @close="paramEdit = null" :title="'测算参数：' + (paramEdit?.label ?? '')" width="480px">
    <template v-if="paramEdit">
      <div class="muted" style="margin-bottom:8px">当前 {{ paramEdit.value ?? '无' }}{{ paramEdit.unit }}（{{ paramEdit.status }}）</div>
      <div v-for="c in paramEdit.candidates" :key="c.req_id" class="muted">{{ c.req_id }}：“{{ c.quote }}” → {{ c.value }}</div>
      <div class="row" style="margin-top:12px"><el-input-number v-model="paramEdit.input" :controls="false" /> {{ paramEdit.unit }}</div>
      <div class="muted" style="margin-top:8px">人工设定的值优先于材料中的数字，所有用到该参数的数量会自动重算。</div>
    </template>
    <template #footer>
      <el-button @click="saveParam(null)">恢复按材料取值</el-button>
      <el-button type="primary" @click="saveParam(paramEdit.input)">保存</el-button>
    </template>
  </el-dialog>`,
});
