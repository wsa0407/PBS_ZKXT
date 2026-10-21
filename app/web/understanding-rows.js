import { computed, defineComponent, inject } from "vue";
import { questionActions } from "../shared/understanding.js";

export const UnderstandingQuestion = defineComponent({
  props: { question: Object },
  setup(props) {
    const actions = inject("understandingActions");
    return { actions, available: computed(() => questionActions(props.question)) };
  },
  template: `<div class="understanding-question" :data-understanding-ref="'Q' + question.id">
    <div><span class="record-code">Q{{ question.id }}</span><span class="question-label">{{ question.status === '已答复' ? '答复待采纳' : '待明确' }}</span></div>
    <p>{{ question.question }}</p><small v-if="question.reason" class="muted">{{ question.reason }}</small>
    <div v-if="question.answer" class="answer">客户答复：{{ question.answer }}</div>
    <div class="inline-actions"><button v-if="available.review" @click="actions.review(question)">审阅答复建议</button><button v-else-if="available.answer" @click="actions.answer(question)">录入答复</button></div>
  </div>`,
});

export const UnderstandingRequirement = defineComponent({
  components: { UnderstandingQuestion },
  props: { entry: Object, context: String },
  setup(props) {
    const actions = inject("understandingActions");
    const { view } = inject("project");
    const source = computed(() => (view.value.sourceSnapshots ?? []).find(s => s.uid === props.entry.req.seg_uid));
    return { actions, source };
  },
  template: `<div class="understanding-requirement" :class="{ 'association-changed': entry.changed }" :data-understanding-ref="entry.req.code">
    <div class="requirement-meta"><span class="record-code">{{ entry.req.code }}</span><span>{{ entry.role || entry.req.category }}</span><span v-if="entry.req.priority === '必须'">必须</span><span v-if="entry.req.inferred" class="question-label">分析推断</span><span v-if="entry.changed" class="question-label">需求已修改 · 关联待核对</span></div>
    <p class="requirement-content">{{ entry.req.text }}</p>
    <div v-if="entry.shared.length > 1 || (!context && entry.shared.length)" class="shared-requirements"><span>{{ entry.shared.length > 1 ? '共用需求' : '用于' }}</span><button v-for="s in entry.shared" :key="s.code" @click="actions.locate(s.code)">{{ s.name }}</button></div>
    <div v-if="!context && entry.disposition?.kinds.includes('跨场景约束')" class="muted">适用：{{ entry.disposition.scenario_ids?.join('、') || '整个项目（含新增场景）' }}</div>
    <details v-if="entry.req.quote || source" class="requirement-evidence"><summary>{{ source?.material_title || '原文依据' }}<span v-if="source?.seg_id"> · {{ source.seg_id }}</span><span v-if="!entry.req.quote_verified"> · 引用待核对</span></summary><blockquote v-if="entry.req.quote">{{ entry.req.quote }}</blockquote><button v-if="source" class="text-action" @click="actions.source(entry.req)">查看原文上下文</button></details>
    <small v-else class="muted">{{ entry.req.source_note || '人工补充，尚未关联原文' }}</small>
    <div class="inline-actions"><button @click="actions.edit(entry.req)">修改需求</button><button v-if="entry.req.category !== '范围外'" @click="actions.link(entry.req)">关联场景</button><button v-if="entry.disposition" @click="actions.disposition(entry.disposition)">调整归类</button></div>
    <UnderstandingQuestion v-for="q in entry.questions" :key="q.id" :question="q" />
  </div>`,
});
