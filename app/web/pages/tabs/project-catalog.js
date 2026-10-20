import { computed, defineComponent, inject, ref } from "vue";
import { api, call } from "../../api.js";

export default defineComponent({
  setup() {
    const { id, view, reload } = inject("project");
    const editing = ref(null); const open = ref([]); const saved = ref(false);
    const state = computed(() => view.value.catalog);
    const shown = computed(() => saved.value && state.value?.snapshot ? state.value.snapshot : state.value?.preview);
    const nameOf = (itemId) => { const p = view.value.items.find((i) => i.id === itemId); return p ? `${p.code} ${p.name}` : `已移除项 ${itemId}`; };
    const edit = (s) => { editing.value = s ? JSON.parse(JSON.stringify(s)) : { id: "PS-" + Date.now(), name: "", scenario_ids: [], req_ids: [], item_ids: [], design_notes: "" }; };
    const save = async () => {
      const all = (state.value.designs ?? []).filter((s) => s.id !== editing.value.id);
      const result = await call(() => api(`/projects/${id}/solutions`, { method: "PUT", body: { designs: [...all, editing.value], input_hash: state.value.preview.input_hash } }), "项目方案草稿已保存");
      if (result) { editing.value = null; saved.value = false; await reload(); }
    };
    const remove = async (s) => {
      const result = await call(() => api(`/projects/${id}/solutions`, { method: "PUT", body: { designs: state.value.designs.filter((d) => d.id !== s.id), input_hash: state.value.preview.input_hash } }), "已移除项目方案关联");
      if (result) await reload();
    };
    const snapshot = async () => {
      const result = await call(() => api(`/projects/${id}/bom/snapshot`, { method: "POST" }), "已保存方案与BOM快照");
      if (result) { saved.value = true; await reload(); }
    };
    return { state, shown, saved, editing, open, view, nameOf, edit, save, remove, snapshot };
  },
  template: `
  <el-card v-if="state" shadow="never" style="margin-bottom:16px">
    <template #header><b>解决方案 → 产品 → BOM</b><span class="muted" style="margin-left:10px">按客户场景组织产品组合</span><el-button link type="primary" @click="edit(null)" style="float:right">新增项目方案</el-button></template>
    <div class="actions" style="margin-bottom:12px"><el-button :type="!saved ? 'primary' : 'default'" plain @click="saved = false">当前展开草稿</el-button><el-button v-if="state.snapshot" :type="saved ? 'primary' : 'default'" plain @click="saved = true">查看已存快照</el-button><el-button @click="snapshot">保存方案与 BOM 快照</el-button><el-tag v-if="state.snapshot_stale" type="warning">目录或项目已变更，快照待复核</el-tag></div>
    <div v-if="shown" class="muted">目录 {{ shown.catalog_version }} · 修订 {{ shown.catalog_revision }} · {{ saved ? '快照时间 ' + shown.created_at : '随当前目录和PBS展开' }}</div>
    <div v-if="!state.designs.length" class="muted" style="margin:12px 0">先关联客户场景或原始需求，再选择承接这些需求的 PBS 产品项。按该客户需求自由组合产品；项目方案仍是待确认草稿。</div>
    <div v-for="s in shown?.solutions ?? []" :key="s.id" style="margin-top:12px;padding:12px;background:var(--el-fill-color-light)"><b>{{ s.name }}</b> <el-tag size="small">{{ s.status }}</el-tag><div class="muted">场景：{{ s.scenario_ids.join('、') || '—' }} · 原始需求：{{ s.req_ids.join('、') || '—' }}</div><div>{{ s.design_notes }}</div><div v-for="p in s.products" :key="p.id">↳ {{ p.code }} {{ p.name }} · {{ p.source }} · {{ p.qty ?? '待确认' }} {{ p.unit }}</div><el-alert v-if="s.missing_items.length" type="warning" :closable="false" title="方案中有已移除的PBS项，请重新关联" /><div v-if="!saved"><el-button link type="primary" @click="edit(s)">编辑关联</el-button><el-button link type="danger" @click="remove(s)">移除关联</el-button></div></div>
    <el-alert v-if="shown?.unassigned.length" type="info" :closable="false" :title="'尚有 ' + shown.unassigned.length + ' 个PBS项未关联项目方案'" style="margin-top:12px" />
    <el-alert v-for="w in shown?.warnings ?? []" :key="w" type="warning" :closable="false" :title="w" style="margin-top:8px" />
    <el-collapse v-model="open" style="margin-top:12px"><el-collapse-item name="bom" title="查看产品 BOM 展开（按唯一PBS项展示，跨方案共享产品不重复累计）">
      <div v-for="p in shown?.products ?? []" :key="p.id" style="margin:12px 0"><b>{{ p.code }} {{ p.name }}</b> <span class="muted">{{ p.qty ?? '待确认' }} {{ p.unit }} · {{ p.product?.metadata?.availability }}</span><div v-for="w in p.warnings" :key="w" class="muted">{{ w }}</div><el-table v-if="p.bom.length" :data="p.bom" size="small"><el-table-column label="组成项" min-width="250"><template #default="{row}"><div :style="{paddingLeft: ((row.level || 0) * 18) + 'px'}">{{ row.has_children ? '▾ ' : '· ' }}{{ row.name }}<div v-if="row.has_children" class="muted">组成组，不与子项重复累计</div></div></template></el-table-column><el-table-column label="版本" width="100"><template #default="{row}">{{ row.bom_version }}</template></el-table-column><el-table-column label="单产品用量" width="120"><template #default="{row}">{{ row.per_product_qty ?? '待确认' }} {{ row.unit }}</template></el-table-column><el-table-column label="展开用量" width="140"><template #default="{row}">{{ row.included ? (row.total_qty ?? '待确认') + ' ' + row.unit : '可选，未选配' }}</template></el-table-column><el-table-column prop="source" label="来源" width="80" /><el-table-column prop="condition" label="条件" min-width="160" /></el-table></div>
      <p class="muted">{{ shown?.note }}</p>
    </el-collapse-item></el-collapse>
  </el-card>
  <el-dialog :model-value="!!editing" @close="editing = null" title="维护项目解决方案（草稿）" width="780px"><el-form v-if="editing" label-position="top"><el-form-item label="项目方案名称"><el-input v-model="editing.name" /></el-form-item><el-form-item label="客户场景"><el-select v-model="editing.scenario_ids" multiple filterable><el-option v-for="s in view.scenarios.filter(s => s.status !== '已归档')" :key="s.code" :value="s.code" :label="s.code + ' ' + s.name" /></el-select></el-form-item><el-form-item label="对应原始需求"><el-select v-model="editing.req_ids" multiple filterable><el-option v-for="r in view.requirements.filter(r => r.status !== '已删除')" :key="r.code" :value="r.code" :label="r.code + ' ' + r.text" /></el-select></el-form-item><el-form-item label="承接需求的 PBS 产品组合"><el-select v-model="editing.item_ids" multiple filterable><el-option v-for="p in view.items" :key="p.id" :value="p.id" :label="nameOf(p.id)" /></el-select></el-form-item><el-form-item label="场景响应、选型理由、差距及待确认事项"><el-input v-model="editing.design_notes" type="textarea" :rows="5" /></el-form-item></el-form><template #footer><el-button @click="editing = null">取消</el-button><el-button type="primary" @click="save">保存方案草稿</el-button></template></el-dialog>
  `,
});
