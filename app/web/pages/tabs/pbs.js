import ProjectCatalog from "./project-catalog.js";
import { computed, defineComponent, inject, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, meta, runJob } from "../../api.js";
import { highlight, SOURCES, SOURCE_CLASS, LEVEL_TYPE } from "../../ui.js";

export default defineComponent({
  components: { ProjectCatalog },
  setup() {
    const { id, view, reload } = inject("project");
    const { focus, open } = inject("workspace");
    const filter = ref({ source: "", state: "", kw: "" });
    const expanded = ref(new Set());
    const editing = ref(null);
    const products = ref([]);
    const rematch = ref(null);
    const starting = ref(false);

    const reqByCode = computed(() => new Map(view.value.requirements.map((r) => [r.code, r])));
    const segByUid = computed(() => new Map([...view.value.sourceSnapshots, ...view.value.segments].map((s) => [s.uid, s])));
    const productById = computed(() => new Map(products.value.map((p) => [p.id, p])));
    const items = computed(() => view.value.items);
    const s = computed(() => view.value.steps.pbs);
    const pendingItems = computed(() => items.value.filter((i) => !i.confirmed || i.stale));

    watch(
      () => focus.value,
      (v) => {
        if (!v) return;
        filter.value = { source: "", state: "", kw: "" };
        if (typeof v === "string") v = items.value.find((i) => i.code === v)?.id ?? v;
        expanded.value = new Set([...expanded.value, v]);
        setTimeout(() => document.getElementById(`item-${v}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
      },
      { immediate: true },
    );

    const visibleGroups = computed(() =>
      view.value.groups
        .map((g) => ({
          ...g,
          items: items.value.filter((i) => {
            const f = filter.value;
            if (i.parent !== g.code) return false;
            if (f.source && i.source !== f.source) return false;
            if (f.state === "stale" && !i.stale) return false;
            if (f.state === "unconfirmed" && i.confirmed) return false;
            if (f.state === "qty" && i.qty !== null && i.qty !== undefined) return false;
            if (f.kw && !`${i.name}${i.spec}`.includes(f.kw)) return false;
            return true;
          }),
        }))
        .filter((g) => g.items.length),
    );
    const missingRequired = computed(() => view.value.groups.filter((g) => g.required && !items.value.some((i) => i.parent === g.code)));

    const toggle = (i) => {
      const set = new Set(expanded.value);
      set.has(i.id) ? set.delete(i.id) : set.add(i.id);
      expanded.value = set;
    };

    const generate = async () => {
      if (starting.value || view.value.job?.status === "处理中" || !view.value.steps.requirements.total) return;
      starting.value = true;
      try {
        if (items.value.length) {
          await ElMessageBox.confirm("助手会补充 PBS，并可调整尚未人工审阅的草稿。人工修改、已确认或已审阅的项保留；本次不会自动删除原有项。", "完善 PBS 草稿", { confirmButtonText: "开始完善", cancelButtonText: "取消" });
        }
        const r = await call(() => api(`/projects/${id}/pbs/generate`, { method: "POST" }));
        if (r) await reload();
      } finally { starting.value = false; }
    };

    const loadProducts = async () => {
      if (!products.value.length) products.value = (await call(() => api("/products"))) ?? [];
    };
    const edit = async (item) => {
      await loadProducts();
      editing.value = item
        ? { ...item, matched_capabilities: [...item.matched_capabilities], blocked: item.blocked_by ? { product_ref: item.blocked_by.product_ref, limit: item.blocked_by.limit } : { product_ref: "", limit: "" }, qtyInput: item.manual_qty ? item.qty : null, qtyMode: item.manual_qty ? "manual" : "auto" }
        : { id: null, parent: view.value.groups[0].code, name: "", spec: "", source: "服务", product_ref: "", matched_capabilities: [], blocked: { product_ref: "", limit: "" }, sizing_rule: "", req_ids: [], unit: "", qtyInput: null, qtyMode: "auto" };
    };
    const save = async () => {
      const e = editing.value;
      const body = {
        name: e.name,
        spec: e.spec,
        parent: e.parent,
        source: e.source,
        product_ref: e.product_ref || null,
        matched_capabilities: e.matched_capabilities,
        blocked_by: e.source !== "自有产品" && e.blocked.product_ref && e.blocked.limit ? e.blocked : null,
        req_ids: e.req_ids,
        sizing_rule: e.sizing_rule || null,
        unit: e.unit,
        qty: e.qtyMode === "manual" ? e.qtyInput : null,
      };
      const r = await call(() => api(e.id ? `/projects/${id}/pbs/${e.id}` : `/projects/${id}/pbs`, { method: e.id ? "PUT" : "POST", body }), "已保存");
      if (r) {
        editing.value = null;
        reload();
      }
    };
    const confirmItem = async (i) => {
      await call(() => api(`/projects/${id}/pbs/confirm`, { method: "POST", body: { ids: [i.id] } }));
      reload();
    };
    const confirmAll = async () => {
      if (!pendingItems.value.length) return;
      await ElMessageBox.confirm(`将确认全部 ${pendingItems.value.length} 个待审 PBS 项，包含当前筛选之外的项。请先核对需求、选型和数量依据；此操作不会补齐未知数量，也不会解决澄清事项。`, "批量确认 PBS 项", { confirmButtonText: "确认这些 PBS 项", cancelButtonText: "返回核对" });
      await call(() => api(`/projects/${id}/pbs/confirm`, { method: "POST", body: { ids: pendingItems.value.map((i) => i.id) } }), "已确认 PBS 项；数量与澄清状态分别保留");
      reload();
    };
    const remove = async (i) => {
      await ElMessageBox.confirm(`删除 ${i.code}「${i.name}」？此项不能恢复，关联需求会保留，项目方案可能需要重新关联。`, "删除 PBS 项", { type: "warning", confirmButtonText: "删除此项", cancelButtonText: "取消" });
      await call(() => api(`/projects/${id}/pbs/${i.id}`, { method: "DELETE" }), "已删除");
      reload();
    };

    const startRematch = (i) => (rematch.value = { item: i, instruction: "" });
    const runRematch = async () => {
      const { item, instruction } = rematch.value;
      const r = await runJob("重新匹配", () => api(`/projects/${id}/pbs/${item.id}/rematch`, { method: "POST", body: { instruction } }));
      if (r) rematch.value = { item, instruction, result: r };
    };
    const acceptRematch = async () => {
      const { item, result } = rematch.value;
      if (await call(() => api(`/projects/${id}/pbs/${item.id}/accept`, { method: "POST", body: { suggestion: result.suggestion } }), "已更新选型，请重新确认 PBS 项")) { rematch.value = null; reload(); }
    };

    const chunkOf = (cid) => view.value.chunks[cid];
    const productOptions = computed(() => products.value.filter((p) => p.metadata?.active !== false || p.id === editing.value?.product_ref));
    const editProduct = computed(() => (editing.value?.product_ref ? productById.value.get(editing.value.product_ref) : null));
    const blockerProduct = computed(() => (editing.value?.blocked.product_ref ? productById.value.get(editing.value.blocked.product_ref) : null));
    const rulesFor = computed(() => meta.rules);
    const reqOptions = computed(() => view.value.requirements.filter((r) => r.status !== "已删除"));

    const qtyText = (i) => (i.qty === null || i.qty === undefined ? null : `${i.qty}`);
    const stateOf = (i) => (i.stale ? { label: "待复核", type: "warning" } : i.confirmed ? { label: "已确认", type: "success" } : { label: "待确认", type: "info" });

    const rematchChanges = computed(() => {
      if (!rematch.value?.result) return [];
      const before = rematch.value.item, after = rematch.value.result.suggestion;
      return [["name", "名称"], ["spec", "规格说明"], ["source", "交付方式"], ["product_ref", "关联产品"], ["parent", "PBS 分类"], ["unit", "单位"], ["sizing_rule", "数量规则"], ["matched_capabilities", "对应产品能力"], ["blocked_by", "能力缺口"], ["basis", "选型说明"]].filter(([key]) => after[key] !== undefined && JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(([key, label]) => {
        const text = (value) => Array.isArray(value) ? value.join("；") : typeof value === "object" && value ? `${value.product_ref}：${value.limit}` : value || "未指定";
        return { label, before: text(before[key]), after: text(after[key]) };
      });
    });
    return { view, s, items, pendingItems, filter, focus, visibleGroups, missingRequired, expanded, toggle, generate, starting, edit, editing, save, confirmItem, confirmAll, remove, rematch, rematchChanges, startRematch, runRematch, acceptRematch, products, productOptions, editProduct, blockerProduct, rulesFor, reqOptions, reqByCode, segByUid, chunkOf, qtyText, stateOf, highlight, SOURCES, SOURCE_CLASS, LEVEL_TYPE, meta, open };
  },
  template: `
  <ProjectCatalog />
  <div v-if="!items.length" class="empty">
    <template v-if="view.steps.requirements.total">
      需求条目 {{ view.steps.requirements.total }} 条，业务场景 {{ view.scenarioCoverage.active }} 个。<el-button v-if="!view.scenarioCoverage.active" link type="primary" @click="open('scenarios')">查看业务场景</el-button><el-button type="primary" :loading="starting" :disabled="view.job?.status === '处理中'" @click="generate">请专家编制 PBS</el-button>
      <div class="muted" style="margin-top:8px">也可以直接在左边对我说“生成 PBS”。系统会先从产品库和手册里检索相关产品，再让模型匹配。</div>
    </template>
    <template v-else>还没有需求，先在左边把客户的需求发给我，或者<el-button link type="primary" @click="open('materials')">去添加材料</el-button>。</template>
  </div>
  <template v-else>
    <div class="summary-row">
      <div class="tile"><div class="v">{{ s.items }}</div><div class="l">PBS 项（已确认 {{ s.confirmed }}）</div></div>
      <div class="tile" :class="{ warn: s.uncovered }"><div class="v">{{ s.uncovered }}</div><div class="l">必须需求尚无 PBS 对应项</div></div>
      <div class="tile" :class="{ warn: s.stale }"><div class="v">{{ s.stale }}</div><div class="l">依据变化，待重新核对</div></div>
      <div class="tile" :class="{ warn: s.pendingQty }"><div class="v">{{ s.pendingQty }}</div><div class="l">数量待确认</div></div>
      <div class="tile" :class="{ danger: s.conflicts }"><div class="v">{{ s.conflicts }}</div><div class="l">约束冲突</div></div>
    </div>

    <el-collapse v-if="view.retrieval" class="retrieval"><el-collapse-item title="查看本次选型的候选产品（尚未代表最终选用）">
      <el-tag v-for="p in view.retrieval.candidates.slice(0, 8)" :key="p.id" size="small" type="info">{{ p.name }}</el-tag>
      <span class="muted">共读取 {{ view.retrieval.chunks }} 段产品资料</span>
    </el-collapse-item></el-collapse>

    <el-card v-if="view.uncovered.length || missingRequired.length || view.conflicts.length || view.audit.some((a) => a.level !== '提示')" shadow="never" class="coverage" body-style="padding:10px 14px">
      <div class="mc-title">需求对应与选型检查（编辑后更新）</div>
      <div v-for="r in view.uncovered" :key="r" class="risk-line"><el-tag size="small" type="danger">尚无 PBS 对应项</el-tag> {{ r }} {{ reqByCode.get(r)?.text }} <el-button link type="primary" @click="open('requirements', r)">核对需求</el-button></div>
      <div v-for="g in missingRequired" :key="g.code" class="risk-line"><el-tag size="small" type="warning">分类待核对</el-tag> 「{{ g.name }}」暂无条目，请结合本项目范围判断是否需要补充</div>
      <div v-for="(a, k) in view.audit.filter((x) => x.level !== '提示' && x.type !== '必须需求尚无 PBS 对应项')" :key="k" class="risk-line"><el-tag size="small" :type="LEVEL_TYPE[a.level]">{{ a.type }}</el-tag> {{ a.message }}</div>
    </el-card>

    <div class="toolbar">
      <el-select v-model="filter.source" placeholder="来源" clearable size="small" style="width:110px"><el-option v-for="x in SOURCES" :key="x" :value="x" :label="x" /></el-select>
      <el-select v-model="filter.state" placeholder="状态" clearable size="small" style="width:110px">
        <el-option value="stale" label="待复核" /><el-option value="unconfirmed" label="待确认" /><el-option value="qty" label="数量待确认" />
      </el-select>
      <el-input v-model="filter.kw" placeholder="搜索" clearable size="small" style="width:140px" />
      <span style="flex:1"></span>
      <el-button size="small" @click="edit(null)">新增一项</el-button>
      <el-button size="small" :disabled="!pendingItems.length" @click="confirmAll">确认全部待审项（{{ pendingItems.length }}）</el-button>
      <el-button size="small" :loading="starting" :disabled="!view.steps.requirements.total || view.job?.status === '处理中'" @click="generate">请专家完善 PBS</el-button>
      <el-button size="small" type="primary" @click="open('finish')">导出前检查 →</el-button>
    </div>

    <el-card shadow="never" body-style="padding:0;overflow-x:auto">
      <table class="pbs-table">
        <thead><tr><th style="width:60px">编码</th><th>名称</th><th style="width:84px">来源</th><th style="width:150px">匹配产品</th><th style="width:96px">数量</th><th style="width:76px">状态</th><th style="width:220px">操作</th></tr></thead>
        <tbody>
          <template v-for="g in visibleGroups" :key="g.code">
            <tr class="group"><td>{{ g.code }}</td><td colspan="6">{{ g.name }} <span class="muted">{{ g.items.length }} 项</span></td></tr>
            <template v-for="i in g.items" :key="i.id">
              <tr :id="'item-' + i.id" class="leaf" :class="{ open: expanded.has(i.id), focus: i.id === focus }" @click="toggle(i)">
                <td><button class="evidence-toggle" :aria-expanded="expanded.has(i.id)" :aria-label="'查看 ' + i.code + ' 的需求、选型和数量依据'" @click.stop="toggle(i)">▸</button> {{ i.code }}</td>
                <td>
                  <b>{{ i.name }}</b>
                  <el-tag v-if="i.edited" size="small" type="info">人工</el-tag>
                  <el-tag v-if="view.conflicts.some((c) => c.product_ref === i.product_ref && i.product_ref)" size="small" type="danger">约束冲突</el-tag>
                  <div class="muted">{{ i.spec }}</div>
                  <div v-if="i.stale" class="stale">⟳ {{ i.stale }}</div>
                </td>
                <td><span class="src"><i :class="'dot-' + SOURCE_CLASS[i.source]"></i>{{ i.source }}</span></td>
                <td>
                  <template v-if="i.match?.type === '限制拆出'"><el-tag size="small" type="warning">补足产品能力缺口</el-tag><div class="muted">{{ i.match.product_name }}</div></template>
                  <template v-else-if="i.match"><b>{{ i.match.product_name }}</b><div class="muted" v-if="i.match.capabilities?.length">对应 {{ i.match.capabilities.length }} 项产品能力</div></template>
                  <span v-else class="muted">—</span>
                </td>
                <td class="num">
                  <template v-if="qtyText(i)"><b>{{ i.qty }}</b> {{ i.unit }}</template><el-tag v-else size="small" type="warning">待确认</el-tag>
                  <div class="muted" v-if="i.manual_qty">人工确认</div>
                  <div class="muted" v-else-if="i.sizing?.uncertain">测算依据待确认</div>
                </td>
                <td><el-tag size="small" :type="stateOf(i).type" effect="plain">{{ stateOf(i).label }}</el-tag></td>
                <td @click.stop>
                  <div class="ops">
                    <el-button v-if="!i.confirmed || i.stale" link type="success" size="small" title="确认本项内容；未知数量与未处理澄清仍单独保留" @click="confirmItem(i)">确认本项</el-button>
                    <el-button link type="primary" size="small" @click="edit(i)">编辑</el-button>
                    <el-button link size="small" :disabled="view.job?.status === '处理中'" @click="startRematch(i)">重新匹配</el-button>
                    <el-button link type="danger" size="small" @click="remove(i)">删除</el-button>
                  </div>
                </td>
              </tr>
              <tr v-if="expanded.has(i.id)" class="detail"><td colspan="7">
                <div class="evidence">
                  <div class="ev">
                    <h4><span class="step">1</span>为什么要有这一项</h4>
                    <div v-if="i.scenario_ids.length" class="muted">场景依据：<el-button v-for="code in i.scenario_ids" :key="code" link type="primary" @click="open('scenarios', code)">{{ code }} {{ view.scenarios.find((s) => s.code === code)?.name }}</el-button></div>
                    <div v-for="c in i.req_ids" :key="c" class="req">
                      <div><el-tag size="small" type="info">{{ c }}</el-tag> {{ reqByCode.get(c)?.text }}</div>
                      <div class="quote" v-if="segByUid.get(reqByCode.get(c)?.seg_uid)" v-html="highlight(segByUid.get(reqByCode.get(c).seg_uid).text, reqByCode.get(c).quote_verified ? reqByCode.get(c).quote : '')"></div>
                      <div class="quote muted" v-else-if="reqByCode.get(c)?.source_note">{{ reqByCode.get(c).source_note }}</div>
                    </div>
                    <div v-if="!i.req_ids.length" class="muted">没有直接对应的需求</div>
                    <div class="why">{{ i.basis }}<span class="muted" v-if="i.history_ref.length"> · 参考历史项目 {{ i.history_ref.join('、') }}</span></div>
                  </div>
                  <div class="ev">
                    <h4><span class="step">2</span>匹配依据</h4>
                    <template v-if="i.match?.type === '限制拆出'">
                      <div class="muted">此项用于补足 {{ i.match.product_name }} 的以下能力缺口：</div>
                      <el-tag type="warning" class="wrap">✕ {{ i.match.limit }}</el-tag>
                      <div class="muted" style="margin-top:6px">所以拆成单独的「{{ i.source }}」项</div>
                    </template>
                    <template v-else-if="i.match">
                      <div class="prod">{{ i.match.product_ref }} {{ i.match.product_name }}</div>
                      <div v-if="i.match.capabilities?.length" class="caps"><el-tag v-for="c in i.match.capabilities" :key="c" size="small" type="success" class="wrap">✓ {{ c }}</el-tag></div>
                      <div v-else class="muted">产品配套项（附加授权、硬件或依赖项）</div>
                    </template>
                    <div v-else class="muted">尚未关联目录产品，当前按「{{ i.source }}」安排，需核对选型依据。</div>
                    <template v-for="cid in i.evidence_chunks" :key="cid"><div class="chunk" v-if="chunkOf(cid)">
                      <div class="muted">检索到的资料 K{{ cid }}{{ chunkOf(cid).doc_name ? '（' + chunkOf(cid).doc_name + '）' : '' }}</div>{{ chunkOf(cid).text }}<el-tag v-if="!chunkOf(cid).active" size="small" type="warning">历史依据，当前资料已变更</el-tag>
                    </div></template>
                    <div v-for="c in view.conflicts.filter((x) => x.product_ref === i.product_ref && i.product_ref)" :key="c.req_id" class="conflict">⚠ 不满足 {{ c.req_id }}：{{ c.evidence }}<br />{{ c.reason }}</div>
                  </div>
                  <div class="ev">
                    <h4><span class="step">3</span>数量怎么来的</h4>
                    <template v-if="i.manual_qty"><div>人工确认为 <b>{{ i.qty }}{{ i.unit }}</b></div><div class="muted" v-if="i.sizing_rule">（测算规则 {{ i.sizing_rule }} 参考值为 {{ i.sizing?.result ?? '—' }}）</div></template>
                    <template v-else-if="i.sizing && !i.sizing.error">
                      <div>规则 <code>{{ i.sizing.rule_id }}</code> {{ i.sizing.rule_name }}</div>
                      <div class="formula">{{ i.sizing.expr }} = {{ i.sizing.result }}</div>
                      <div v-for="p in i.sizing.inputs" :key="p.name">{{ p.label }} = <b>{{ p.value }}</b>{{ p.unit }} <el-tag size="small" :type="['原文明确', '客户确认', '人工设定'].includes(p.status) ? 'success' : 'warning'">{{ p.status }}</el-tag></div>
                      <div class="muted" style="margin-top:6px">{{ i.sizing.note }}</div>
                    </template>
                    <template v-else-if="i.sizing?.error"><div class="conflict">{{ i.sizing.error }}</div></template>
                    <div v-else-if="i.qty_basis === '产品许可'">产品许可，按 1 {{ i.unit }}计</div>
                    <div v-else-if="i.qty_basis === '原文数量'">原文写明：“{{ i.qty_quote }}”</div>
                    <div v-else><el-tag type="warning" size="small">数量待确认</el-tag><div class="muted" style="margin-top:6px">当前没有可用的数量依据，请补充原文依据、确认测算参数，或编辑并人工指定数量。</div></div>
                    <div v-if="i.last_qty !== null && i.last_qty !== undefined && i.stale" class="muted" style="margin-top:6px">上一次是 {{ i.last_qty }}</div>
                  </div>
                </div>
              </td></tr>
            </template>
          </template>
        </tbody>
      </table>
      <div v-if="!visibleGroups.length" class="empty">没有符合条件的项</div>
    </el-card>
  </template>

  <el-drawer :model-value="!!editing" @close="editing = null" :title="editing?.id ? '编辑 ' + editing.code : '新增 PBS 项'" size="520px">
    <el-form v-if="editing" label-position="top">
      <el-form-item label="名称"><el-input v-model="editing.name" /></el-form-item>
      <el-form-item label="规格说明"><el-input v-model="editing.spec" type="textarea" :rows="2" /></el-form-item>
      <div class="row">
        <el-form-item label="一级分类" style="flex:1"><el-select v-model="editing.parent"><el-option v-for="g in view.groups" :key="g.code" :value="g.code" :label="g.code + ' ' + g.name" /></el-select></el-form-item>
        <el-form-item label="来源"><el-radio-group v-model="editing.source"><el-radio-button v-for="x in SOURCES" :key="x" :value="x">{{ x }}</el-radio-button></el-radio-group></el-form-item>
      </div>

      <template>
        <el-form-item label="匹配产品">
          <el-select v-model="editing.product_ref" filterable clearable placeholder="从产品库选择" @change="editing.matched_capabilities = []; editing.source = editProduct?.metadata?.delivery_source || editing.source; editing.unit = editProduct?.unit || editing.unit">
            <el-option v-for="p in productOptions" :key="p.id" :value="p.id" :label="p.id + ' ' + p.name" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="editProduct" label="用于响应需求的产品能力">
          <el-checkbox-group v-model="editing.matched_capabilities"><el-checkbox v-for="c in editProduct.capabilities" :key="c" :value="c" :label="c" class="block" /></el-checkbox-group>
          <div v-if="editProduct.limits.length" class="muted" style="margin-top:6px">该产品的限制：{{ editProduct.limits.join('；') }}</div>
        </el-form-item>
      </template>
      <template v-if="editing.source !== '自有产品'">
        <el-form-item label="本项补足哪个产品的能力缺口（可选）">
          <el-select v-model="editing.blocked.product_ref" filterable clearable placeholder="产品" @change="editing.blocked.limit = ''"><el-option v-for="p in productOptions" :key="p.id" :value="p.id" :label="p.id + ' ' + p.name" /></el-select>
          <el-select v-if="blockerProduct" v-model="editing.blocked.limit" placeholder="限制" style="margin-top:6px"><el-option v-for="l in blockerProduct.limits" :key="l" :value="l" :label="l" /></el-select>
        </el-form-item>
      </template>

      <el-form-item label="承接的需求">
        <el-select v-model="editing.req_ids" multiple filterable collapse-tags-tooltip placeholder="选择需求">
          <el-option v-for="r in reqOptions" :key="r.code" :value="r.code" :label="r.code + ' ' + r.text" />
        </el-select>
      </el-form-item>

      <el-divider>数量</el-divider>
      <el-form-item label="数量怎么定">
        <el-radio-group v-model="editing.qtyMode">
          <el-radio-button value="auto">按规则 / 许可口径计算</el-radio-button>
          <el-radio-button value="manual">人工指定数量</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="editing.qtyMode === 'auto'" label="测算规则（同一规则只能用在一项上）">
        <el-select v-model="editing.sizing_rule" clearable filterable placeholder="不使用规则">
          <el-option v-for="r in rulesFor" :key="r.id" :value="r.id" :label="r.id + ' ' + r.name + '（' + r.unit + '）'" />
        </el-select>
      </el-form-item>
      <div v-else class="row">
        <el-form-item label="数量"><el-input-number v-model="editing.qtyInput" :min="0" :controls="false" /></el-form-item>
        <el-form-item label="单位"><el-input v-model="editing.unit" style="width:90px" /></el-form-item>
      </div>
      <div class="muted">人工填写的数量标为“人工确认”，规则重算与完善草稿时会保留。</div>
    </el-form>
    <template #footer><el-button @click="editing = null">取消</el-button><el-button type="primary" :disabled="!editing?.name.trim()" @click="save">保存</el-button></template>
  </el-drawer>

  <el-dialog :model-value="!!rematch" @close="rematch = null" title="重新匹配产品" width="700px">
    <template v-if="rematch">
      <div><b>{{ rematch.item.code }} {{ rematch.item.name }}</b> <span class="muted">{{ rematch.item.source }}</span></div>
      <template v-if="!rematch.result">
        <el-input v-model="rematch.instruction" type="textarea" :rows="3" style="margin-top:10px" placeholder="可选：告诉模型你的想法，例如“这个应该用 P06 而不是自研”" />
        <div class="muted" style="margin-top:6px">助手会检索产品资料，提出名称、规格、分类、产品及数量规则等调整建议，采纳后才会更新。关联需求保持不变；人工数量保留，自动数量会重新计算。</div>
      </template>
      <template v-else>
        <div class="compare" style="margin-top:12px">
          <div><div class="muted">原来</div>{{ rematch.item.name }}<br /><span class="muted">{{ rematch.item.source }}</span></div>
          <div class="arrow">→</div>
          <div><div class="muted">建议</div><b>{{ rematch.result.suggestion.name }}</b><br /><span class="muted">{{ rematch.result.suggestion.source }}</span></div>
        </div>
        <div v-if="rematch.result.suggestion.matched_capabilities?.length" class="caps"><el-tag v-for="x in rematch.result.suggestion.matched_capabilities" :key="x" size="small" type="success" class="wrap">✓ {{ x }}</el-tag></div>
        <div v-if="rematch.result.suggestion.blocked_by" class="caps"><el-tag size="small" type="warning" class="wrap">✕ {{ rematch.result.suggestion.blocked_by.product_name }}：{{ rematch.result.suggestion.blocked_by.limit }}</el-tag></div>
        <div class="muted" style="margin-top:6px">{{ rematch.result.suggestion.basis }}</div>
        <div v-for="n in rematch.result.notes" :key="n" class="muted">· {{ n }}</div>
        <el-table :data="rematchChanges" size="small" style="margin-top:10px"><el-table-column prop="label" label="调整内容" width="100" /><el-table-column prop="before" label="当前" /><el-table-column prop="after" label="建议" /></el-table>
        <div class="muted">采纳后自动数量按新依据重算，人工数量保留；本项需重新确认。</div>
      </template>
    </template>
    <template #footer>
      <el-button @click="rematch = null">取消</el-button>
      <el-button v-if="!rematch?.result" type="primary" :disabled="view.job?.status === '处理中'" @click="runRematch">获取匹配建议</el-button>
      <template v-else><el-button @click="rematch.result = null">重新提出建议</el-button><el-button type="primary" @click="acceptRematch">采纳并更新本项</el-button></template>
    </template>
  </el-dialog>`,
});
