import { computed, defineComponent, inject, nextTick, provide, ref, watch } from "vue";
import { api, call } from "../../api.js";
import { ApprovalDialog } from "../../collaboration-ui.js";
import { UnderstandingRequirement, UnderstandingQuestion } from "../../understanding-rows.js";
import Requirements from "./requirements.js";
import Scenarios from "./scenarios.js";
import Questions from "./questions.js";
import { understandingAction, understandingBoard } from "../../../shared/understanding.js";

export default defineComponent({
  components: { Requirements, Scenarios, Questions, ApprovalDialog, UnderstandingRequirement, UnderstandingQuestion },
  setup() {
    const { id, view, reload } = inject("project");
    const { understandingPane: pane, focus, open } = inject("workspace");
    const approvalVisible = ref(false), records = ref(""), search = ref(""), linking = ref(null), sceneChoice = ref("");
    const requirementEditor = ref(null), scenarioEditor = ref(null), questionEditor = ref(null);
    const board = computed(() => understandingBoard(view.value));
    const action = computed(() => understandingAction(view.value));
    const starting = ref(false);
    const matches = value => !search.value.trim() || JSON.stringify(value).toLowerCase().includes(search.value.trim().toLowerCase());
    const groups = computed(() => board.value.groups.filter(g => matches([g.scene, g.rows.map(e => [e.req, e.questions]), g.constraints.map(e => [e.req, e.questions]), g.questions])));
    const buckets = computed(() => board.value.buckets.map(b => ({ ...b, rows: b.rows.filter(e => matches([e.req, e.questions, b.title])) })).filter(b => b.rows.length));
    const otherQuestions = computed(() => board.value.otherQuestions.filter(matches));
    const analyze = async () => {
      if (starting.value || !action.value || view.value.job?.status === "处理中") return;
      starting.value = true;
      try { if (await call(() => api(`/projects/${id}/${action.value.path}`, { method: "POST", body: action.value.body }))) await reload(); }
      finally { starting.value = false; }
    };
    const locate = async code => {
      search.value = "";
      records.value = "";
      await nextTick();
      const el = document.querySelector(`[data-understanding-ref="${CSS.escape(String(code))}"]`);
      if (!el) return;
      for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === "DETAILS") p.open = true;
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      el.classList.remove("understanding-highlight");
      requestAnimationFrame(() => el.classList.add("understanding-highlight"));
    };
    watch([focus, pane], async ([value, tab]) => {
      if (typeof value === "number") {
        const q = view.value.questions.find(q => q.id === value);
        if (q && !board.value.questions.some(q => q.id === value)) records.value = "questions";
        else await locate(`Q${value}`);
      } else if (value?.requirementCode) await locate(value.requirementCode);
      else if (typeof value === "string") {
        const req = view.value.requirements.find(r => r.code === value);
        if (req?.status === "已删除") records.value = "requirements";
        else if (view.value.scenarios.some(s => s.code === value && s.status === "已归档")) records.value = "scenarios";
        else await locate(value);
      } else if (tab === "questions") {
        await nextTick();
        document.querySelector('.understanding-question')?.scrollIntoView({ block: "nearest" });
      }
    }, { immediate: true });
    provide("understandingActions", {
      edit: r => requirementEditor.value.edit(r), source: r => requirementEditor.value.openSource(r),
      answer: q => questionEditor.value.startAnswer(q), review: q => questionEditor.value.openReview(q), locate,
      disposition: d => scenarioEditor.value.disposition(d), link: r => { linking.value = r; sceneChoice.value = ""; },
    });
    const link = () => {
      const scene = view.value.scenarios.find(s => s.code === sceneChoice.value);
      if (!scene || !linking.value) return;
      scenarioEditor.value.linkRequirement(scene, linking.value);
      linking.value = null;
    };
    const started = async () => { await reload(); open("pbs"); };
    return { id, view, open, board, groups, buckets, otherQuestions, search, records, linking, sceneChoice, link,
      requirementEditor, scenarioEditor, questionEditor, analyze, action, starting, approvalVisible, started, locate };
  },
  template: `
  <div class="understanding-board">
    <div class="understanding-header">
      <div><h1>需求理解</h1><p class="muted">业务场景 → 具体要求 → 原文依据</p></div>
      <div class="actions"><el-button v-if="board.requirements.length" :disabled="starting || view.job?.status === '处理中'" @click="approvalVisible = true">审阅并交给 PBS</el-button><el-button v-if="action" type="primary" :loading="starting" :disabled="view.job?.status === '处理中'" @click="analyze">{{ action.label }}</el-button></div>
    </div>
    <div class="understanding-overview"><span><b>{{ board.groups.length }}</b> 个业务场景</span><span><b>{{ board.requirements.length }}</b> 条独立需求</span><span v-if="board.shared">{{ board.shared }} 条跨场景共用</span><span v-if="board.questions.length">{{ board.questions.length }} 项待明确</span></div>
    <div v-if="board.needsUpdate || board.unassigned" class="association-notice"><span v-if="board.needsUpdate">{{ board.needsUpdate }} 个场景的关联需重新核对。</span><span v-if="board.unassigned">{{ board.unassigned }} 条需求待安排。</span><span>可直接调整，或让需求理解专家更新关联。</span></div>
    <div class="understanding-tools"><el-input v-model="search" clearable placeholder="查找场景、需求或问题" aria-label="查找场景、需求或问题" /><div class="inline-actions"><button :disabled="!board.requirements.some(r => r.category !== '范围外')" @click="scenarioEditor.startEdit(null)">新增场景</button><button @click="requirementEditor.add()">新增需求</button><el-dropdown trigger="click" @command="records = $event"><button class="text-action">全部记录 ···</button><template #dropdown><el-dropdown-menu><el-dropdown-item command="requirements">需求台账与测算参数</el-dropdown-item><el-dropdown-item command="questions">澄清处理记录</el-dropdown-item><el-dropdown-item command="scenarios">场景合并与历史</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div></div>
    <nav v-if="board.groups.length + board.buckets.length > 1" class="understanding-index" aria-label="页内定位"><button v-for="g in board.groups" :key="g.scene.code" @click="locate(g.scene.code)">{{ g.scene.name }}</button><button v-for="b in board.buckets" :key="b.key" @click="locate(b.key)">{{ b.title }} {{ b.rows.length }}</button></nav>
    <div v-if="!board.requirements.length" class="empty">添加客户材料后，专家会在这里一起整理业务场景、具体要求和待明确事项。<el-button link type="primary" @click="open('materials')">查看材料</el-button></div>
    <div v-else-if="!board.groups.length" class="scene-empty">需求已保留在下方，尚未组织业务场景。可以整理场景，也可以手动新增。</div>
    <section v-for="g in groups" :key="g.scene.code" class="understanding-scene" :data-understanding-ref="g.scene.code">
      <header class="scene-heading"><div><div class="record-code">{{ g.scene.code }} · 业务场景</div><h2>{{ g.scene.name }}</h2></div><div class="inline-actions"><button @click="scenarioEditor.startEdit(g.scene)">编辑场景与关联</button><button @click="scenarioEditor.detail(g.scene)">依据与历史</button></div></header>
      <p v-if="g.scene.goal" class="scene-goal">{{ g.scene.goal }}</p>
      <div v-if="g.scene.actors.length || g.scene.trigger || g.scene.context" class="scene-context"><span v-if="g.scene.actors.length"><b>参与角色</b>{{ g.scene.actors.join('、') }}</span><span v-if="g.scene.trigger"><b>业务触发</b>{{ g.scene.trigger }}</span><span v-if="g.scene.context"><b>业务范围</b>{{ g.scene.context }}</span></div>
      <details v-if="g.scene.activities.length || g.scene.boundaries.length || g.scene.outcomes.length || g.scene.assumptions.length" class="scene-description"><summary>活动、结果与边界</summary><ol v-if="g.scene.activities.length"><li v-for="(a, i) in g.scene.activities" :key="i">{{ a.text }} <button v-for="code in a.req_ids" :key="code" class="text-action" @click="locate(code)">{{ code }}</button></li></ol><p v-if="g.scene.outcomes.length">预期结果：{{ g.scene.outcomes.join('；') }}</p><p v-if="g.scene.boundaries.length">边界：{{ g.scene.boundaries.join('；') }}</p><p v-for="(a, i) in g.scene.assumptions" :key="i" class="muted">分析推断：{{ a.text }}（{{ a.reason }}）</p></details>
      <div v-if="g.needsUpdate" class="association-notice">{{ g.scene.review_reason || '需求发生变化，请重新核对本场景的关联。' }}<span v-if="g.missing.length">关联已失效：{{ g.missing.join('、') }}。</span></div>
      <div class="scene-requirements-label"><b>具体要求</b><span>{{ g.rows.length }} 条<span v-if="g.questionCount"> · {{ g.questionCount }} 项待明确</span></span></div>
      <UnderstandingRequirement v-for="e in g.rows" :key="e.req.code" :entry="e" :context="g.scene.code" />
      <details v-if="g.constraints.length" class="scene-constraints"><summary>同时适用 {{ g.constraints.length }} 条共性约束</summary><UnderstandingRequirement v-for="e in g.constraints" :key="e.req.code" :entry="e" :context="g.scene.code" /></details>
      <UnderstandingQuestion v-for="q in g.questions" :key="q.id" :question="q" />
    </section>
    <section v-for="b in buckets" :key="b.key" class="understanding-scene supporting-requirements" :data-understanding-ref="b.key"><header class="scene-heading"><div><h2>{{ b.title }} <small>{{ b.rows.length }}</small></h2><p class="muted">{{ b.hint }}</p></div></header><UnderstandingRequirement v-for="e in b.rows" :key="e.req.code" :entry="e" /></section>
    <section v-if="otherQuestions.length" class="understanding-scene" data-understanding-ref="questions"><header class="scene-heading"><div><h2>其他待明确事项</h2><p class="muted">项目级问题，以及尚未归入具体要求的问题。</p></div></header><UnderstandingQuestion v-for="q in otherQuestions" :key="q.id" :question="q" /></section>
    <p v-if="search && !groups.length && !buckets.length && !otherQuestions.length" class="empty">没有找到匹配的场景、需求或问题。</p>
  </div>
  <Requirements ref="requirementEditor" editor-only /><Scenarios ref="scenarioEditor" editor-only /><Questions ref="questionEditor" editor-only />
  <el-drawer :model-value="!!records" @close="records = ''" :title="({requirements: '需求台账与测算参数', questions: '澄清处理记录', scenarios: '场景合并与历史'})[records]" size="90%"><Requirements v-if="records === 'requirements'" /><Questions v-if="records === 'questions'" /><Scenarios v-if="records === 'scenarios'" /></el-drawer>
  <el-dialog :model-value="!!linking" @close="linking = null" title="关联到业务场景" width="560px"><template v-if="linking"><p>{{ linking.code }} · {{ linking.text }}</p><p class="muted">共用同一条需求。选择场景后可核对关联用途与业务活动。</p><el-select v-model="sceneChoice" placeholder="选择业务场景" style="width:100%"><el-option v-for="g in board.groups" :key="g.scene.code" :label="g.scene.code + ' · ' + g.scene.name" :value="g.scene.code" /></el-select><p v-if="!board.groups.length" class="muted">尚无场景，请先新增或整理业务场景。</p></template><template #footer><el-button @click="linking = null">取消</el-button><el-button type="primary" :disabled="!sceneChoice" @click="link">核对关联</el-button></template></el-dialog>
  <ApprovalDialog v-model="approvalVisible" :project-id="id" :open="open" @started="started" />`,
});
