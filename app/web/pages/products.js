import { computed, defineComponent, ref, onMounted } from "vue";
import { api, call, pickFile, loadMeta } from "../api.js";
import ProductList from "./products-list.js";

export default defineComponent({
  components: { ProductList },
  setup() {
    const tab = ref("products"); const catalog = ref(null); const editing = ref(null); const importPlan = ref(null); const busy = ref(false);
    const load = async () => { catalog.value = await call(() => api("/catalog")); };
    onMounted(load);
    const pack = computed(() => catalog.value?.pack);
    const products = computed(() => pack.value?.products ?? []);
    const activeProducts = computed(() => products.value.filter((p) => p.metadata.active));
    const bomProducts = computed(() => products.value.filter(p => p.id === editing.value?.entry.product_ref || (p.metadata.active && !pack.value?.boms.some(b => b.product_ref === p.id && b.id !== editing.value?.entry.id))));
    const canSaveBom = computed(() => {
      const b = editing.value?.entry;
      return Boolean(b?.product_ref && b.version.trim() && b.basis.trim() && b.lines.every(l => l.name.trim() && l.unit.trim()));
    });
    const productName = (id) => products.value.find((p) => p.id === id)?.name ?? id;
    const openEntry = (row) => {
      const entry = row ? JSON.parse(JSON.stringify(row)) : { id: "BOM-" + Date.now(), version: "1.0.0", product_ref: "", kind: "模拟产品组成", basis: "人工维护；待业务审核", lines: [] };
      editing.value = { entry, fingerprint: catalog.value.fingerprint };
    };
    const save = async () => {
      if (!canSaveBom.value) return;
      const e = editing.value;
      const result = await call(() => api(`/catalog/boms/${e.entry.id}`, { method: "PUT", body: { entry: e.entry, fingerprint: e.fingerprint } }), "目录条目已保存");
      if (result) { editing.value = null; catalog.value = result; }
    };
    const addBomLine = () => editing.value.entry.lines.push({ id: "L-" + Date.now(), name: "", product_ref: null, qty: null, unit: "件", source: "外采", optional: false, condition: "", note: "" });
    const chooseComponent = (line) => {
      const p = products.value.find((p) => p.id === line.product_ref);
      if (p) Object.assign(line, { name: p.name, unit: p.unit, source: p.metadata.delivery_source });
    };
    const upload = async () => {
      const f = await pickFile(".json"); if (!f) return;
      importPlan.value = await call(async () => api("/catalog/preview", { method: "POST", body: { pack: JSON.parse(await f.text()) } }));
    };
    const applyImport = async () => {
      busy.value = true;
      const r = await call(() => api("/catalog/import", { method: "POST", body: { pack: importPlan.value.pack, token: importPlan.value.token } }), "数据包已更新；冲突条目保留当前内容");
      busy.value = false;
      if (r) { importPlan.value = null; catalog.value = r; await loadMeta(); }
    };
    const refresh = async (name) => { if (name !== "products") await load(); };
    return { tab, catalog, pack, products, activeProducts, bomProducts, canSaveBom, productName, editing, openEntry, save, addBomLine, chooseComponent, upload, importPlan, busy, applyImport, refresh };
  },
  template: `
  <div class="page-head"><div><h1>产品库</h1><div class="sub">产品能力与产品 BOM · 解决方案在客户项目中自由组合</div></div><div v-if="catalog" class="actions"><el-tag>{{ pack.version }}</el-tag><span class="muted">修订 {{ catalog.revision }}</span></div></div>
  <el-alert type="info" :closable="false" show-icon title="当前为低空业务 MOCK 目录。公司能力和 BOM 均为模拟；厂商条目附公开资料来源，采购配置与适配条件需核验。" style="margin-bottom:16px" />
  <el-tabs v-model="tab" @tab-change="refresh">
    <el-tab-pane label="产品目录" name="products" lazy><ProductList :key="catalog?.revision" /></el-tab-pane>
    <el-tab-pane label="产品 BOM" name="boms">
      <div class="actions" style="margin-bottom:12px"><el-button type="primary" :disabled="!catalog || !activeProducts.some(p => !pack.boms.some(b => b.product_ref === p.id))" @click="openEntry(null)">新增产品 BOM</el-button><span class="muted">每个产品维护一份 BOM，已有条目请展开后编辑。单产品组成用量待确认时可留空。</span></div>
      <el-collapse v-if="pack"><el-collapse-item v-for="b in pack.boms" :key="b.id" :name="b.id"><template #title><b>{{ productName(b.product_ref) }}</b><el-tag size="small" style="margin:0 12px">{{ b.version }}</el-tag><span class="muted">{{ b.kind }} · {{ b.lines.length }} 项</span></template>
        <p class="muted">{{ b.basis }}</p><el-button link type="primary" @click="openEntry(b)">编辑 BOM</el-button>
        <el-table :data="b.lines" size="small"><el-table-column prop="name" label="组成项" min-width="240" /><el-table-column label="单产品用量" width="130"><template #default="{row}">{{ row.qty ?? '待确认' }} {{ row.unit }}</template></el-table-column><el-table-column prop="source" label="来源" width="90" /><el-table-column label="条件" min-width="200"><template #default="{row}">{{ row.optional ? '可选：' + row.condition : '必需' }}<div class="muted">{{ row.product_ref ? '关联产品：' + row.product_ref : row.note }}</div></template></el-table-column></el-table>
      </el-collapse-item></el-collapse>
    </el-tab-pane>
    <el-tab-pane label="数据包维护" name="maintenance">
      <el-card v-if="pack" shadow="never"><h2>{{ pack.name }}</h2><p>{{ pack.description }}</p><p>{{ activeProducts.length }} 个启用产品 · {{ pack.boms.length }} 份 BOM</p><div class="actions"><a href="/api/catalog/export.json"><el-button>导出完整 JSON 数据包</el-button></a><el-button type="primary" @click="upload">选择 JSON 数据包并预览</el-button></div><p class="muted">产品与BOM可在页面独立编辑，客户解决方案在项目中自由组合。批量更换行业或维护资料来源、参数规则时，导出后编辑JSON再导入。导入前校验引用、数量和循环；冲突保留人工修改。重启不会覆盖数据。</p><h3>资料来源</h3><div v-for="r in pack.references" :key="r.id" style="margin:10px 0"><a :href="r.url" target="_blank" rel="noopener noreferrer">{{ r.title }}</a><span class="muted"> · 核对 {{ r.checked_at }}</span></div></el-card>
    </el-tab-pane>
  </el-tabs>
  <el-dialog :model-value="!!editing" @close="editing = null" title="维护产品 BOM" width="960px">
    <el-form v-if="editing" label-position="top"><div class="row"><el-form-item label="编号"><el-input v-model="editing.entry.id" disabled /></el-form-item><el-form-item label="版本"><el-input v-model="editing.entry.version" /></el-form-item></div>
        <div class="row"><el-form-item label="所属产品" style="flex:1"><el-select v-model="editing.entry.product_ref" filterable><el-option v-for="p in bomProducts" :key="p.id" :value="p.id" :label="p.id + ' ' + p.name" /></el-select></el-form-item><el-form-item label="组成类型" title="产品组成描述内部组成关系，交付配置描述随产品交付的设备、许可或服务组合；当前均为模拟数据。"><el-select v-model="editing.entry.kind"><el-option value="模拟产品组成" label="模拟产品组成" /><el-option value="模拟交付配置" label="模拟交付配置" /></el-select></el-form-item></div>
        <el-form-item label="BOM依据与版本说明"><el-input v-model="editing.entry.basis" type="textarea" /></el-form-item>
        <div v-for="(line,i) in editing.entry.lines" :key="line.id" style="margin-bottom:16px;padding:12px;background:var(--el-fill-color-light)">
          <div class="row"><el-input v-model="line.name" placeholder="组成项名称" /><el-select v-model="line.product_ref" clearable filterable placeholder="关联目录产品（可选）" style="width:340px" @change="chooseComponent(line)"><el-option v-for="p in products" :key="p.id" :value="p.id" :label="p.id + ' ' + p.name" /></el-select><el-button link type="danger" @click="editing.entry.lines.splice(i,1)">移除</el-button></div>
          <div class="row" style="margin-top:8px"><span>单产品用量</span><el-input-number :model-value="line.qty" :min="0" :precision="3" :controls="false" placeholder="待确认" @update:model-value="line.qty = $event ?? null" /><el-input v-model="line.unit" placeholder="单位" style="width:80px" /><el-select v-model="line.source" style="width:120px"><el-option v-for="r in ['自有产品','外采','自研','服务']" :key="r" :value="r" :label="r" /></el-select><el-checkbox v-model="line.optional">可选</el-checkbox><el-input v-model="line.condition" placeholder="可选条件" /></div>
        </div><el-button @click="addBomLine">添加组成项</el-button>
    </el-form><template #footer><span v-if="!canSaveBom" class="muted">请填写所属产品、版本、依据，以及各组成项名称和单位。</span><el-button @click="editing = null">取消</el-button><el-button type="primary" :disabled="!canSaveBom" @click="save">保存并形成目录修订</el-button></template>
  </el-dialog>
  <el-dialog :model-value="!!importPlan" @close="importPlan = null" title="数据包导入预览" width="760px"><template v-if="importPlan"><p>{{ importPlan.pack.name }} · {{ importPlan.pack.version }}</p><el-alert v-for="w in importPlan.warnings" :key="w" type="info" :closable="false" :title="w" /><p>将执行 {{ importPlan.changes.length }} 项变更，{{ importPlan.conflicts.length }} 项冲突保留本地内容。</p><el-table :data="importPlan.changes" max-height="260"><el-table-column label="类型"><template #default="{row}">{{ ({products:"产品", boms:"产品 BOM", references:"资料来源"})[row.kind] || row.kind }}</template></el-table-column><el-table-column prop="id" label="编号" /><el-table-column prop="action" label="变更" /></el-table><div v-for="c in importPlan.conflicts" :key="c.kind+c.id" class="muted">{{ ({products:"产品", boms:"产品 BOM", references:"资料来源"})[c.kind] || c.kind }} / {{ c.id }}：{{ c.reason }}</div></template><template #footer><el-button @click="importPlan = null">取消</el-button><el-button type="primary" :loading="busy" @click="applyImport">确认导入预览中的变更</el-button></template></el-dialog>
  `,
});
