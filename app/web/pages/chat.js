import { computed, defineComponent, inject, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, call, fileToBase64, jobState, meta } from "../api.js";
import { scenarioFieldLabel, scenarioValue } from "../ui.js";

import { ExpertDetails, expertLabels } from "../collaboration-ui.js";

import { mentionQuery, parseMentions } from "../mentions.mjs";
import { isConversationMessage } from "../chat-events.mjs";

const KIND_LABEL = { tender: "招标文件", minutes: "会议纪要", oral: "用户描述", other: "其他材料" };
const CHANGE_LABEL = { set_param: "设定参数", update_requirement: "修改需求", add_requirement: "新增需求", remove_requirement: "删除需求", update_scenario: "修改场景" };

export default defineComponent({
  components: { ExpertDetails },
  props: { open: Function },
  setup(props) {
    const { id, view, reload } = inject("project");
    const messages = ref([]);
    const text = ref("");
    const file = ref(null);
    const busy = ref(false);
    const progress = ref(null);
    const currentStep = computed(() => progress.value?.steps?.find(s => s.state === "running"));
    const scroller = ref(null);
    const samples = ref([]);

    const collaboration = ref({ task: null, interventions: [] });
    const composer = ref(null), mention = ref(null), mentionIndex = ref(0);
    const recipients = computed(() => parseMentions(text.value).targets);
    const sending = ref(false);
    const resuming = ref(false);
    const expanded = ref({});
    const unread = ref(0);
    let draftReviewId, drafting = false;
    watch(text, value => {
      if (!value.trim()) { drafting = false; draftReviewId = undefined; return; }
      if (drafting) return;
      drafting = true;
      const request = collaboration.value.review;
      if (request && messages.value.some(m => m.payload.reviewId === request.id || m.id === request.data?.messageId)) draftReviewId = request.id;
    }, { flush: "sync" });
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
        const conversationMessages = data.messages.filter(isConversationMessage);
        if (!atBottom) unread.value += conversationMessages.filter(m => !existing.has(m.id)).length;
        messages.value = conversationMessages;
        collaboration.value = data.collaboration;
        progress.value = data.job;
        busy.value = Boolean(data.job);
        scrollDown();
      } finally { loading = false; if (loadAgain && !disposed) { loadAgain = false; load().catch(() => {}); } }
    };
    const resume = async () => {
      if (resuming.value || busy.value || !["paused", "failed"].includes(collaboration.value.task?.status)) return;
      resuming.value = true;
      try { if (await call(() => api(`/projects/${id}/collaboration/resume`, { method: "POST" }))) await load(); }
      finally { resuming.value = false; }
    };
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
        const body = { text: text.value.trim(), reviewId: draftReviewId };
        if (file.value) body.file = { name: file.value.name, base64: await fileToBase64(file.value) };
        const fingerprint = JSON.stringify(body);
        if (requestDraft?.fingerprint !== fingerprint) requestDraft = { fingerprint, id: crypto.randomUUID() };
        body.requestId = requestDraft.id;
        if (await send(body)) { text.value = ""; file.value = null; mention.value = null; requestDraft = null; updateMention(); }
      } finally { sending.value = false; }
    };
    const updateMention = () => {
      const el = composer.value;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
      mention.value = mentionQuery(text.value, el.selectionStart);
      mentionIndex.value = 0;
    };
    watch(text, () => nextTick(updateMention));
    const chooseMention = (expert) => {
      const query = mention.value;
      if (!query) return;
      const name = `@${expert.label} `;
      text.value = text.value.slice(0, query.start) + name + text.value.slice(query.end);
      mention.value = null;
      nextTick(() => { composer.value.focus(); composer.value.setSelectionRange(query.start + name.length, query.start + name.length); updateMention(); });
    };
    const onKey = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (mention.value?.options.length) {
        if (["ArrowDown", "ArrowUp"].includes(e.key)) {
          e.preventDefault();
          mentionIndex.value = (mentionIndex.value + (e.key === "ArrowDown" ? 1 : -1) + mention.value.options.length) % mention.value.options.length;
          return;
        }
        if (["Enter", "Tab"].includes(e.key) && !e.shiftKey) { e.preventDefault(); chooseMention(mention.value.options[mentionIndex.value]); return; }
        if (e.key === "Escape") { e.preventDefault(); mention.value = null; return; }
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
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

    const useSample = (s) => {
      text.value = s.text;
    };

    // ----- cards -----
    const question = (c) => view.value.questions.find((q) => q.id === c.question_id);

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

    return { id, collaboration, composer, mention, mentionIndex, recipients, updateMention, chooseMention, sending, resuming, expanded, unread, onScroll, showLatest, resume, expertLabels, view, messages, text, file, busy, progress, currentStep, scroller, samples, empty, hint, modelState, modelGroups, refreshModels, changeModel, send, submit, onKey, onFile, onDrop, useSample, question, cardDone, productName, describeChange, clear, KIND_LABEL, CHANGE_LABEL, meta, jobState, scenarioFieldLabel, scenarioValue };
  },
  template: `
  <div class="chat" @dragover.prevent @drop.prevent="onDrop">
    <div class="chat-head">
      <div class="chat-heading"><span class="chat-mark"><UiIcon name="spark" /></span><b>专家协作</b></div>
      <el-button class="clear-conversation" link size="small" @click="clear" v-if="messages.length">隐藏历史</el-button>
      <div class="model-control">
      <el-select v-model="modelState.current" size="small" filterable allow-create class="model-select"
        aria-label="专家使用的模型" title="全局默认模型，后续处理任务将使用此模型" placeholder="选择或输入模型 ID" :disabled="busy || modelState.saving" @change="changeModel" @visible-change="(v) => v && refreshModels()" no-data-text="可输入 BAI 模型 ID">
        <el-option-group v-for="g in modelGroups" :key="g.label" :label="g.label">
          <el-option v-for="m in g.models" :key="m" :label="m" :value="m" />
        </el-option-group>
      </el-select>
      <el-button class="icon-button" link size="small" aria-label="刷新模型列表" title="刷新模型列表" :loading="modelState.loading" :disabled="modelState.saving" @click="refreshModels(true)"><UiIcon v-if="!modelState.loading" name="refresh" /></el-button>
      </div>
    </div>
    <div v-if="modelState.error" class="model-status" role="status" :title="modelState.error">BAI 模型列表暂不可用，可使用已有选项或输入模型 ID。</div>

    <div class="expert-roster" aria-label="项目专家"><span class="materials"><i>材</i>材料拆解</span><span class="understanding"><i>需</i>需求理解</span><span class="pbs"><i>P</i>PBS 编制</span></div>
    <div class="chat-body" ref="scroller" @scroll="onScroll">
      <div v-if="empty" class="chat-welcome">
        <h2>{{ view.steps.materials.count ? '继续讨论项目' : '添加客户材料' }}</h2>
        <p>{{ hint || '输入问题或补充要求；使用 @ 指定专家。' }}</p>
          <div v-if="samples.length && !view.steps.materials.count" class="samples">
            <div class="muted" style="margin:8px 0 4px">填入示例材料：</div>
            <el-button v-for="s in samples" :key="s.id" size="small" @click="useSample(s)">{{ s.label }}</el-button>
          </div>
      </div>

      <div v-for="m in messages" :key="m.id" class="msg" :class="[m.role, m.payload.sender, { 'system-message': m.payload.sender === 'system' }]">
        <div v-if="m.role === 'assistant' && m.payload.sender !== 'system'" class="bot-avatar" :class="m.payload.sender">{{ ({materials: '材', understanding: '需', pbs: 'P'})[m.payload.sender] || 'P' }}</div>
        <div class="bubble" :class="[m.role === 'user' ? 'me' : 'bot', { error: m.payload.error }]">
          <div v-if="m.role === 'assistant'" class="expert-name" :class="m.payload.sender">{{ expertLabels[m.payload.sender] || 'PBS助手' }}<span v-if="m.payload.recipient && m.payload.recipient !== 'human'" class="recipient"> → @{{ expertLabels[m.payload.recipient] }}</span></div>
          <div v-if="m.role === 'user' && m.payload.recipient" class="human-recipient">{{ m.payload.recipients?.length ? m.payload.recipients.map(r => expertLabels[r]).join('、') : expertLabels[m.payload.recipient] || '专家群' }}</div>
          <div class="content">{{ m.payload.collaboration && m.content.length > 220 && !expanded[m.id] ? m.content.slice(0, 220) + '…' : m.content }}</div>
          <button v-if="m.payload.collaboration && m.content.length > 220" class="text-action" @click="expanded[m.id] = !expanded[m.id]">{{ expanded[m.id] ? '收起' : '展开完整内容' }}</button>
          <div v-if="m.payload.attachment" class="message-attachment"><UiIcon name="file" />{{ m.payload.attachment.name }}</div>

          <div v-for="(r, k) in (m.payload.results || [])" :key="'r' + k" class="result" :class="{ bad: !r.ok }">{{ r.ok ? '✓' : '✗' }} {{ r.text }}</div>

          <template v-for="(c, i) in (m.payload.cards || [])" :key="'c' + i">
            <div v-if="c.kind === 'agent_change'" class="mini-card">
              <div class="mc-title">{{ c.text }}</div>
              <div class="content">{{ describeChange(c.action) }}</div>
              <div v-if="!cardDone(c)" class="muted">请直接回复是否采纳这项建议，或说明修改意见。</div>
              <div v-else class="muted">{{ c.note }}</div>
            </div>
            <!-- 客户答复 → 变更建议 -->
            <div v-else-if="c.kind === 'proposal' && question(c)" class="mini-card">
              <div class="mc-title">客户答复带来的变更 <span class="muted">Q{{ c.question_id }}</span></div>
              <div class="muted">{{ question(c).proposal?.summary }}</div>
              <div v-if="!(question(c).proposal?.changes || []).length" class="muted">未形成可直接采纳的变更建议，请核对答复内容。</div>
              <div v-for="(ch, k) in (question(c).proposal?.changes || [])" :key="k" class="change">
                <div style="flex:1">
                  <el-tag size="small">{{ CHANGE_LABEL[ch.type] }}</el-tag>
                  <template v-if="ch.type === 'set_param'"> {{ ch.label }}：{{ ch.before ?? '未知' }} → <b>{{ ch.value }}{{ ch.unit }}</b></template>
                  <template v-else-if="ch.type === 'update_requirement'"> {{ ch.code }}<div class="diff"><s>{{ ch.before }}</s><br />{{ ch.text }}</div></template>
                  <template v-else-if="ch.type === 'update_scenario'"> {{ ch.code }} · {{ scenarioFieldLabel(ch.field_path) }}<div class="diff"><s>{{ scenarioValue(ch.before) }}</s><br />{{ scenarioValue(ch.value) }}</div></template>
                  <template v-else-if="ch.type === 'add_requirement'"> <div class="diff">{{ ch.text }}</div></template>
                  <template v-else> {{ ch.code }}<div class="diff"><s>{{ ch.before }}</s></div></template>
                </div>
              </div>
              <div v-if="!cardDone(c)" class="muted">历史澄清建议，请在右侧需求理解中审阅。<el-button link @click="$props.open('questions', c.question_id)">查看详情 →</el-button></div>
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
              <div v-if="!cardDone(c)" class="muted">历史选型建议，请在右侧 PBS 中审阅。<el-button link @click="$props.open('pbs', c.item_id)">查看详情 →</el-button></div>
              <div v-else class="muted">{{ c.note }}</div>
            </div>

            <!-- 需要确认的危险操作 -->
            <div v-else-if="c.kind === 'delete_item'" class="mini-card">
              <div>{{ c.text }}</div>
              <div v-if="!cardDone(c)" class="muted">请直接说明是否仍需要删除这项，专家会核对当前成果。</div>
              <div v-else class="muted">{{ c.note }}</div>
            </div>
          </template>

          <ExpertDetails v-if="m.payload.collaboration" :message="m" :open="$props.open" />
          <div v-if="m.payload.open" class="open-link"><el-button link type="primary" size="small" @click="$props.open(m.payload.open.tab, m.payload.open.focus)">在右侧查看 →</el-button></div>
        </div>
      </div>

    </div>

    <button v-if="unread" class="new-messages" @click="showLatest">{{ unread }} 条新消息 ↓</button>
    <div class="chat-foot">
      <div v-if="progress" class="chat-activity" role="status" aria-live="polite"><i class="spin"></i><span>{{ currentStep?.name || '正在处理' }}<template v-if="currentStep?.detail"> · {{ currentStep.detail }}</template>…</span></div>
      <div v-if="!busy && ['paused','failed'].includes(collaboration.task?.status)" class="task-resume"><span>{{ collaboration.task.status === 'paused' ? '任务已暂停，补充会先保存' : '协作尚未完成，已有成果保留' }}</span><el-button size="small" :loading="resuming" @click="resume">继续处理</el-button></div>
      <div class="input">
        <div v-if="file" class="file-chip"><UiIcon name="file" /><span>{{ file.name }}</span><el-button link type="danger" size="small" @click="file = null">移除</el-button></div>
        <div class="composer-field">
          <div v-if="mention?.options.length" id="expert-mentions" class="mention-menu" role="listbox" aria-label="选择专家">
            <button v-for="(expert, index) in mention.options" :id="'mention-' + index" :key="expert.id" type="button" role="option" :aria-selected="index === mentionIndex" :class="{ selected: index === mentionIndex }" @mousedown.prevent @click="chooseMention(expert)">@{{ expert.label }}</button>
          </div>
          <textarea ref="composer" v-model="text" class="chat-composer" rows="2" :disabled="sending" aria-label="给专家发送消息" aria-autocomplete="list" :aria-controls="mention?.options.length ? 'expert-mentions' : undefined" :aria-activedescendant="mention?.options.length ? 'mention-' + mentionIndex : undefined"
            placeholder="直接说你的想法，或 @ 专家……" @input="updateMention" @click="updateMention" @keyup.left="updateMention" @keyup.right="updateMention" @keydown="onKey" @blur="mention = null" />
        </div>
        <div class="composer-tools">
          <input ref="filePicker" type="file" hidden :accept="meta.fileTypes.join(',')" @change="onFile" />
          <button class="icon-button attach" title="添加附件" aria-label="添加附件" :disabled="sending" @click="$refs.filePicker.click()"><UiIcon name="clip" /></button>
          <span class="composer-shortcut">Enter 发送 · Shift Enter 换行</span>
          <el-button class="send-button" type="primary" :loading="sending" :disabled="sending || (!text.trim() && !file)" @click="submit"><span>发送</span><UiIcon name="send" /></el-button>
        </div>
      </div>
      <div class="composer-hint">{{ recipients.length ? '发送给 ' + recipients.map(r => expertLabels[r]).join('、') : '发送到专家群 · 输入 @ 指定专家' }}</div>
    </div>
  </div>`,
});
