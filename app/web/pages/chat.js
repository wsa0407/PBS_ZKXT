import { computed, defineComponent, inject, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, call, fileToBase64, jobState, meta } from "../api.js";
import { scenarioFieldLabel, scenarioValue } from "../ui.js";

import { ApprovalDialog, ExpertDetails, expertLabels } from "../collaboration-ui.js";

const KIND_LABEL = { tender: "招标文件", minutes: "会议纪要", oral: "用户描述", other: "其他材料" };
const CHANGE_LABEL = { set_param: "设定参数", update_requirement: "修改需求", add_requirement: "新增需求", remove_requirement: "删除需求", update_scenario: "修改场景" };

export default defineComponent({
  components: { ApprovalDialog, ExpertDetails },
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

    const collaboration = ref({ task: null, interventions: [] });
    const target = ref("");
    const replying = ref(null);
    const sending = ref(false);
    const approvalVisible = ref(false);
    const expanded = ref({});
    const unread = ref(0);
    let atBottom = true, stream, disposed = false, loading = false, loadAgain = false, polling, requestDraft;
    const scrollDown = () => nextTick(() => { if (atBottom && scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight; });
    const onScroll = () => { const el = scroller.value; atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (atBottom) unread.value = 0; };
    const showLatest = () => { atBottom = true; unread.value = 0; scrollDown(); };
    const load = async () => {
      if (loading) { loadAgain = true; return; }
      loading = true;
      try {
        const data = await api(`/projects/${id}/chat`);
        if (disposed) return;
        const existing = new Set(messages.value.map(m => m.id));
        if (!atBottom) unread.value += data.messages.filter(m => !existing.has(m.id)).length;
        messages.value = data.messages;
        suggestions.value = data.suggestions;
        collaboration.value = data.collaboration;
        progress.value = data.job;
        busy.value = Boolean(data.job);
        if (!busy.value) stopping.value = false;
        scrollDown();
      } finally { loading = false; if (loadAgain && !disposed) { loadAgain = false; load().catch(() => {}); } }
    };
    const refresh = async () => { await load(); await reload(); };
    const stop = async () => {
      if (stopping.value) return;
      const endpoint = collaboration.value.task && progress.value?.kind === "collaboration" ? `/projects/${id}/collaboration/pause` : `/jobs/${progress.value.id}/cancel`;
      if (await call(() => api(endpoint, { method: "POST" }))) { stopping.value = true; await load(); }
    };
    const resume = async () => { if (await call(() => api(`/projects/${id}/collaboration/resume`, { method: "POST" }))) await load(); };
    const replyTo = (m) => { replying.value = m; target.value = m.payload.sender; };
    const approve = () => { if (busy.value) return ElMessage.info("请先暂停当前任务，再审阅并确认范围。"); approvalVisible.value = true; };
    const started = async () => { await refresh(); props.open("pbs"); };
    watch(view, () => { load().catch(() => {}); });
    onMounted(async () => {
      await call(load);
      samples.value = (await call(() => api("/samples"))) ?? [];
      stream = new EventSource(`/api/projects/${id}/collaboration/stream?after=${collaboration.value.seq || 0}`);
      stream.onmessage = () => { load().catch(() => {}); };
      // Status changes and old non-agent jobs also refresh; events are always durable.
      polling = setInterval(() => { load().catch(() => {}); if (busy.value) reload().catch(() => {}); }, 2500);
    });
    onUnmounted(() => { disposed = true; stream?.close(); clearInterval(polling); });

    const send = async (body, label) => {
      const result = await call(() => api(`/projects/${id}/chat`, { method: "POST", body: { ...body, label } }));
      if (result) { atBottom = true; await load(); }
      return result;
    };
    const submit = async () => {
      if (sending.value || (!text.value.trim() && !file.value)) return;
      sending.value = true;
      try {
        const body = { text: text.value.trim(), target: target.value || undefined,
          consultationId: replying.value?.payload.taskId === collaboration.value.task?.id ? replying.value?.payload.consultationId : undefined };
        if (file.value) body.file = { name: file.value.name, base64: await fileToBase64(file.value) };
        const fingerprint = JSON.stringify(body);
        if (requestDraft?.fingerprint !== fingerprint) requestDraft = { fingerprint, id: crypto.randomUUID() };
        body.requestId = requestDraft.id;
        if (await send(body)) { text.value = ""; file.value = null; replying.value = null; requestDraft = null; }
      } finally { sending.value = false; }
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
      if (!proposalAccepted(m, i).length) await ElMessageBox.confirm("本次不更新需求、场景或参数，并将该澄清记为已处理。", "记录不变更", { confirmButtonText: "记录并结束处理", cancelButtonText: "返回审阅" });
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
      if (a.type === "set_param") return `${meta.params?.find((p) => p.name === a.name)?.label ?? a.name} → ${a.value ?? "取消指定，按来源重新取值"}`;
      const fields = [["对象", a.code ?? (a.id ? view.value.items.find((i) => i.id === a.id)?.name : null)], ["内容", a.text], ["名称", a.name], ["数量", a.qty], ["来源", a.source], ["优先级", a.priority], ["类别", a.category], ["原因", a.reason]];
      if (a.scope) fields.push(["范围", a.scope === "all" ? "全部" : "当前规则列为常规核对的待审需求"]);
      if (a.codes?.length) fields.push(["需求/场景", a.codes.join("、")]);
      if (a.ids?.length) fields.push(["PBS项", a.ids.map((id) => view.value.items.find((i) => i.id === id)?.name ?? id).join("、")]);
      return fields.filter(([, v]) => v !== undefined && v !== null).map(([label, v]) => `${label}：${v}`).join("；") || "请核对后应用此项变更";
    };
    const cardDone = (c) => c.state !== "pending";

    const clear = async () => {
      await ElMessageBox.confirm("隐藏此前对话？专家交流、人工确认与证据记录仍保留，便于追溯和继续任务。", "隐藏此前对话", { type: "warning" });
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

    return { id, collaboration, target, replying, sending, approvalVisible, expanded, unread, onScroll, showLatest, resume, replyTo, approve, started, expertLabels, view, messages, suggestions, text, file, busy, progress, stopping, stop, scroller, samples, empty, hint, modelState, modelGroups, refreshModels, changeModel, send, submit, onKey, onFile, onDrop, quick, useSample, card, question, proposalAccepted, toggleChange, applyProposal, applyRematch, resolve, cardDone, productName, describeChange, clear, KIND_LABEL, CHANGE_LABEL, meta, jobState, scenarioFieldLabel, scenarioValue };
  },
  template: `
  <div class="chat" @dragover.prevent @drop.prevent="onDrop">
    <div class="chat-head">
      <b>专家协作</b>
      <span style="flex:1"></span>
      <el-select v-model="modelState.current" size="small" filterable allow-create class="model-select"
        title="全局默认模型，后续处理任务将使用此模型" placeholder="选择或输入模型 ID" :disabled="busy || modelState.saving" @change="changeModel" @visible-change="(v) => v && refreshModels()" no-data-text="可输入 BAI 模型 ID">
        <el-option-group v-for="g in modelGroups" :key="g.label" :label="g.label">
          <el-option v-for="m in g.models" :key="m" :label="m" :value="m" />
        </el-option-group>
      </el-select>
      <el-button link size="small" :loading="modelState.loading" :disabled="modelState.saving" @click="refreshModels(true)">刷新模型列表</el-button>
      <el-button link size="small" @click="clear" v-if="messages.length">隐藏此前对话</el-button>
    </div>
    <div v-if="modelState.error" class="model-status" role="status" :title="modelState.error">BAI 模型列表暂不可用，可使用已有选项或输入模型 ID。</div>

    <div class="expert-roster"><span class="materials">材料拆解</span><span class="understanding">需求理解</span><span class="pbs">PBS编制</span></div>
    <div class="chat-body" ref="scroller" @scroll="onScroll">
      <div v-if="empty" class="chat-welcome">
        <div class="bot-avatar">PBS</div>
        <div class="bubble bot">
          三位专家在这里协作，你可以随时补充信息、纠正方向。<br />{{ hint || '继续说吧，比如“这个项目机场改成 12 个”“为什么要外采 GPU”“再加一条夜间飞行的要求”。' }}
          <div v-if="samples.length && !view.steps.materials.count" class="samples">
            <div class="muted" style="margin:8px 0 4px">想先看看效果？选一个示例填入输入框：</div>
            <el-button v-for="s in samples" :key="s.id" size="small" @click="useSample(s)">{{ s.label }}</el-button>
          </div>
        </div>
      </div>

      <div v-for="m in messages" :key="m.id" class="msg" :class="[m.role, m.payload.sender, { 'system-message': m.payload.sender === 'system' }]">
        <div v-if="m.role === 'assistant' && m.payload.sender !== 'system'" class="bot-avatar" :class="m.payload.sender">{{ ({materials: '材', understanding: '需', pbs: 'P'})[m.payload.sender] || 'P' }}</div>
        <div class="bubble" :class="[m.role === 'user' ? 'me' : 'bot', { error: m.payload.error }]">
          <div v-if="m.role === 'assistant'" class="expert-name" :class="m.payload.sender">{{ expertLabels[m.payload.sender] || 'PBS助手' }}<span v-if="m.payload.recipient && m.payload.recipient !== 'human'" class="recipient"> → @{{ expertLabels[m.payload.recipient] }}</span></div>
          <div v-if="m.role === 'user' && m.payload.recipient" class="human-recipient">给 {{ expertLabels[m.payload.recipient] }}</div>
          <div class="content">{{ m.payload.collaboration && m.content.length > 220 && !expanded[m.id] ? m.content.slice(0, 220) + '…' : m.content }}</div>
          <button v-if="m.payload.collaboration && m.content.length > 220" class="text-action" @click="expanded[m.id] = !expanded[m.id]">{{ expanded[m.id] ? '收起' : '展开完整内容' }}</button>
          <div v-if="m.payload.attachment" class="muted">📄 {{ m.payload.attachment.name }}</div>

          <div v-for="(r, k) in (m.payload.results || [])" :key="'r' + k" class="result" :class="{ bad: !r.ok }">{{ r.ok ? '✓' : '✗' }} {{ r.text }}</div>
          <el-button v-for="s in (m.payload.suggestions || []).filter((s) => s.actions?.some((a) => a.type === 'resume_agent'))" :key="s.label" size="small" :disabled="busy" @click="quick(s)">{{ s.label }}</el-button>

          <template v-for="(c, i) in (m.payload.cards || [])" :key="'c' + i">
            <div v-if="c.kind === 'agent_change'" class="mini-card">
              <div class="mc-title">{{ c.text }}</div>
              <div class="content">{{ describeChange(c.action) }}</div>
              <div class="mc-actions" v-if="!cardDone(c)">
                <el-button size="small" type="primary" @click="resolve(m, i, 'accept')">采纳并更新</el-button>
                <el-button size="small" @click="resolve(m, i, 'dismiss')">不采纳此建议</el-button>
              </div>
              <div v-else class="muted">{{ c.note }}</div>
            </div>
            <!-- 客户答复 → 变更建议 -->
            <div v-else-if="c.kind === 'proposal' && question(c)" class="mini-card">
              <div class="mc-title">客户答复带来的变更 <span class="muted">Q{{ c.question_id }}</span></div>
              <div class="muted">{{ question(c).proposal?.summary }}</div>
              <div v-if="!(question(c).proposal?.changes || []).length" class="muted">未形成可直接采纳的变更建议，请核对答复内容。</div>
              <div v-for="(ch, k) in (question(c).proposal?.changes || [])" :key="k" class="change">
                <el-checkbox v-if="!cardDone(c)" :disabled="!ch.quoteVerified" :model-value="proposalAccepted(m, i).includes(k)" @change="(v) => toggleChange(m, i, k, v)" />
                <div style="flex:1">
                  <el-tag size="small">{{ CHANGE_LABEL[ch.type] }}</el-tag>
                  <template v-if="ch.type === 'set_param'"> {{ ch.label }}：{{ ch.before ?? '未知' }} → <b>{{ ch.value }}{{ ch.unit }}</b></template>
                  <template v-else-if="ch.type === 'update_requirement'"> {{ ch.code }}<div class="diff"><s>{{ ch.before }}</s><br />{{ ch.text }}</div></template>
                  <template v-else-if="ch.type === 'update_scenario'"> {{ ch.code }} · {{ scenarioFieldLabel(ch.field_path) }}<div class="diff"><s>{{ scenarioValue(ch.before) }}</s><br />{{ scenarioValue(ch.value) }}</div></template>
                  <template v-else-if="ch.type === 'add_requirement'"> <div class="diff">{{ ch.text }}</div></template>
                  <template v-else> {{ ch.code }}<div class="diff"><s>{{ ch.before }}</s></div></template>
                </div>
              </div>
              <div class="mc-actions" v-if="!cardDone(c)">
                <el-button size="small" type="primary" @click="applyProposal(m, i)">{{ proposalAccepted(m, i).length ? '采纳所选并更新（' + proposalAccepted(m, i).length + '）' : '记录不变更并结束处理' }}</el-button>
                <el-button size="small" @click="resolve(m, i, 'dismiss')">不采纳此建议</el-button>
              </div>
              <div v-else class="muted">{{ c.note }}</div>
            </div>

            <!-- 重新匹配建议 -->
            <div v-else-if="c.kind === 'rematch'" class="mini-card">
              <div class="mc-title">产品重新匹配建议</div><div class="muted">可能更新名称、规格、分类、产品与数量规则；人工数量保留，自动数量重新计算。</div>
              <div class="compare">
                <div><div class="muted">原来</div>{{ c.before.name }}<br /><span class="muted">{{ c.before.source }} {{ c.before.product_ref ? productName(c.before.product_ref) : '' }}</span></div>
                <div class="arrow">→</div>
                <div><div class="muted">建议</div><b>{{ c.suggestion.name }}</b><br /><span class="muted">{{ c.suggestion.source }} {{ c.suggestion.product_ref ? productName(c.suggestion.product_ref) : '' }}</span></div>
              </div>
              <div v-if="c.suggestion.matched_capabilities?.length" class="caps"><el-tag v-for="x in c.suggestion.matched_capabilities" :key="x" size="small" type="success">✓ {{ x }}</el-tag></div>
              <div v-if="c.suggestion.blocked_by" class="caps"><el-tag size="small" type="warning">✕ {{ c.suggestion.blocked_by.product_name }}：{{ c.suggestion.blocked_by.limit }}</el-tag></div>
              <div class="muted">{{ c.suggestion.basis }}</div>
              <div v-for="n in c.notes" :key="n" class="muted">· {{ n }}</div>
              <el-collapse><el-collapse-item title="展开查看完整选型建议"><div>名称：{{ c.suggestion.name }}</div><div>规格：{{ c.suggestion.spec }}</div><div>交付方式：{{ c.suggestion.source }}</div><div>产品：{{ productName(c.suggestion.product_ref) || '未关联' }}</div><div>分类：{{ view.groups.find((g) => g.code === String(c.suggestion.parent))?.name || c.suggestion.parent }}</div><div>数量规则：{{ meta.rules.find((r) => r.id === c.suggestion.sizing_rule)?.name || '未指定' }} · 单位：{{ c.suggestion.unit }}</div></el-collapse-item></el-collapse>
              <div class="mc-actions" v-if="!cardDone(c)">
                <el-button size="small" type="primary" @click="applyRematch(m, i)">采纳并更新本项</el-button>
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

          <ExpertDetails v-if="m.payload.collaboration" :message="m" :open="$props.open" @reply="replyTo" @approve="approve" @resume="resume" />
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
          <el-button size="small" :disabled="!progress.id || stopping" @click="stop">{{ stopping ? '正在暂停…' : '暂停任务' }}</el-button>
        </div>
      </div>
    </div>

    <button v-if="unread" class="new-messages" @click="showLatest">{{ unread }} 条新消息 ↓</button>
    <div class="chat-foot">
      <div v-if="['paused','failed'].includes(collaboration.task?.status)" class="task-resume"><span>{{ collaboration.task.status === 'paused' ? '任务已暂停，补充会先保存' : '协作尚未完成，已有成果保留' }}</span><el-button size="small" @click="resume">继续处理</el-button></div>
      <div v-if="collaboration.task?.status === 'awaiting_confirmation' && !busy" class="task-resume"><span>本轮理解待你审阅</span><el-button size="small" @click="approve">确认范围并交给 PBS</el-button></div>
      <div v-if="replying" class="reply-context"><span>补充 {{ expertLabels[replying.payload.sender] }} 的讨论：{{ replying.content.slice(0, 44) }}…</span><button @click="replying = null; target = ''">取消</button></div>
      <div class="recipient-picker"><span>发送给</span><select v-model="target" aria-label="发送给哪位专家"><option value="">当前任务</option><option value="materials">材料拆解专家</option><option value="understanding">需求理解专家</option><option value="pbs">PBS专家</option></select><small v-if="busy">处理中也可补充</small></div>
      <div class="quick" v-if="suggestions.length && !busy">
        <button v-for="s in suggestions.filter((x) => x.ui !== 'samples')" :key="s.label" @click="quick(s)">{{ s.label }}</button>
      </div>
      <div v-if="file" class="file-chip">📄 {{ file.name }} <el-button link type="danger" size="small" @click="file = null">移除</el-button></div>
      <div class="input">
        <el-input v-model="text" type="textarea" :autosize="{ minRows: 1, maxRows: 8 }" resize="none" :disabled="sending"
          placeholder="补充信息、纠正思路，或询问依据……" @keydown="onKey" />
        <label class="attach" title="上传文件"><input type="file" hidden :accept="meta.fileTypes.join(',')" @change="onFile" />📎</label>
        <el-button type="primary" :loading="sending" :disabled="sending || (!text.trim() && !file)" @click="submit">发送</el-button>
      </div>
    </div>
    <ApprovalDialog v-model="approvalVisible" :project-id="id" :open="$props.open" @started="started" />
  </div>`,
});
