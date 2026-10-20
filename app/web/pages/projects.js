import { computed, defineComponent, ref, onMounted } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, fmtTime, meta } from "../api.js";
import { projectStage } from "../../shared/presentation.js";

export default defineComponent({
  setup() {
    const projects = ref([]);
    const loading = ref(true);
    const dialog = ref(false);
    const search = ref("");
    const creating = ref(false);
    const shown = computed(() => projects.value.filter(p => !search.value.trim() || `${p.name} ${p.customer} ${p.industry}`.toLowerCase().includes(search.value.trim().toLowerCase())));
    const form = ref({ name: "", customer: "", industry: "" });

    const load = async () => {
      loading.value = true;
      projects.value = (await call(() => api("/projects"))) ?? [];
      loading.value = false;
    };
    onMounted(load);

    const stageOf = projectStage;

    const create = async () => {
      if (creating.value || !form.value.name.trim()) return;
      creating.value = true;
      try {
        const p = await call(() => api("/projects", { method: "POST", body: form.value }));
        if (p) location.hash = `#/projects/${p.id}/materials`;
      } finally { creating.value = false; }
    };

    const remove = async (p) => {
      await ElMessageBox.confirm(`删除项目「${p.name}」及其所有材料、需求、澄清与 PBS？此操作不可恢复。`, "删除项目", { type: "warning", confirmButtonText: "删除" });
      await call(() => api(`/projects/${p.id}`, { method: "DELETE" }), "已删除");
      load();
    };

    return { projects, shown, search, loading, creating, dialog, form, meta, create, remove, stageOf, fmtTime };
  },
  template: `
  <section class="projects-home">
    <div class="project-list-head">
      <h1>项目 <span>{{ projects.length }}</span></h1>
      <div class="actions"><el-input v-model="search" aria-label="搜索项目或客户" placeholder="搜索项目或客户" clearable class="project-search" /><el-button type="primary" @click="form = { name: '', customer: '', industry: '' }; dialog = true"><UiIcon name="plus" />新建项目</el-button></div>
    </div>
    <div v-if="loading" class="project-grid" aria-busy="true" aria-label="加载项目"><div v-for="n in 3" :key="n" class="project-card"><el-skeleton :rows="4" animated /></div></div>
    <div v-else-if="shown.length" class="project-grid">
      <article v-for="p in shown" :key="p.id" class="project-card">
        <div class="project-card-top"><span class="project-glyph"><UiIcon name="layers" /></span><el-tag :type="stageOf(p).type" size="small">{{ stageOf(p).label }}</el-tag></div>
        <a class="project-title" :href="'#/projects/' + p.id"><h3>{{ p.name }}</h3><UiIcon name="arrow" /></a>
        <p class="project-customer">{{ [p.customer, p.industry].filter(Boolean).join(' · ') || '客户信息待补充' }}</p>
        <div class="project-metrics"><div><b>{{ p.materials }}</b><span>份材料</span></div><div><b>{{ p.requirements }}</b><span>条需求 · {{ p.confirmed }} 已确认</span></div><div><b>{{ p.pbs_items }}</b><span>PBS 项</span></div></div>
        <div class="project-card-foot"><div><div v-if="p.open_questions" class="project-pending">{{ p.open_questions }} 项待澄清</div><span class="muted">更新于 {{ fmtTime(p.updated_at) }}</span></div><button class="icon-button delete-project" :aria-label="'删除项目：' + p.name" title="删除项目" @click="remove(p)"><UiIcon name="trash" /></button></div>
      </article>
    </div>
    <div v-else class="empty home-empty"><UiIcon name="layers" /><h3>{{ search ? '没有匹配的项目' : '还没有项目' }}</h3><p>{{ search ? '试试其他项目名称或客户名称。' : '点击“新建项目”，然后添加客户材料。' }}</p></div>
  </section>

  <el-dialog v-model="dialog" title="新建项目" width="560px">
    <el-form label-position="top" @submit.prevent="create">
      <el-form-item label="项目名称" required><el-input v-model="form.name" placeholder="例如：某市交警支队道路无人机巡逻" autofocus /></el-form-item>
      <el-form-item label="客户"><el-input v-model="form.customer" placeholder="可选" /></el-form-item>
      <el-form-item label="行业">
        <el-select v-model="form.industry" placeholder="项目所属行业（可选）" clearable style="width:100%">
          <el-option v-for="i in meta.industries" :key="i" :label="i" :value="i" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer><el-button @click="dialog = false">取消</el-button><el-button type="primary" :loading="creating" :disabled="!form.name.trim()" @click="create">创建并添加材料</el-button></template>
  </el-dialog>`,
});
