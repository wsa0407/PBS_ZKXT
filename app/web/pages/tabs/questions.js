import { computed, defineComponent, inject, nextTick, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, meta, runJob } from "../../api.js";
import { SCENARIO_FIELD_LABELS, scenarioFieldLabel, scenarioValue, IMPACT_TYPE, Q_STATUS_TYPE, questionStatusLabel, originLabel, impactLabel } from "../../ui.js";
import { questionPending, questionUnlinked, questionsForRequirement, questionActions } from "../../../shared/understanding.js";

const CHANGE_LABEL = { set_param: "设定参数", update_requirement: "修改需求", add_requirement: "新增需求", remove_requirement: "删除需求", update_scenario: "修改场景" };
const CHANGE_TYPE = { set_param: "primary", update_requirement: "warning", add_requirement: "success", remove_requirement: "danger", update_scenario: "warning" };

export default defineComponent({
  props: { requirementCode: String, embedded: Boolean },
  setup(props) {
    const { id, view, reload } = inject("project");
    const { open, focus } = inject("workspace");
    const filter = ref(props.embedded ? "all" : "open");
    const answering = ref(null);
    const review = ref(null);
    const adding = ref(null);

    const relatedRequirementCode = computed(() => props.requirementCode || focus.value?.requirementCode);
    const related = computed(() => relatedRequirementCode.value ? questionsForRequirement(view.value.requirements.find((r) => r.code === relatedRequirementCode.value) ?? { code: relatedRequirementCode.value }, view.value.questions) : view.value.questions);
    const needsResolution = computed(() => review.value?.q.proposal?.changes.some((c, i) => review.value.accepted.includes(i) && c.conflict));
    const questions = computed(() => {
      const all = related.value;
      if (filter.value === "open") return all.filter((q) => ["待处理", "待答复", "已答复"].includes(q.status));
      if (filter.value === "unlinked") return all.filter((q) => questionUnlinked(q) && questionPending(q));
      if (filter.value === "done") return all.filter((q) => q.status === "已应用");
      if (filter.value === "ignored") return all.filter((q) => q.status === "已忽略");
      return all;
    });
    const count = (pred) => related.value.filter(pred).length;
    const reqByCode = computed(() => new Map(view.value.requirements.map((r) => [r.code, r])));
    const newQuestion = () => { adding.value = { question: "", impact: "影响方案", reason: "", req_ids: relatedRequirementCode.value ? [relatedRequirementCode.value] : [], scenario_ids: [], field_paths: [] }; };
    watch(() => focus.value, async (qid) => {
      if (qid?.requirementCode) { filter.value = "open"; return; }
      if (props.embedded || typeof qid !== "number" || !related.value.some((q) => q.id === qid)) return;
      filter.value = "all";
      await nextTick();
      document.getElementById(`question-${qid}`)?.scrollIntoView({ block: "nearest" });
    }, { immediate: true });

    const update = async (q, body) => {
      await call(() => api(`/projects/${id}/questions/${q.id}`, { method: "PUT", body }));
      reload();
    };
    const assign = async (q) => {
      const { value } = await ElMessageBox.prompt("记录由谁跟进这项澄清？此操作仅保存姓名，不会发送通知。", "负责人", { inputValue: q.assignee, confirmButtonText: "保存负责人" });
      update(q, { assignee: value ?? "" });
    };
    const ignore = (q) => update(q, { status: "已忽略" });
    const restore = (q) => update(q, { status: "待处理" });
    const remove = async (q) => {
      await ElMessageBox.confirm(`删除这项澄清及其答复记录？此操作不可恢复，已采纳到需求、场景或参数中的变更不会撤销。\n${q.question}`, "删除", { type: "warning" });
      await call(() => api(`/projects/${id}/questions/${q.id}`, { method: "DELETE" }));
      reload();
    };

    const startAnswer = (q) => (answering.value = { q, answer: q.answer || "", source: q.answer_source || "口头" });
    const submitAnswer = async () => {
      const { q, answer, source } = answering.value;
      const result = await runJob("模型分析答复带来的变化", () =>
        api(`/projects/${id}/questions/${q.id}/answer`, { method: "POST", body: { answer, answer_source: source } }),
      );
      if (!result) return;
      answering.value = null;
      await reload();
      openReview(view.value.questions.find((x) => x.id === q.id));
    };

    const openReview = (q) => {
      if (!q || !questionActions(q).review) return;
      const changes = q.proposal?.changes ?? [];
      review.value = { q, accepted: changes.map((c, i) => !c.conflict && c.quoteVerified ? i : null).filter((i) => i !== null), resolution_note: "" };
    };
    const apply = async () => {
      const { q, accepted } = review.value;
      if (!accepted.length) await ElMessageBox.confirm("本次不修改需求、场景或参数，并将这项澄清记为已处理。此操作不表示现有内容已核实正确。", "记录不变更", { confirmButtonText: "记录并结束处理", cancelButtonText: "返回审阅" });
      const res = await call(() => api(`/projects/${id}/questions/${q.id}/apply`, { method: "POST", body: { accepted, resolution_note: review.value.resolution_note } }));
      if (res) {
        review.value = null;
        await reload();
      }
    };
    const toggle = (i, on) => {
      const set = new Set(review.value.accepted);
      on ? set.add(i) : set.delete(i);
      review.value.accepted = [...set].sort((a, b) => a - b);
    };

    const addQuestion = async () => {
      if (await call(() => api(`/projects/${id}/questions`, { method: "POST", body: adding.value }), "已新增")) {
        adding.value = null;
        reload();
      }
    };

    return { SCENARIO_FIELD_LABELS, scenarioFieldLabel, scenarioValue, view, filter, related, relatedRequirementCode, needsResolution, questions, count, reqByCode, answering, review, adding, meta, open, focus, newQuestion, questionPending, questionUnlinked, questionActions, assign, ignore, restore, remove, startAnswer, submitAnswer, openReview, apply, toggle, addQuestion, CHANGE_LABEL, CHANGE_TYPE, IMPACT_TYPE, Q_STATUS_TYPE, questionStatusLabel, originLabel, impactLabel };
  },
  template: `
  <div v-if="relatedRequirementCode && !embedded" class="toolbar"><span>关联需求：{{ relatedRequirementCode }}</span><el-button link type="primary" @click="open('questions')">查看全部问题</el-button></div>
  <div v-if="!related.length" class="empty">
    {{ relatedRequirementCode ? '这条需求暂无关联问题。' : '暂无澄清事项。理解材料时发现的信息缺口会保留在这里。' }}
    <el-button link type="primary" @click="newQuestion">新增待澄清事项</el-button>
  </div>
  <template v-else>
    <el-alert v-if="!embedded" type="info" :closable="false" style="margin-bottom:12px"
      title="录入客户答复后，先审阅它对需求、场景和参数的变更建议，再决定采纳。没有关联需求的疑问可以先作为待判断事项保留。" />
    <div class="toolbar">
      <el-radio-group v-model="filter" size="small">
        <el-radio-button value="open">待处理 {{ count((q) => ['待处理', '待答复', '已答复'].includes(q.status)) }}</el-radio-button>
        <el-radio-button v-if="!embedded && !relatedRequirementCode" value="unlinked">待判断 {{ count((q) => questionUnlinked(q) && questionPending(q)) }}</el-radio-button>
        <el-radio-button value="done">已处理 {{ count((q) => q.status === '已应用') }}</el-radio-button>
        <el-radio-button value="ignored">暂不处理 {{ count((q) => q.status === '已忽略') }}</el-radio-button>
        <el-radio-button value="all">全部</el-radio-button>
      </el-radio-group>
      <span style="flex:1"></span>
      <el-button size="small" @click="newQuestion">新增待澄清事项</el-button>
    </div>

    <div v-if="!questions.length" class="empty">这一类没有问题</div>
    <el-card v-for="q in questions" :key="q.id" :id="'question-' + q.id" shadow="never" class="q-card" :class="{ 'question-focus': !embedded && focus === q.id }">
      <div class="row">
        <b>Q{{ q.id }}</b>
        <el-tag :type="IMPACT_TYPE[q.impact]" size="small">{{ impactLabel(q.impact) }}</el-tag>
        <el-tag :type="Q_STATUS_TYPE[q.status]" size="small" effect="plain">{{ questionStatusLabel(q.status) }}</el-tag>
        <el-tag size="small" type="info">{{ originLabel(q.source) }}</el-tag>
        <el-tag v-if="questionUnlinked(q) && questionPending(q)" size="small" type="warning">待判断事项</el-tag>
        <span v-if="q.assignee" class="muted">负责人：{{ q.assignee }}</span>
        <span style="flex:1"></span>
        <el-button v-if="questionActions(q).assign" link @click="assign(q)">{{ q.assignee ? '修改负责人' : '指定负责人' }}</el-button>
        <el-button v-if="questionActions(q).answer" link type="primary" :disabled="view.job?.status === '处理中'" @click="startAnswer(q)">{{ q.answer ? '修改答复' : '录入答复' }}</el-button>
        <el-button v-if="questionActions(q).review" link type="success" @click="openReview(q)">审阅答复建议</el-button>
        <el-button v-if="questionActions(q).restore" link @click="restore(q)">{{ q.answer && q.proposal ? '恢复答复审阅' : '恢复为待处理' }}</el-button>
        <el-button v-if="questionActions(q).defer" link title="不纳入本轮待办与导出清单，可在暂不处理中恢复" @click="ignore(q)">暂不处理</el-button>
        <el-button link type="danger" @click="remove(q)">删除</el-button>
      </div>
      <div class="q-text">{{ q.question }}</div>
      <div class="muted" v-if="q.reason">为什么问：{{ q.reason }}</div>
      <div class="muted" v-if="q.suggested_answer">待确认的分析建议：{{ q.suggested_answer }}</div>
      <div v-if="q.req_ids.length" class="muted">关联需求：<el-button v-for="c in q.req_ids" :key="c" link type="primary" :title="reqByCode.get(c)?.text" @click="open('requirements', c)">{{ c }}</el-button></div>
      <div v-if="q.scenario_ids.length" class="muted">关联场景：<el-button v-for="code in q.scenario_ids" :key="code" link type="primary" @click="open('scenarios', code)">{{ code }}</el-button><span v-if="q.field_paths.length"> · {{ q.field_paths.map(scenarioFieldLabel).join('、') }}</span></div>
      <div v-if="q.answer" class="answer"><b>客户答复（{{ q.answer_source }}）：</b>{{ q.answer }}</div>
      <div v-if="q.applied" class="applied">
        <b>本次处理：</b>
        <span v-if="!q.applied.changes.length">未修改需求、场景或参数</span>
        <el-tag v-for="(c, i) in q.applied.changes" :key="i" size="small" :type="CHANGE_TYPE[c.type]">{{ CHANGE_LABEL[c.type] }}</el-tag>
      </div>
    </el-card>
  </template>

  <el-dialog :model-value="!!answering" @close="answering = null" title="录入客户答复" width="560px">
    <template v-if="answering">
      <div class="q-text">{{ answering.q.question }}</div>
      <el-form label-position="top" style="margin-top:12px">
        <el-form-item label="客户怎么说"><el-input v-model="answering.answer" type="textarea" :rows="4" placeholder="照客户原话记录，例如：确认 12 个机场，沿高速每 10 公里一个" /></el-form-item>
        <el-form-item label="答复来源"><el-radio-group v-model="answering.source"><el-radio-button v-for="s in ['口头', '邮件', '答疑文件', '会议纪要']" :key="s" :value="s">{{ s }}</el-radio-button></el-radio-group></el-form-item>
      </el-form>
      <div class="muted">提交会保存客户答复，并分析对需求、场景和测算参数的影响；你采纳后才更新相关内容。</div>
    </template>
    <template #footer><el-button @click="answering = null">取消</el-button><el-button type="primary" :disabled="!answering?.answer.trim() || view.job?.status === '处理中'" @click="submitAnswer">提交并分析</el-button></template>
  </el-dialog>

  <el-dialog :model-value="!!review" @close="review = null" title="答复带来的变更建议" width="760px">
    <template v-if="review">
      <div class="q-text">{{ review.q.question }}</div>
      <div class="answer"><b>客户答复：</b>{{ review.q.answer }}</div>
      <div class="muted" style="margin:10px 0">{{ review.q.proposal.summary }}</div>
      <el-empty v-if="!review.q.proposal.changes.length" description="未形成可直接采纳的变更建议，请判断是否需补充答复或手动调整" :image-size="60" />
      <div v-for="(c, i) in review.q.proposal.changes" :key="i" class="change">
        <el-checkbox :disabled="!c.quoteVerified" :model-value="review.accepted.includes(i)" @change="(v) => toggle(i, v)" />
        <div style="flex:1">
          <el-tag size="small" :type="CHANGE_TYPE[c.type]">{{ CHANGE_LABEL[c.type] }}</el-tag>
          <template v-if="c.type === 'set_param'"> <b>{{ c.label }}</b>：{{ c.before ?? '未知' }} → <b>{{ c.value }}{{ c.unit }}</b></template>
          <template v-else-if="c.type === 'update_requirement'"> {{ c.code }}<div class="diff"><s>{{ c.before }}</s><br />{{ c.text }}</div></template>
          <template v-else-if="c.type === 'update_scenario'"> {{ c.code }} · {{ scenarioFieldLabel(c.field_path) }}<div class="diff"><s>{{ scenarioValue(c.before) }}</s><br />{{ scenarioValue(c.value) }}</div></template>
          <template v-else-if="c.type === 'add_requirement'"> <div class="diff">{{ c.text }}（{{ c.category }} · {{ c.priority }}）</div></template>
          <template v-else-if="c.type === 'remove_requirement'"> {{ c.code }}<div class="diff"><s>{{ c.before }}</s><br />{{ c.reason }}</div></template>
          <el-alert v-if="c.conflict" :title="c.conflict" type="warning" :closable="false" />
          <div class="muted">依据：“{{ c.quote }}” <el-tag v-if="!c.quoteVerified" size="small" type="warning">引用未定位，不能直接采纳</el-tag></div>
        </div>
      </div>
      <el-form-item v-if="needsResolution" label="冲突处理依据" required><el-input v-model="review.resolution_note" type="textarea" placeholder="记录采用答复的依据及如何处理与正式条款的冲突" /></el-form-item>
      <el-alert v-for="d in review.q.proposal.dropped" :key="d" type="warning" :closable="false" :title="'未采用的建议：' + d" style="margin-top:8px" />
      <div class="muted" style="margin-top:12px">采纳后更新所选内容，相关 PBS 可能重算数量或提示复核。未勾选的建议不执行；这项澄清会记为已处理。</div>
    </template>
    <template #footer>
      <el-button @click="review = null">稍后处理</el-button>
      <el-button type="primary" :disabled="needsResolution && !review?.resolution_note.trim()" @click="apply">{{ review?.accepted.length ? '采纳所选并更新（' + review.accepted.length + '）' : '记录不变更并结束处理' }}</el-button>
    </template>
  </el-dialog>

  <el-dialog :model-value="!!adding" @close="adding = null" title="添加澄清问题" width="560px">
    <el-form v-if="adding" label-position="top">
      <el-form-item label="问题"><el-input v-model="adding.question" type="textarea" :rows="3" /></el-form-item>
      <el-form-item label="影响"><el-radio-group v-model="adding.impact"><el-radio-button v-for="i in ['影响废标风险', '影响报价', '影响方案']" :key="i" :value="i">{{ impactLabel(i) }}</el-radio-button></el-radio-group></el-form-item>
      <el-form-item label="原因"><el-input v-model="adding.reason" /></el-form-item>
      <el-form-item label="关联需求（可选）"><el-select v-model="adding.req_ids" multiple filterable style="width:100%" placeholder="尚不明确时可留空"><el-option v-for="r in view.requirements.filter((r) => r.status !== '已删除')" :key="r.code" :value="r.code" :label="r.code + ' ' + r.text" /></el-select></el-form-item>
      <el-form-item label="关联场景"><el-select v-model="adding.scenario_ids" multiple filterable style="width:100%"><el-option v-for="s in view.scenarios.filter((s) => s.status !== '已归档')" :key="s.code" :value="s.code" :label="s.code + ' ' + s.name" /></el-select></el-form-item>
      <el-form-item v-if="adding.scenario_ids.length" label="涉及场景字段"><el-select v-model="adding.field_paths" multiple style="width:100%"><el-option v-for="(label, field) in SCENARIO_FIELD_LABELS" :key="field" :value="field" :label="label" /></el-select></el-form-item>
    </el-form>
    <template #footer><el-button @click="adding = null">取消</el-button><el-button type="primary" :disabled="!adding?.question.trim()" @click="addQuestion">添加</el-button></template>
  </el-dialog>`,
});
