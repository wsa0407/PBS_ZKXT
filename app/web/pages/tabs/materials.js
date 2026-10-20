import { computed, defineComponent, inject, onMounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, fileToBase64, fmtTime, meta } from "../../api.js";

export default defineComponent({
  setup() {
    const { id, view, reload } = inject("project");
    const { open, focus } = inject("workspace");
    const samples = ref([]);
    const form = ref({ title: "", description: "", text: "", file: null });
    const preview = ref(null);
    const evidence = ref(null);
    const saving = ref(false), starting = ref(false);
    onMounted(async () => (samples.value = (await call(() => api("/samples"))) ?? []));

    const materials = computed(() => view.value.materials);
    const pending = computed(() => materials.value.filter((m) => !m.extracted_at).length);

    const useSample = (s) => {
      form.value = { title: s.label, description: "", text: s.text, file: null };
    };
    const chooseFile = (file) => {
      if (!file) return;
      form.value.file = file;
      if (!form.value.title) form.value.title = file.name.replace(/\.[^.]+$/, "");
    };
    const onFile = (e) => {
      chooseFile(e.target.files[0]);
      e.target.value = "";
    };
    const onDrop = (e) => chooseFile(e.dataTransfer.files[0]);

    const add = async () => {
      if (saving.value) return;
      saving.value = true;
      try {
        const body = { title: form.value.title, description: form.value.description };
        if (form.value.file) body.file = { name: form.value.file.name, base64: await fileToBase64(form.value.file) };
        else body.text = form.value.text;
        const ok = await call(() => api(`/projects/${id}/materials`, { method: "POST", body }), "材料已添加");
        if (ok) {
          form.value = { title: "", description: "", text: "", file: null };
          await reload();
        }
      } finally { saving.value = false; }
    };

    const remove = async (m) => {
      await ElMessageBox.confirm(`移除材料「${m.title}」？已有需求和历史依据会保留，关联内容将提示来源失效、需要复核。`, "移除材料", { type: "warning" });
      await call(() => api(`/projects/${id}/materials/${m.id}`, { method: "DELETE" }), "材料已移除");
      reload();
    };

    const show = async (m) => { evidence.value = null; preview.value = await call(() => api(`/projects/${id}/materials/${m.id}`)); };
    watch(() => focus.value, async (value) => {
      const source = [...view.value.segments, ...view.value.sourceSnapshots].find((s) => s.uid === value);
      const material = view.value.materials.find((m) => m.id === (source?.material_id ?? value));
      if (material) { await show(material); evidence.value = source ?? null; }
      else if (source) { preview.value = { title: `${source.material_title || '材料'} · 历史原文`, text: source.text, meta: {} }; evidence.value = source; }
    }, { immediate: true });

    const analyze = async (all = false) => {
      if (starting.value || view.value.job?.status === "处理中") return;
      starting.value = true;
      try {
        const result = await call(() => api(`/projects/${id}/analyze`, { method: "POST", body: { all } }));
        if (result) {
          await reload();
          open("understanding");
        }
      } finally { starting.value = false; }
    };

    return { view, materials, pending, samples, form, preview, evidence, saving, starting, meta, useSample, onFile, onDrop, add, remove, show, analyze, fmtTime };
  },
  template: `
  <div class="materials-stack">
    <el-card shadow="never">
      <template #header><b>上传客户材料</b><p class="muted" style="margin:6px 0 0">上传文件或粘贴原文，再补充这份材料的背景和关注点。</p></template>
      <el-form label-position="top">
        <label v-if="!form.file" class="material-upload" @dragover.prevent @drop.prevent="onDrop">
          <b>点击上传或拖入一个文件</b><span class="muted">{{ meta.fileTypes.join(' / ') }}</span>
          <input type="file" hidden :accept="meta.fileTypes.join(',')" @change="onFile" />
        </label>
        <div v-else class="file-chip">📄 {{ form.file.name }} <el-button link type="danger" @click="form.file = null">移除文件</el-button></div>
        <el-collapse v-if="!form.file" style="margin-bottom:16px"><el-collapse-item title="或粘贴材料原文" name="text">
          <el-input v-model="form.text" type="textarea" :rows="7" placeholder="粘贴客户原话、会议记录或文件内容（至少 20 字）……" />
        </el-collapse-item></el-collapse>
        <el-form-item label="材料标题（可选）"><el-input v-model="form.title" placeholder="上传文件后自动填入，也可以修改" /></el-form-item>
        <el-form-item label="补充说明（可选）"><el-input v-model="form.description" type="textarea" :rows="2" placeholder="例如：这是客户最新补充，重点关注部署要求。" /></el-form-item>
        <div class="row" style="margin-top:8px">
          <el-dropdown v-if="samples.length" @command="useSample">
            <el-button>填入示例</el-button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item v-for="s in samples" :key="s.id" :command="s">{{ s.label }}</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
          <el-button type="primary" style="margin-left:auto" :loading="saving" :disabled="!form.file && form.text.trim().length < 20" @click="add">保存材料</el-button>
        </div>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="row"><b>已添加的材料（{{ materials.length }}）</b><span style="flex:1"></span>
          <el-button v-if="materials.length && !pending" :loading="starting" :disabled="view.job?.status === '处理中'" @click="analyze(true)">重新理解全部材料</el-button>
          <el-button v-if="pending" type="primary" :loading="starting" :disabled="view.job?.status === '处理中'" @click="analyze(false)">理解材料（{{ pending }} 份待处理）</el-button>
        </div>
      </template>
      <div v-if="!materials.length" class="empty">先在上方上传文件或粘贴原文</div>
      <div v-for="m in materials" :key="m.id" class="material">
        <div class="material-head">
          <el-tag size="small" type="info">材料{{ m.no }}</el-tag>
          <button class="text-action title" :title="'查看材料原文：' + m.title" @click="show(m)">{{ m.title }}</button>
          <el-tag size="small" :type="m.extracted_at ? 'success' : 'warning'">{{ m.extracted_at ? '原文已处理' : '待理解' }}</el-tag>
          <el-button link type="danger" @click="remove(m)">移除材料</el-button>
        </div>
        <div class="muted">{{ m.file_name || '粘贴的原文' }} · {{ fmtTime(m.created_at) }}</div>
        <div v-if="m.meta.description" class="material-description">{{ m.meta.description }}</div>
      </div>
      <el-alert v-if="materials.length" type="info" :closable="false" style="margin-top:12px"
        title="已经人工确认、修改或新增的需求，重新理解时会保留。" />
    </el-card>
  </div>

  <el-drawer :model-value="!!preview" @close="preview = null" :title="preview?.title" size="50%">
    <template v-if="preview"><div v-if="evidence" class="exchange-evidence"><b>引用位置 · {{ evidence.uid }} {{ evidence.chapter }}</b><blockquote>{{ evidence.text }}</blockquote><hr></div><p v-if="preview.meta.description" class="material-description">补充说明：{{ preview.meta.description }}</p><pre class="pre">{{ preview.text }}</pre></template>
  </el-drawer>`,
});
