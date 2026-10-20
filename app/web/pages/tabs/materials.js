import { computed, defineComponent, inject, onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, fileToBase64, fmtTime, meta, runJob } from "../../api.js";

export default defineComponent({
  setup() {
    const { id, view, reload } = inject("project");
    const { open } = inject("workspace");
    const samples = ref([]);
    const form = ref({ kind: "oral", title: "", text: "", file: null });
    const preview = ref(null);
    onMounted(async () => (samples.value = (await call(() => api("/samples"))) ?? []));

    const materials = computed(() => view.value.materials);
    const pending = computed(() => materials.value.filter((m) => !m.extracted_at).length);

    const useSample = (s) => {
      form.value = { kind: s.inputType, title: s.label, text: s.text, file: null };
    };
    const onFile = (e) => {
      const f = e.target.files[0];
      if (f) form.value.file = f;
      e.target.value = "";
    };

    const add = async () => {
      const body = { kind: form.value.kind, title: form.value.title };
      if (form.value.file) body.file = { name: form.value.file.name, base64: await fileToBase64(form.value.file) };
      else body.text = form.value.text;
      const ok = await call(() => api(`/projects/${id}/materials`, { method: "POST", body }), "材料已添加");
      if (ok) {
        form.value = { kind: form.value.kind, title: "", text: "", file: null };
        reload();
      }
    };

    const remove = async (m) => {
      await ElMessageBox.confirm(`删除材料「${m.title}」？由它抽取、且没有人工改过的需求会一并删除。`, "删除材料", { type: "warning" });
      await call(() => api(`/projects/${id}/materials/${m.id}`, { method: "DELETE" }), "已删除");
      reload();
    };

    const show = async (m) => (preview.value = await call(() => api(`/projects/${id}/materials/${m.id}`)));

    const analyze = async (all = false) => {
      const result = await runJob(all ? "重新抽取全部材料的需求" : "从新材料中抽取需求", () => api(`/projects/${id}/analyze`, { method: "POST", body: { all } }));
      if (result) {
        await reload();
        open("requirements");
      }
    };

    return { view, materials, pending, samples, form, preview, meta, useSample, onFile, add, remove, show, analyze, fmtTime };
  },
  template: `
  <div class="grid-2">
    <el-card shadow="never">
      <template #header><b>添加材料</b><span class="muted" style="margin-left:8px">招标文件、会议纪要、客户口述都可以，后续收到新材料随时追加</span></template>
      <el-form label-position="top">
        <div class="row">
          <el-form-item label="类型">
            <el-radio-group v-model="form.kind">
              <el-radio-button v-for="k in meta.materialKinds" :key="k.id" :value="k.id">{{ k.label }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="标题" style="flex:1"><el-input v-model="form.title" placeholder="可不填" /></el-form-item>
        </div>
        <el-form-item v-if="!form.file" label="内容">
          <el-input v-model="form.text" type="textarea" :rows="12" placeholder="粘贴材料内容……" />
        </el-form-item>
        <div v-else class="file-chip">📄 {{ form.file.name }} <el-button link type="danger" @click="form.file = null">移除</el-button></div>
        <div class="row" style="margin-top:8px">
          <label class="el-button">上传文件（{{ meta.fileTypes.join(' / ') }}）<input type="file" hidden :accept="meta.fileTypes.join(',')" @change="onFile" /></label>
          <el-dropdown v-if="samples.length" @command="useSample">
            <el-button>填入示例</el-button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item v-for="s in samples" :key="s.id" :command="s">{{ s.label }}</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
          <el-button type="primary" style="margin-left:auto" :disabled="!form.file && form.text.trim().length < 20" @click="add">添加材料</el-button>
        </div>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="row"><b>已添加的材料（{{ materials.length }}）</b><span style="flex:1"></span>
          <el-button v-if="materials.length && !pending" @click="analyze(true)">全部重新抽取</el-button>
          <el-button type="primary" :disabled="!pending" @click="analyze(false)">{{ pending ? '抽取需求（' + pending + ' 份新材料）' : '没有新材料' }}</el-button>
        </div>
      </template>
      <div v-if="!materials.length" class="empty">先在左边添加材料</div>
      <div v-for="m in materials" :key="m.id" class="material">
        <div class="material-head">
          <el-tag size="small" type="info">材料{{ m.no }}</el-tag>
          <b class="clickable title" :title="m.title" @click="show(m)">{{ m.title }}</b>
          <el-tag size="small" :type="m.extracted_at ? 'success' : 'warning'">{{ m.extracted_at ? '已抽取' : '未处理' }}</el-tag>
          <el-button link type="danger" @click="remove(m)">删除</el-button>
        </div>
        <div class="muted">{{ m.kindLabel }}{{ m.file_name ? ' · ' + m.file_name : '' }} · {{ m.segments }} 个片段{{ m.numbered ? '（按条款号切分）' : '（按句切分）' }} · {{ fmtTime(m.created_at) }}</div>
      </div>
      <el-alert v-if="materials.length" type="info" :closable="false" style="margin-top:12px"
        title="已经人工确认、修改或新增的需求，重新抽取时不会被覆盖。" />
    </el-card>
  </div>

  <el-drawer :model-value="!!preview" @close="preview = null" :title="preview?.title" size="50%">
    <pre class="pre" v-if="preview">{{ preview.text }}</pre>
  </el-drawer>`,
});
