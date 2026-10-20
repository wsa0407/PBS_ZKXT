import { computed, defineComponent, onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, fileToBase64, fmtTime, meta, pickFile, runJob } from "../api.js";

const blank = () => ({ id: null, name: "", summary: "", capabilities: "", limits: "", xinchuang: "", unit: "套" });

export default defineComponent({
  setup() {
    const products = ref([]);
    const docs = ref([]);
    const loading = ref(true);
    const kw = ref("");
    const editing = ref(null);
    const draft = ref(null);
    const probe = ref({ query: "", result: null, busy: false });

    const load = async () => {
      loading.value = true;
      [products.value, docs.value] = await Promise.all([call(() => api("/products")), call(() => api("/docs"))]).then((r) => [r[0] ?? [], r[1] ?? []]);
      loading.value = false;
    };
    onMounted(load);

    const shown = computed(() => products.value.filter((p) => !kw.value || `${p.name}${p.summary}${p.capabilities.join("")}`.includes(kw.value)));
    const docsOf = (pid) => docs.value.filter((d) => d.product_id === pid);
    const pendingDocs = computed(() => docs.value.filter((d) => d.status !== "已入库"));

    const edit = (p) => {
      editing.value = p ? { ...p, capabilities: p.capabilities.join("\n"), limits: p.limits.join("\n") } : blank();
    };
    const save = async () => {
      const e = editing.value;
      const body = { name: e.name, summary: e.summary, capabilities: e.capabilities, limits: e.limits, xinchuang: e.xinchuang, unit: e.unit };
      if (await call(() => api(e.id ? `/products/${e.id}` : "/products", { method: e.id ? "PUT" : "POST", body }), "已保存")) {
        editing.value = null;
        load();
      }
    };
    const remove = async (p) => {
      await ElMessageBox.confirm(`删除产品「${p.name}」？已经生成的 PBS 不受影响，但之后无法再匹配到它。`, "删除产品", { type: "warning" });
      await call(() => api(`/products/${p.id}`, { method: "DELETE" }), "已删除");
      load();
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
      probe.value.busy = true;
      probe.value.result = await call(() => api("/products/search", { method: "POST", body: { query: probe.value.query } }));
      probe.value.busy = false;
    };

    return { products, docs, loading, kw, shown, docsOf, pendingDocs, editing, draft, probe, meta, edit, save, remove, importExcel, uploadManual, openDraft, useExisting, confirmDraft, removeDoc, search, fmtTime };
  },
  template: `
  <div class="page-head">
    <div><h1>产品库</h1><div class="sub">共 {{ products.length }} 个产品。拆解时系统先从这里和产品手册中检索，再让模型匹配；“能力”和“限制”写得越具体，匹配越准。</div></div>
    <div class="actions">
      <el-input v-model="kw" placeholder="搜索产品" clearable style="width:180px" />
      <a href="/api/products/template.xlsx"><el-button>下载 Excel 模板</el-button></a>
      <el-button @click="importExcel">导入 Excel</el-button>
      <el-button @click="uploadManual(null)">上传产品手册</el-button>
      <el-button type="primary" @click="edit(null)">新增产品</el-button>
    </div>
  </div>

  <el-alert v-if="pendingDocs.length" type="warning" :closable="false" show-icon style="margin-bottom:12px" title="有手册等待确认入库">
    <div v-for="d in pendingDocs" :key="d.id">《{{ d.name }}》{{ d.status }} <el-button v-if="d.status === '待确认'" link type="primary" @click="openDraft(d.id)">查看模型整理的草稿</el-button><el-button link type="danger" @click="removeDoc(d)">删除</el-button></div>
  </el-alert>

  <el-card shadow="never" body-style="padding:0" v-loading="loading">
    <el-table :data="shown" empty-text="产品库是空的，先新增或导入">
      <el-table-column label="产品" width="220">
        <template #default="{ row }"><b>{{ row.name }}</b> <span class="muted">{{ row.id }}</span><div class="muted">{{ row.summary }}</div></template>
      </el-table-column>
      <el-table-column label="能力（匹配依据）" min-width="260">
        <template #default="{ row }"><el-tag v-for="c in row.capabilities" :key="c" type="success" size="small" class="wrap">{{ c }}</el-tag></template>
      </el-table-column>
      <el-table-column label="限制（拆出外采/自研的依据）" min-width="260">
        <template #default="{ row }"><el-tag v-for="c in row.limits" :key="c" type="warning" size="small" class="wrap">{{ c }}</el-tag><span v-if="!row.limits.length" class="muted">—</span></template>
      </el-table-column>
      <el-table-column label="信创适配" prop="xinchuang" width="180"><template #default="{ row }"><span class="muted">{{ row.xinchuang }}</span></template></el-table-column>
      <el-table-column label="手册" width="110">
        <template #default="{ row }">
          <div v-for="d in docsOf(row.id)" :key="d.id" class="muted" :title="d.name">📄 {{ d.name.slice(0, 8) }}</div>
          <el-button link size="small" @click="uploadManual(row.id)">上传</el-button>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }"><div class="ops"><el-button link type="primary" @click="edit(row)">编辑</el-button><el-button link type="danger" @click="remove(row)">删除</el-button></div></template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-card shadow="never" style="margin-top:16px">
    <template #header><b>检索测试</b><span class="muted" style="margin-left:8px">输入一句需求，看系统会检索到哪些产品资料</span></template>
    <div class="row"><el-input v-model="probe.query" placeholder="例如：夜间能发现路面上的事故和违停" @keyup.enter="search" /><el-button type="primary" :loading="probe.busy" :disabled="!probe.query.trim()" @click="search">检索</el-button></div>
    <el-alert v-if="probe.result && probe.result.mode.kind !== 'hybrid'" type="info" :closable="false" style="margin-top:10px" :title="'当前为关键词检索：' + probe.result.mode.reason" />
    <div v-if="probe.result" style="margin-top:10px">
      <div v-for="h in probe.result.hits" :key="h.chunk.id" class="chunk">
        <el-tag size="small" type="info">{{ h.chunk.kind === 'manual' ? '手册' : h.chunk.kind === 'history' ? '历史项目' : h.chunk.kind === 'limit' ? '限制' : h.chunk.kind === 'capability' ? '能力' : '资料' }}</el-tag>
        <b>{{ h.product || '' }}</b> {{ h.chunk.text }}
        <span class="muted"> 得分 {{ h.score.toFixed(3) }}<template v-if="h.keyword !== null"> · 关键词 {{ h.keyword }}</template><template v-if="h.vector !== null"> · 向量 {{ h.vector }}</template></span>
      </div>
      <div v-if="!probe.result.hits.length" class="muted">没有检索到相关资料</div>
    </div>
  </el-card>

  <el-dialog :model-value="!!editing" @close="editing = null" :title="editing?.id ? '编辑产品 ' + editing.id : '新增产品'" width="720px">
    <el-form v-if="editing" label-position="top">
      <div class="row"><el-form-item label="产品名称" style="flex:1" required><el-input v-model="editing.name" /></el-form-item><el-form-item label="单位"><el-input v-model="editing.unit" style="width:90px" placeholder="套/台/架" /></el-form-item></div>
      <el-form-item label="简介"><el-input v-model="editing.summary" /></el-form-item>
      <div class="grid-2">
        <el-form-item label="能力（每行一条）"><el-input v-model="editing.capabilities" type="textarea" :rows="8" /></el-form-item>
        <el-form-item label="限制（每行一条：不包含、不支持、需定制或外购的内容）"><el-input v-model="editing.limits" type="textarea" :rows="8" /></el-form-item>
      </div>
      <el-form-item label="信创适配"><el-input v-model="editing.xinchuang" placeholder="例如：已适配麒麟、统信操作系统，达梦数据库" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="editing = null">取消</el-button><el-button type="primary" :disabled="!editing?.name.trim()" @click="save">保存</el-button></template>
  </el-dialog>

  <el-dialog :model-value="!!draft" @close="draft = null" title="确认模型整理的产品资料" width="820px">
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
              <el-checkbox v-model="c.keep" /><el-input v-model="c.text" size="small" /><el-tooltip :content="c.verified ? '引用已在手册中核实' : '手册中找不到这段引用'"><span>{{ c.verified ? '✓' : '⚠' }}</span></el-tooltip>
            </div>
          </div>
          <div>
            <b>限制（{{ draft.form.limits.length }}）</b>
            <div v-for="(c, i) in draft.form.limits" :key="'l' + i" class="draft-item">
              <el-checkbox v-model="c.keep" /><el-input v-model="c.text" size="small" /><el-tooltip :content="c.verified ? '引用已在手册中核实' : '手册中找不到这段引用'"><span>{{ c.verified ? '✓' : '⚠' }}</span></el-tooltip>
            </div>
            <div v-if="!draft.form.limits.length" class="muted">手册中没有写明限制。建议补充，否则系统无法判断哪些需求要外采或自研。</div>
          </div>
        </div>
        <div v-if="draft.doc.draft.truncated" class="muted">手册较长，模型只阅读了前 24000 字。</div>
      </el-form>
    </template>
    <template #footer><el-button @click="draft = null">稍后确认</el-button><el-button type="primary" :disabled="!draft?.form.name.trim()" @click="confirmDraft">确认入库</el-button></template>
  </el-dialog>`,
});
