import { computed, defineComponent, inject, nextTick, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, call, fileToBase64, jobState, meta } from "../api.js";

const KIND_LABEL = { tender: "招标文件", minutes: "会议纪要", oral: "用户描述", other: "其他材料" };
const CHANGE_LABEL = { set_param: "设定参数", update_requirement: "修改需求", add_requirement: "新增需求", remove_requirement: "删除需求", update_scenario: "修改场景" };

export default defineComponent({
  props: { open: Function },
  setup(props) {
    const { id, view, reload } = inject("project");
    const messages = ref([]);
    const suggestions = ref([]);
    const text = ref("");
    const file = ref(null);
    const busy = ref(false);
    const progress = ref(null);
    const stopping = ref(false);
    const scroller = ref(null);
    const samples = ref([]);

    const scrollDown = () => nextTick(() => scroller.value && (scroller.value.scrollTop = scroller.value.scrollHeight));
    const stop = async () => {
      if (!progress.value?.id || stopping.value) return;
      if (await call(() => api(`/jobs/${progress.value.id}/cancel`, { method: "POST" }))) stopping.value = true;
    };
    const monitor = async (jobId) => {
      for (;;) {
        const job = await api(`/jobs/${jobId}`);
        progress.value = job;
        scrollDown();
        if (["已完成", "失败", "已取消"].includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 900));
      }
    };

    const load = async () => {
      const data = await call(() => api(`/projects/${id}/chat`));
      if (data) {
        messages.value = data.messages;
        suggestions.value = data.suggestions;
        scrollDown();
      }
    };
    watch(view, async () => {
      if (busy.value) return;
      const data = await call(() => api(`/projects/${id}/chat`));
      if (data) suggestions.value = data.suggestions;
    });
    onMounted(async () => {
      await load();
      samples.value = (await call(() => api("/samples"))) ?? [];
      if (view.value.job?.status === "处理中") {
        busy.value = true;
        try { await monitor(view.value.job.id); } finally { busy.value = false; progress.value = null; await reload(); await load(); }
      }
    });

    // Pending text shown immediately; the real message arrives with the job result.
    const send = async (body, label) => {
      if (busy.value) return;
      busy.value = true;
      stopping.value = false;
      messages.value.push({ id: `tmp${Date.now()}`, role: "user", content: label || body.text || (body.file ? `（上传了文件 ${body.file.name}）` : ""), payload: {} });
      progress.value = { steps: [{ name: "理解你的意思", state: "running" }] };
      scrollDown();
      try {
        const { jobId } = await api(`/projects/${id}/chat`, { method: "POST", body: { ...body, label } });
        const job = await monitor(jobId);
        if (job.status === "失败") {
            messages.value.push({ id: `err${Date.now()}`, role: "assistant", content: `这一步没成功：${job.error}`, payload: { error: true } });
        }
      } catch (error) {
        messages.value.push({ id: `err${Date.now()}`, role: "assistant", content: `出错了：${error.message}`, payload: { error: true } });
      }
      progress.value = null;
      busy.value = false;
      await reload();
      await load();
      const last = messages.value.at(-1);
      if (last?.payload?.open) props.open(last.payload.open.tab, last.payload.open.focus);
    };

    const submit = async () => {
      const body = {};
      if (file.value) body.file = { name: file.value.name, base64: await fileToBase64(file.value) };
      if (text.value.trim()) body.text = text.value.trim();
      if (!body.text && !body.file) return;
      text.value = "";
      file.value = null;
      send(body);
    };
    const onKey = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    };
    const onFile = (e) => {
      const f = e.target.files[0];
      if (f) file.value = f;
      e.target.value = "";
    };
    const onDrop = (e) => {
      const f = e.dataTransfer.files[0];
      if (f) file.value = f;
    };

    const quick = (s) => {
      if (s.actions) return send({ actions: s.actions }, s.label);
      if (s.ui === "samples") return;
      if (s.ui === "export") return props.open("finish");
      if (s.ui?.startsWith("open:")) return props.open(s.ui.slice(5));
    };

    const useSample = (s) => {
      text.value = s.text;
    };

    // ----- cards -----
    const card = (m, i) => m.payload.cards[i];
    const question = (c) => view.value.questions.find((q) => q.id === c.question_id);
    const acceptedIdx = ref({});
    const proposalAccepted = (m, i) => acceptedIdx.value[`${m.id}-${i}`] ?? (question(card(m, i))?.proposal?.changes ?? []).map((c, k) => !c.conflict && c.quoteVerified ? k : null).filter((k) => k !== null);
    const toggleChange = (m, i, k, on) => {
      const set = new Set(proposalAccepted(m, i));
      on ? set.add(k) : set.delete(k);
      acceptedIdx.value[`${m.id}-${i}`] = [...set].sort((a, b) => a - b);
    };
    const resolve = async (m, i, decision) => {
      await call(() => api(`/projects/${id}/chat/${m.id}/cards/${i}`, { method: "POST", body: { decision } }));
      await load();
      await reload();
    };
    const applyProposal = async (m, i) => {
      const c = card(m, i);
      if (question(c)?.proposal?.changes.some((change) => change.conflict)) return props.open("questions");
      const res = await call(() => api(`/projects/${id}/questions/${c.question_id}/apply`, { method: "POST", body: { accepted: proposalAccepted(m, i) } }));
      if (res) {
        await resolve(m, i, "accept");
        props.open("pbs");
      }
    };
    const applyRematch = async (m, i) => {
      const c = card(m, i);
      const res = await call(() => api(`/projects/${id}/pbs/${c.item_id}/accept`, { method: "POST", body: { suggestion: c.suggestion } }), "已按建议修改");
      if (res) {
        await resolve(m, i, "accept");
        props.open("pbs", c.item_id);
      }
    };

    const productName = (ref) => meta.products?.[ref] ?? view.value.items.find((x) => x.product_ref === ref)?.match?.product_name ?? ref;
    const describeChange = (a) => {
      if (a.type === "set_param") return `${meta.params?.find((p) => p.name === a.name)?.label ?? a.name} → ${a.value ?? "按材料取值"}`;
      const fields = [["对象", a.code ?? (a.id ? view.value.items.find((i) => i.id === a.id)?.name : null)], ["内容", a.text], ["名称", a.name], ["数量", a.qty], ["来源", a.source], ["优先级", a.priority], ["类别", a.category], ["原因", a.reason]];
      if (a.scope) fields.push(["范围", a.scope === "all" ? "全部" : "可批量确认的需求"]);
      if (a.codes?.length) fields.push(["需求/场景", a.codes.join("、")]);
      if (a.ids?.length) fields.push(["PBS项", a.ids.map((id) => view.value.items.find((i) => i.id === id)?.name ?? id).join("、")]);
      return fields.filter(([, v]) => v !== undefined && v !== null).map(([label, v]) => `${label}：${v}`).join("；") || "请核对后应用此项变更";
    };
    const cardDone = (c) => c.state !== "pending";

    const clear = async () => {
      await ElMessageBox.confirm("清空这个项目的对话记录？项目数据不受影响。", "清空对话", { type: "warning" });
      await call(() => api(`/projects/${id}/chat`, { method: "DELETE" }));
      load();
    };

    const empty = computed(() => !messages.value.length);

    // ----- model picker (global setting: every job uses the chosen model) -----
    const modelState = ref({ current: meta.model || "", groups: [], loading: false, saving: false, error: null });
    let confirmedModel = meta.model || "";
    let modelRevision = 0;
    watch(() => meta.model, (model) => {
      if (!modelState.value.current) modelState.value.current = confirmedModel = model;
    });
    const modelGroups = computed(() => {
      const { current, groups } = modelState.value;
      return current && !groups.some((g) => g.models.includes(current))
        ? [{ label: "当前模型", models: [current] }, ...groups] : groups;
    });
    const loadModels = async (refresh = false) => {
      if (modelState.value.loading) return;
      const revision = modelRevision;
      modelState.value.loading = true;
      try {
        const data = await api(`/models${refresh ? "?refresh=1" : ""}`, { signal: AbortSignal.timeout(10000) });
        modelState.value.groups = data.groups;
        modelState.value.error = data.error;
        if (revision === modelRevision) modelState.value.current = confirmedModel = data.current;
      } catch (error) {
        modelState.value.error = error.name === "TimeoutError" ? "获取模型列表超时，请重试" : error.message;
      } finally {
        modelState.value.loading = false;
      }
    };
    const refreshModels = (force = false) => loadModels(force);
    const changeModel = async (id) => {
      modelRevision += 1;
      modelState.value.saving = true;
      try {
        const r = await call(() => api("/models/current", { method: "PUT", body: { model: id }, signal: AbortSignal.timeout(10000) }), `已切换到 ${id}`);
        if (!r) modelState.value.current = confirmedModel;
        else {
          modelState.value.current = confirmedModel = meta.model = r.current;
          if (r.unverified) ElMessage.warning("已保存模型 ID；BAI 模型列表暂不可用，模型是否可调用尚未验证。");
        }
      } finally {
        modelState.value.saving = false;
      }
    };
    onMounted(() => loadModels());
    const hint = computed(() => {
      const s = view.value.steps;
      if (!s.materials.count) return "把客户的需求发给我就行：直接粘贴文字、会议纪要，或者拖入招标文件。";
      return "";
    });

    return { view, messages, suggestions, text, file, busy, progress, stopping, stop, scroller, samples, empty, hint, modelState, modelGroups, refreshModels, changeModel, send, submit, onKey, onFile, onDrop, quick, useSample, card, question, proposalAccepted, toggleChange, applyProposal, applyRematch, resolve, cardDone, productName, describeChange, clear, KIND_LABEL, CHANGE_LABEL, meta, jobState };
  },
  template: `
  <div class="chat" @dragover.prevent @drop.prevent="onDrop">
    <div class="chat-head">
      <b>和助手对话</b>
      <span style="flex:1"></span>
      <el-select v-model="modelState.current" size="small" filterable allow-create class="model-select"
        placeholder="选择或输入模型 ID" :disabled="busy || modelState.saving" @change="changeModel" @visible-change="(v) => v && refreshModels()" no-data-text="可输入 BAI 模型 ID">
        <el-option-group v-for="g in modelGroups" :key="g.label" :label="g.label">
          <el-option v-for="m in g.models" :key="m" :label="m" :value="m" />
        </el-option-group>
      </el-select>
      <el-button link size="small" :loading="modelState.loading" :disabled="modelState.saving" @click="refreshModels(true)">刷新模型</el-button>
      <el-button link size="small" @click="clear" v-if="messages.length">清空</el-button>
    </div>
    <div v-if="modelState.error" class="model-status" role="status" :title="modelState.error">BAI 模型列表暂不可用，可使用已有选项或输入模型 ID。</div>

    <div class="chat-body" ref="scroller">
      <div v-if="empty" class="chat-welcome">
        <div class="bot-avatar">PBS</div>
        <div class="bubble bot">
          你好，我是 PBS 拆解助手。<br />{{ hint || '继续说吧，比如“这个项目机场改成 12 个”“为什么要外采 GPU”“再加一条夜间飞行的要求”。' }}
          <div v-if="samples.length && !view.steps.materials.count" class="samples">
            <div class="muted" style="margin:8px 0 4px">想先看看效果？选一个示例填入输入框：</div>
            <el-button v-for="s in samples" :key="s.id" size="small" @click="useSample(s)">{{ s.label }}</el-button>
          </div>
        </div>
      </div>

      <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
        <div v-if="m.role === 'assistant'" class="bot-avatar">PBS</div>
        <div class="bubble" :class="[m.role === 'user' ? 'me' : 'bot', { error: m.payload.error }]">
          <div class="content">{{ m.content }}</div>
          <div v-if="m.payload.attachment" class="muted">📄 {{ m.payload.attachment.name }}</div>

          <div v-for="(r, k) in (m.payload.results || [])" :key="'r' + k" class="result" :class="{ bad: !r.ok }">{{ r.ok ? '✓' : '✗' }} {{ r.text }}</div>
          <el-button v-for="s in (m.payload.suggestions || []).filter((s) => s.actions?.some((a) => a.type === 'resume_agent'))" :key="s.label" size="small" :disabled="busy" @click="quick(s)">{{ s.label }}</el-button>

          <template v-for="(c, i) in (m.payload.cards || [])" :key="'c' + i">
            <div v-if="c.kind === 'agent_change'" class="mini-card">
              <div class="mc-title">{{ c.text }}</div>
              <div class="content">{{ describeChange(c.action) }}</div>
              <div class="mc-actions" v-if="!cardDone(c)">
                <el-button size="small" type="primary" @click="resolve(m, i, 'accept')">应用变更</el-button>
                <el-button size="small" @click="resolve(m, i, 'dismiss')">先不应用</el-button>
              </div>
              <div v-else class="muted">{{ c.note }}</div>
            </div>
            <!-- 客户答复 → 变更建议 -->
            <div v-else-if="c.kind === 'proposal' && question(c)" class="mini-card">
              <div class="mc-title">客户答复带来的变更 <span class="muted">Q{{ c.question_id }}</span></div>
              <div class="muted">{{ question(c).proposal?.summary }}</div>
              <div v-if="!(question(c).proposal?.changes || []).length" class="muted">只是确认现有内容，没有需要变更的地方。</div>
              <div v-for="(ch, k) in (question(c).proposal?.changes || [])" :key="k" class="change">
                <el-checkbox v-if="!cardDone(c)" :model-value="proposalAccepted(m, i).includes(k)" @change="(v) => toggleChange(m, i, k, v)" />
                <div style="flex:1">
                  <el-tag size="small">{{ CHANGE_LABEL[ch.type] }}</el-tag>
                  <template v-if="ch.type === 'set_param'"> {{ ch.label }}：{{ ch.before ?? '未知' }} → <b>{{ ch.value }}{{ ch.unit }}</b></template>
                  <template v-else-if="ch.type === 'update_requirement'"> {{ ch.code }}<div class="diff"><s>{{ ch.before }}</s><br />{{ ch.text }}</div></template>
                  <template v-else-if="ch.type === 'add_requirement'"> <div class="diff">{{ ch.text }}</div></template>
                  <template v-else> {{ ch.code }}<div class="diff"><s>{{ ch.before }}</s></div></template>
                </div>
              </div>
              <div class="mc-actions" v-if="!cardDone(c)">
                <el-button size="small" type="primary" @click="applyProposal(m, i)">应用所选（{{ proposalAccepted(m, i).length }}）</el-button>
                <el-button size="small" @click="resolve(m, i, 'dismiss')">先不应用</el-button>
              </div>
              <div v-else class="muted">{{ c.note }}</div>
            </div>

            <!-- 重新匹配建议 -->
            <div v-else-if="c.kind === 'rematch'" class="mini-card">
              <div class="mc-title">重新匹配建议</div>
              <div class="compare">
                <div><div class="muted">原来</div>{{ c.before.name }}<br /><span class="muted">{{ c.before.source }} {{ c.before.product_ref ? productName(c.before.product_ref) : '' }}</span></div>
                <div class="arrow">→</div>
                <div><div class="muted">建议</div><b>{{ c.suggestion.name }}</b><br /><span class="muted">{{ c.suggestion.source }} {{ c.suggestion.product_ref ? productName(c.suggestion.product_ref) : '' }}</span></div>
              </div>
              <div v-if="c.suggestion.matched_capabilities?.length" class="caps"><el-tag v-for="x in c.suggestion.matched_capabilities" :key="x" size="small" type="success">✓ {{ x }}</el-tag></div>
              <div v-if="c.suggestion.blocked_by" class="caps"><el-tag size="small" type="warning">✕ {{ c.suggestion.blocked_by.product_name }}：{{ c.suggestion.blocked_by.limit }}</el-tag></div>
              <div class="muted">{{ c.suggestion.basis }}</div>
              <div v-for="n in c.notes" :key="n" class="muted">· {{ n }}</div>
              <div class="mc-actions" v-if="!cardDone(c)">
                <el-button size="small" type="primary" @click="applyRematch(m, i)">采纳</el-button>
                <el-button size="small" @click="resolve(m, i, 'dismiss')">保持原样</el-button>
              </div>
              <div v-else class="muted">{{ c.note }}</div>
            </div>

            <!-- 需要确认的危险操作 -->
            <div v-else-if="c.kind === 'delete_item'" class="mini-card">
              <div>{{ c.text }}</div>
              <div class="mc-actions" v-if="!cardDone(c)">
                <el-button size="small" type="danger" @click="resolve(m, i, 'accept')">删除</el-button>
                <el-button size="small" @click="resolve(m, i, 'dismiss')">取消</el-button>
              </div>
              <div v-else class="muted">{{ c.note }}</div>
            </div>
          </template>

          <div v-if="m.payload.open" class="open-link"><el-button link type="primary" size="small" @click="$props.open(m.payload.open.tab, m.payload.open.focus)">在右侧查看 →</el-button></div>
        </div>
      </div>

      <div v-if="progress" class="msg assistant">
        <div class="bot-avatar">PBS</div>
        <div class="bubble bot working">
          <div v-for="s in progress.steps" :key="s.name" class="job-step" :class="s.state">
            <span class="ic"><template v-if="s.state === 'done'">✓</template><template v-else-if="s.state === 'running'"><i class="spin"></i></template></span>
            <span>{{ s.name }}</span><span class="muted" v-if="s.detail">{{ s.detail }}</span>
          </div>
          <el-button size="small" :disabled="!progress.id || stopping" @click="stop">{{ stopping ? '正在停止…' : '停止处理' }}</el-button>
        </div>
      </div>
    </div>

    <div class="chat-foot">
      <div class="quick" v-if="suggestions.length && !busy">
        <button v-for="s in suggestions.filter((x) => x.ui !== 'samples')" :key="s.label" @click="quick(s)">{{ s.label }}</button>
      </div>
      <div v-if="file" class="file-chip">📄 {{ file.name }} <el-button link type="danger" size="small" @click="file = null">移除</el-button></div>
      <div class="input">
        <el-input v-model="text" type="textarea" :autosize="{ minRows: 1, maxRows: 8 }" resize="none" :disabled="busy"
          placeholder="说需求、粘贴材料、改数量、问依据……（Enter 发送，Shift+Enter 换行）" @keydown="onKey" />
        <label class="attach" title="上传文件"><input type="file" hidden :accept="meta.fileTypes.join(',')" @change="onFile" />📎</label>
        <el-button type="primary" :disabled="busy || (!text.trim() && !file)" @click="submit">发送</el-button>
      </div>
    </div>
  </div>`,
});
