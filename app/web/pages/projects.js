import { defineComponent, ref, onMounted } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, fmtTime, meta } from "../api.js";
import { projectStage } from "../presentation.js";

export default defineComponent({
  setup() {
    const projects = ref([]);
    const loading = ref(true);
    const dialog = ref(false);
    const form = ref({ name: "", customer: "", industry: "" });

    const load = async () => {
      loading.value = true;
      projects.value = (await call(() => api("/projects"))) ?? [];
      loading.value = false;
    };
    onMounted(load);

    const stageOf = projectStage;

    const create = async () => {
      const p = await call(() => api("/projects", { method: "POST", body: form.value }));
      if (p) location.hash = `#/projects/${p.id}/materials`;
    };

    const remove = async (p) => {
      await ElMessageBox.confirm(`删除项目「${p.name}」及其所有材料、需求、澄清与 PBS？此操作不可恢复。`, "删除项目", { type: "warning", confirmButtonText: "删除" });
      await call(() => api(`/projects/${p.id}`, { method: "DELETE" }), "已删除");
      load();
    };

    const openProject = (p) => (location.hash = `#/projects/${p.id}`);

    return { projects, loading, dialog, form, meta, create, remove, stageOf, fmtTime, openProject };
  },
  template: `
  <div class="page-head">
    <div><h1>项目</h1><div class="sub">上传客户材料，理解需求与业务场景，编制 PBS，检查后导出。</div></div>
    <el-button type="primary" @click="form = { name: '', customer: '', industry: '' }; dialog = true">新建项目</el-button>
  </div>
  <el-card shadow="never" body-style="padding:0">
    <el-table :data="projects" v-loading="loading" empty-text="还没有项目，点右上角新建" @row-click="openProject" row-class-name="clickable">
      <el-table-column label="项目" min-width="240">
        <template #default="{ row }"><button class="text-action" @click.stop="openProject(row)">{{ row.name }}</button><div class="muted">{{ row.customer || '—' }}</div></template>
      </el-table-column>
      <el-table-column prop="industry" label="行业" width="90" />
      <el-table-column label="阶段" width="110">
        <template #default="{ row }"><el-tag :type="stageOf(row).type" size="small">{{ stageOf(row).label }}</el-tag></template>
      </el-table-column>
      <el-table-column label="材料" prop="materials" width="70" align="right" />
      <el-table-column label="需求（描述已确认）" width="160" align="right">
        <template #default="{ row }">{{ row.requirements }}<span class="muted">（{{ row.confirmed }}）</span></template>
      </el-table-column>
      <el-table-column label="待澄清" prop="open_questions" width="80" align="right" />
      <el-table-column label="PBS 项" prop="pbs_items" width="80" align="right" />
      <el-table-column label="更新时间" width="130"><template #default="{ row }"><span class="muted">{{ fmtTime(row.updated_at) }}</span></template></el-table-column>
      <el-table-column label="操作" width="70"><template #default="{ row }"><div class="ops"><el-button link type="danger" @click.stop="remove(row)">删除</el-button></div></template></el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="dialog" title="新建项目" width="480px">
    <el-form label-width="80px" @submit.prevent="create">
      <el-form-item label="项目名称" required><el-input v-model="form.name" placeholder="例如：某市交警支队道路无人机巡逻" autofocus /></el-form-item>
      <el-form-item label="客户"><el-input v-model="form.customer" placeholder="可选" /></el-form-item>
      <el-form-item label="行业">
        <el-select v-model="form.industry" placeholder="项目所属行业（可选）" clearable style="width:100%">
          <el-option v-for="i in meta.industries" :key="i" :label="i" :value="i" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer><el-button @click="dialog = false">取消</el-button><el-button type="primary" :disabled="!form.name.trim()" @click="create">创建并添加材料</el-button></template>
  </el-dialog>`,
});
