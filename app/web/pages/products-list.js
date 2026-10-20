import { computed, defineComponent, onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, fileToBase64, fmtTime, meta, pickFile, runJob } from "../api.js";

const blank = () => ({ id: null, name: "", summary: "", capabilities: "", limits: "", xinchuang: "", unit: "套", metadata: { kind: "软件", delivery_source: "自有产品", availability: "待核实", data_kind: "人工维护", quantity_policy: "unknown", active: true, requires_validation: true, compatibility: [], deliverables: [], reference_ids: [] }, compatibilityText: "", deliverablesText: "" });

export default defineComponent({
  setup() {
    const products = ref([]);
    const docs = ref([]);
    const loading = ref(true);
    const kw = ref("");
    const includeArchived = ref(false);
    const editing = ref(null);
    const draft = ref(null);
    const probe = ref({ query: "", result: null, busy: false });

    const load = async () => {
      loading.value = true;
      [products.value, docs.value] = await Promise.all([call(() => api("/products")), call(() => api("/docs"))]).then((r) => [r[0] ?? [], r[1] ?? []]);
      loading.value = false;
    };
    onMounted(load);

    const shown = computed(() => products.value.filter((p) => (includeArchived.value || p.metadata?.active !== false) && (!kw.value || `${p.name}${p.summary}${p.capabilities.join("")}`.includes(kw.value))));
    const docsOf = (pid) => docs.value.filter((d) => d.product_id === pid);
    const pendingDocs = computed(() => docs.value.filter((d) => d.status !== "已入库"));

    const edit = (p) => {
      editing.value = p ? { ...p, metadata: { ...blank().metadata, ...p.metadata }, compatibilityText: (p.metadata?.compatibility ?? []).join("\n"), deliverablesText: (p.metadata?.deliverables ?? []).join("\n"), capabilities: p.capabilities.join("\n"), limits: p.limits.join("\n") } : blank();
    };
    const save = async () => {
      const e = editing.value;
      const body = { name: e.name, summary: e.summary, capabilities: e.capabilities, limits: e.limits, xinchuang: e.xinchuang, unit: e.unit, metadata: { ...e.metadata, compatibility: e.compatibilityText.split("\n").filter(Boolean), deliverables: e.deliverablesText.split("\n").filter(Boolean) } };
      if (await call(() => api(e.id ? `/products/${e.id}` : "/products", { method: e.id ? "PUT" : "POST", body }), "已保存")) {
        editing.value = null;
        load();
      }
    };
    const remove = async (p) => {
      await ElMessageBox.confirm(`归档产品「${p.name}」？停止新匹配，保留历史引用与BOM；已有PBS标记待复核。`, "归档产品", { type: "warning" });
      await call(() => api(`/products/${p.id}`, { method: "DELETE" }), "已归档");
      load();
    };
    const restore = async (p) => {
      if (await call(() => api(`/products/${p.id}`, { method: "PUT", body: { ...p, metadata: { ...p.metadata, active: true } } }), "产品已恢复，可参与后续匹配")) await load();
    };

    const importExcel = async () => {
      const f = await pickFile(".xlsx");
      if (!f) return;
      const r = await call(async () => api("/products/import", { method: "POST", body: { base64: await fileToBase64(f) } }));
      if (!r) return;
      if (r.errors.length) await ElMessageBox.alert(r.errors.join("\n"), `导入完成：新增 ${r.created}，更新 ${r.updated}，${r.errors.length} 行有误`);
      else await call(async () => r, `导入完成：新增 ${r.created} 个，更新 ${r.updated} 个`);
      load();
    };

    // manual upload → model drafts capabilities/limits → human confirms
    const uploadManual = async (productId = null) => {
      const f = await pickFile(meta.fileTypes.join(","));
      if (!f) return;
      const res = await runJob("模型阅读产品手册", async () => api("/docs", { method: "POST", body: { productId, file: { name: f.name, base64: await fileToBase64(f) } } }));
      await load();
      if (res) {
        const doc = docs.value[0];
        if (doc) openDraft(doc.id);
      }
    };
    const openDraft = async (docId) => {
      const doc = await call(() => api(`/docs/${docId}`));
      if (!doc?.draft) return;
      const existing = doc.product_id ? products.value.find((p) => p.id === doc.product_id) : null;
      draft.value = {
        doc,
        productId: existing?.id ?? "",
        form: {
          name: existing?.name ?? doc.draft.name,
          summary: doc.draft.summary,
          unit: doc.draft.unit,
          xinchuang: doc.draft.xinchuang,
          capabilities: doc.draft.capabilities.map((c) => ({ ...c, keep: true })),
          limits: doc.draft.limits.map((c) => ({ ...c, keep: true })),
        },
      };
    };
    const useExisting = (pid) => {
      const p = products.value.find((x) => x.id === pid);
      if (p) draft.value.form.name = p.name;
    };
    const confirmDraft = async () => {
      const d = draft.value;
      const f = d.form;
      const product = {
        name: f.name,
        summary: f.summary,
        unit: f.unit,
        xinchuang: f.xinchuang,
        capabilities: f.capabilities.filter((c) => c.keep).map((c) => c.text),
        limits: f.limits.filter((c) => c.keep).map((c) => c.text),
      };
      if (d.productId) {
        const old = products.value.find((p) => p.id === d.productId);
        product.capabilities = [...new Set([...old.capabilities, ...product.capabilities])];
        product.limits = [...new Set([...old.limits, ...product.limits])];
        product.xinchuang = product.xinchuang || old.xinchuang;
      }
      if (await call(() => api(`/docs/${d.doc.id}/confirm`, { method: "POST", body: { productId: d.productId || null, product } }), "已入库，手册已加入检索")) {
        draft.value = null;
        load();
      }
    };
    const removeDoc = async (d) => {
      await ElMessageBox.confirm(`删除手册「${d.name}」及其检索内容？`, "删除手册", { type: "warning" });
      await call(() => api(`/docs/${d.id}`, { method: "DELETE" }));
      load();
    };

    const search = async () => {
      if (probe.value.busy || !probe.value.query.trim()) return;
      probe.value.busy = true;
      probe.value.result = await call(() => api("/products/search", { method: "POST", body: { query: probe.value.query } }));
      probe.value.busy = false;
    };

    return { includeArchived, products, docs, loading, kw, shown, docsOf, pendingDocs, editing, draft, probe, meta, edit, save, remove, restore, importExcel, uploadManual, openDraft, useExisting, confirmDraft, removeDoc, search, fmtTime };
  },
  template: `
  <div class="page-head">
    <div><h2>产品目录 <span class="muted">{{ shown.length }}</span></h2><div class="sub">维护产品能力、边界与适配条件。</div></div>
    <div class="actions">
      <el-checkbox v-model="includeArchived">显示已归档</el-checkbox>
      <el-input v-model="kw" placeholder="搜索产品" clearable style="width:180px" />
      <a href="/api/products/template.xlsx"><el-button>导出产品表（可回填）</el-button></a>
      <el-button title="按产品名称匹配：同名更新、不同名新增；导入后直接生效。请先导出产品表留存。" @click="importExcel">导入产品表</el-button>
      <el-button @click="uploadManual(null)">上传产品手册</el-button>
      <el-button type="primary" @click="edit(null)">新增产品</el-button>
    </div>
  </div>

  <p class="muted">产品表包含当前目录，可编辑后回填；导入按名称更新，同名内容会直接生效。整包变更请使用“数据包维护”的预览导入。</p>
  <el-alert v-if="pendingDocs.length" type="warning" :closable="false" show-icon style="margin-bottom:12px" title="有手册等待确认入库">
    <div v-for="d in pendingDocs" :key="d.id">《{{ d.name }}》{{ d.status }} <el-button v-if="d.status === '待确认'" link type="primary" @click="openDraft(d.id)">查看模型整理的草稿</el-button><el-button link type="danger" @click="removeDoc(d)">删除</el-button></div>
  </el-alert>

  <el-card shadow="never" body-style="padding:0" v-loading="loading">
    <el-table :data="shown" empty-text="产品库是空的，先新增或导入">
      <el-table-column label="产品" width="220">
        <template #default="{ row }"><b>{{ row.name }}</b> <span class="muted">{{ row.id }}</span><div class="muted">{{ row.summary }}</div></template>
      </el-table-column>
      <el-table-column label="能力（匹配依据）" min-width="260">
        <template #default="{ row }"><ul class="feature-list"><li v-for="c in row.capabilities" :key="c">{{ c }}</li></ul></template>
      </el-table-column>
      <el-table-column label="能力边界与使用条件" min-width="260">
        <template #default="{ row }"><ul v-if="row.limits.length" class="feature-list"><li v-for="c in row.limits" :key="c">{{ c }}</li></ul><span v-else class="muted">—</span></template>
      </el-table-column>
      <el-table-column label="产品属性" width="180"><template #default="{ row }"><el-tag size="small">{{ row.metadata?.delivery_source || '自有产品' }}</el-tag><div>{{ row.metadata?.kind || '未分类' }} · {{ row.metadata?.availability || '待核实' }}</div><div class="muted">{{ row.metadata?.data_kind }}</div><el-tag v-if="row.metadata?.active === false" type="info" size="small">已归档</el-tag></template></el-table-column>
      <el-table-column label="信创适配" prop="xinchuang" width="180"><template #default="{ row }"><span class="muted">{{ row.xinchuang }}</span></template></el-table-column>
      <el-table-column label="手册" width="110">
        <template #default="{ row }">
          <div v-for="d in docsOf(row.id)" :key="d.id" class="manual-name muted"><UiIcon name="file" />{{ d.name }}</div>
          <el-button v-if="row.metadata?.active !== false" link size="small" @click="uploadManual(row.id)">上传手册</el-button>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }"><div class="ops"><el-button link type="primary" @click="edit(row)">编辑</el-button><el-button v-if="row.metadata?.active === false" link type="success" @click="restore(row)">恢复匹配</el-button><el-button v-else link type="danger" @click="remove(row)">归档</el-button></div></template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-collapse style="margin-top:16px"><el-collapse-item title="核对产品资料检索（目录维护用）" name="search">
    <p class="muted">输入一条客户要求，查看可用的产品资料；检索命中不代表产品已满足要求。</p>
    <div class="row"><el-input v-model="probe.query" placeholder="例如：夜间能发现路面上的事故和违停" @keyup.enter="search" /><el-button type="primary" :loading="probe.busy" :disabled="!probe.query.trim()" @click="search">检索</el-button></div>
    <el-alert v-if="probe.result && probe.result.mode.kind !== 'hybrid'" type="info" :closable="false" style="margin-top:10px" :title="'当前为关键词检索：' + probe.result.mode.reason" />
    <div v-if="probe.result" style="margin-top:10px">
      <div v-for="h in probe.result.hits" :key="h.chunk.id" class="chunk">
        <el-tag size="small" type="info">{{ h.chunk.kind === 'manual' ? '手册' : h.chunk.kind === 'history' ? '历史项目' : h.chunk.kind === 'compatibility' ? '适配条件' : h.chunk.kind === 'limit' ? '限制' : h.chunk.kind === 'capability' ? '能力' : '资料' }}</el-tag>
        <b>{{ h.product || '' }}</b> {{ h.chunk.text }}
        <span class="muted"> 得分 {{ h.score.toFixed(3) }}<template v-if="h.keyword !== null"> · 关键词 {{ h.keyword }}</template><template v-if="h.vector !== null"> · 向量 {{ h.vector }}</template></span>
      </div>
      <div v-if="!probe.result.hits.length" class="muted">没有检索到相关资料</div>
    </div>
  </el-collapse-item></el-collapse>

  <el-dialog :model-value="!!editing" @close="editing = null" :title="editing?.id ? '编辑产品 ' + editing.id : '新增产品'" width="760px">
    <el-form v-if="editing" label-position="top">
      <div class="row"><el-form-item label="产品名称" style="flex:1" required><el-input v-model="editing.name" /></el-form-item><el-form-item label="单位"><el-input v-model="editing.unit" style="width:90px" placeholder="套/台/架" /></el-form-item></div>
      <el-form-item label="简介"><el-input v-model="editing.summary" /></el-form-item>
      <div class="grid-2">
        <el-form-item label="能力（每行一条）"><el-input v-model="editing.capabilities" type="textarea" :rows="8" /></el-form-item>
        <el-form-item label="能力边界与使用条件（每行一条）"><el-input v-model="editing.limits" type="textarea" :rows="8" /></el-form-item>
      </div>
      <div class="grid-2">
        <el-form-item label="产品类型"><el-select v-model="editing.metadata.kind" allow-create filterable><el-option v-for="k in ['软件','硬件','载荷','组合硬件','定制开发','基础设施','服务']" :key="k" :value="k" :label="k" /></el-select></el-form-item>
        <el-form-item label="产品来源"><el-select v-model="editing.metadata.delivery_source"><el-option v-for="k in ['自有产品','外采','自研','服务']" :key="k" :value="k" :label="k" /></el-select></el-form-item>
        <el-form-item label="供给状态"><el-input v-model="editing.metadata.availability" placeholder="现有 / 需采购 / 待研发 / 待验证" /></el-form-item>
        <el-form-item label="数据性质"><el-input v-model="editing.metadata.data_kind" /></el-form-item>
        <el-form-item label="数量口径"><el-select v-model="editing.metadata.quantity_policy"><el-option value="unknown" label="按原文、规则或人工确认" /><el-option v-if="editing.metadata.kind === '软件'" value="single_license" label="明确按一套软件许可计量" /></el-select></el-form-item>
        <el-form-item label="标记待专项验证（不自动执行）"><el-switch v-model="editing.metadata.requires_validation" /></el-form-item>
        <el-form-item label="启用产品匹配（关闭即归档）"><el-switch v-model="editing.metadata.active" /></el-form-item>
      </div>
      <el-form-item label="适配条件（每行一条）"><el-input v-model="editing.compatibilityText" type="textarea" :rows="3" /></el-form-item>
      <el-form-item label="交付物（每行一条）"><el-input v-model="editing.deliverablesText" type="textarea" :rows="3" /></el-form-item>
      <el-form-item label="信创适配及验证依据"><el-input v-model="editing.xinchuang" placeholder="未经验证保留待确认，不直接承诺适配" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="editing = null">取消</el-button><el-button type="primary" :disabled="!editing?.name.trim()" @click="save">保存</el-button></template>
  </el-dialog>

  <el-dialog :model-value="!!draft" @close="draft = null" title="确认模型整理的产品资料" width="960px">
    <template v-if="draft">
      <el-alert type="info" :closable="false" show-icon style="margin-bottom:10px" :title="'来自《' + draft.doc.name + '》。取消勾选的条目不会入库；带 ⚠ 的条目，模型给出的原文引用在手册里找不到，请对照手册核实。'" />
      <el-form label-position="top">
        <div class="row">
          <el-form-item label="产品名称" style="flex:1"><el-input v-model="draft.form.name" /></el-form-item>
          <el-form-item label="合并到已有产品（可选）">
            <el-select v-model="draft.productId" clearable filterable placeholder="作为新产品入库" style="width:240px" @change="useExisting">
              <el-option v-for="p in products" :key="p.id" :value="p.id" :label="p.id + ' ' + p.name" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="简介"><el-input v-model="draft.form.summary" /></el-form-item>
        <el-form-item label="信创适配"><el-input v-model="draft.form.xinchuang" /></el-form-item>
        <div class="grid-2">
          <div>
            <b>能力（{{ draft.form.capabilities.length }}）</b>
            <div v-for="(c, i) in draft.form.capabilities" :key="'c' + i" class="draft-item">
              <el-checkbox v-model="c.keep" /><el-input v-model="c.text" size="small" /><el-tooltip :content="c.verified ? '引用文字可在手册定位，能力是否满足需求仍需核对' : '手册中找不到这段引用'"><span>{{ c.verified ? '✓' : '⚠' }}</span></el-tooltip>
            </div>
          </div>
          <div>
            <b>限制（{{ draft.form.limits.length }}）</b>
            <div v-for="(c, i) in draft.form.limits" :key="'l' + i" class="draft-item">
              <el-checkbox v-model="c.keep" /><el-input v-model="c.text" size="small" /><el-tooltip :content="c.verified ? '引用文字可在手册定位，能力是否满足需求仍需核对' : '手册中找不到这段引用'"><span>{{ c.verified ? '✓' : '⚠' }}</span></el-tooltip>
            </div>
            <div v-if="!draft.form.limits.length" class="muted">未整理出能力边界，不代表产品无限制。请补充不支持的功能、适配条件及需验证的内容。</div>
          </div>
        </div>
        <div v-if="draft.doc.draft.truncated" class="muted">手册较长，模型只阅读了前 24000 字。</div>
      </el-form>
    </template>
    <template #footer><el-button @click="draft = null">稍后确认</el-button><el-button type="primary" :disabled="!draft?.form.name.trim()" @click="confirmDraft">采纳所选并入库</el-button></template>
  </el-dialog>`,
});
