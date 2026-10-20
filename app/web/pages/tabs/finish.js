import { computed, defineComponent, inject, onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, fmtTime } from "../../api.js";
import { exportReview, findingTarget } from "../../../shared/presentation.js";

export default defineComponent({
  setup() {
    const { id, view, reload } = inject("project");
    const { open } = inject("workspace");
    const log = ref({ events: [], llm: [] });
    onMounted(async () => (log.value = (await call(() => api(`/projects/${id}/events`))) ?? log.value));
    const review = computed(() => exportReview(view.value));
    const findings = computed(() => view.value.audit.map(a => ({ ...a, target: findingTarget(view.value, a) })));
    const blockers = computed(() => findings.value.filter((a) => a.level === "阻断"));
    const warnings = computed(() => findings.value.filter((a) => a.level === "警告"));
    const notes = computed(() => findings.value.filter((a) => a.level === "提示"));
    const llmSummary = computed(() => ({ calls: log.value.llm.length, tokens: log.value.llm.reduce((a, r) => a + r.prompt_tokens + r.completion_tokens, 0) }));
    const inspect = (finding) => {
      if (finding.target) open(finding.target.tab, finding.target.focus);
    };
    const finish = async (done) => {
      if (done) await ElMessageBox.confirm(review.value.draft
        ? "仍有待核对内容。标记本轮完成只修改整理状态，不会解决检查问题，也不会确认需求、数量或客户验收。是否仍结束本轮整理？"
        : "标记本轮整理完成？这仅记录人工整理状态，后续仍可继续修改。", "本轮整理状态", { confirmButtonText: "标记本轮完成", cancelButtonText: "继续核对", type: review.value.draft ? "warning" : "info" });
      if (await call(() => api(`/projects/${id}`, { method: "PUT", body: { done } }), done ? "本轮整理已标记完成" : "已恢复为整理中")) await reload();
    };
    return { view, review, blockers, warnings, notes, log, llmSummary, finish, inspect, open, fmtTime, id };
  },
  template: `
  <div v-if="!view.items.length" class="empty">还没有 PBS 草稿。<el-button link type="primary" @click="open('pbs')">去编制 PBS</el-button></div>
  <template v-else>
    <el-card shadow="never">
      <template #header><b>导出前检查</b><p class="muted" style="margin:6px 0 0">核对完整性、依据和审阅状态；关联关系与系统检查不能代替业务判断。</p></template>
      <div v-for="c in review.checks" :key="c.key" class="export-check" :class="{ ok: !c.count }">
        <div><b>{{ c.count ? '待核对' : '✓' }} · {{ c.label }}</b><div>{{ c.text }}</div></div>
        <el-button link type="primary" @click="open(c.tab)">{{ c.count ? '去处理' : '查看' }}</el-button>
      </div>
      <el-divider />
      <b>优先处理（{{ blockers.length }}）</b>
      <p class="muted">包括重点条款缺失、明确选型冲突等问题；请核对原文和产品资料后处理。</p>
      <div v-for="(b, k) in blockers" :key="k" class="risk-line"><el-tag size="small" type="danger">{{ b.type }}</el-tag> {{ b.message }} <el-button v-if="b.target" link type="primary" @click="inspect(b)">{{ b.target.label }}</el-button></div>
      <div v-if="!blockers.length" class="muted">当前检查未发现此类问题。</div>
      <el-collapse style="margin-top:12px">
        <el-collapse-item :title="'需要核对（' + warnings.length + '）'" name="warnings"><div v-for="(w, k) in warnings" :key="k" class="risk-line"><el-tag size="small" type="warning">{{ w.type }}</el-tag> {{ w.message }} <el-button v-if="w.target" link type="primary" @click="inspect(w)">{{ w.target.label }}</el-button></div><span v-if="!warnings.length" class="muted">暂无</span></el-collapse-item>
        <el-collapse-item :title="'其他核对提示（' + notes.length + '）'" name="notes"><div v-for="(n, k) in notes" :key="k" class="risk-line"><el-tag size="small" type="info">{{ n.type }}</el-tag> {{ n.message }} <el-button v-if="n.target" link type="primary" @click="inspect(n)">{{ n.target.label }}</el-button></div><span v-if="!notes.length" class="muted">暂无</span></el-collapse-item>
      </el-collapse>
    </el-card>
    <el-card shadow="never" style="margin-top:12px">
      <div class="row">
        <a :href="'/api/projects/' + id + '/export.xlsx'"><el-button type="primary" size="large">{{ review.draft ? '导出当前草稿（Excel）' : '导出 PBS（Excel）' }}</el-button></a>
        <span class="muted">包含 PBS、业务场景、需求对应、澄清、测算与检查结果，以及方案和 BOM 版本。</span>
        <span style="flex:1"></span>
        <el-button v-if="!view.project.done" @click="finish(true)">标记本轮完成</el-button>
        <el-button v-else @click="finish(false)">继续整理</el-button>
      </div>
      <el-alert v-if="review.draft" type="warning" :closable="false" show-icon style="margin-top:10px" title="仍有待核对内容，可先导出草稿。导出文件会保留当前状态与检查结果；本轮完成标记不代表审核通过。" />
    </el-card>
    <el-collapse style="margin-top:12px">
      <el-collapse-item title="操作记录" name="events"><div v-for="e in log.events.slice(0, 40)" :key="e.id" class="event"><span class="muted">{{ fmtTime(e.at) }}</span> <el-tag size="small" type="info">{{ e.kind }}</el-tag> {{ e.message }}</div><span v-if="!log.events.length" class="muted">暂无记录</span></el-collapse-item>
      <el-collapse-item title="运行记录（排查用）" name="runtime">
        <p class="muted">已记录 {{ llmSummary.calls }} 次模型调用 · {{ llmSummary.tokens }} tokens；仅供排查，不表示业务成果已确认。</p>
        <el-table :data="log.llm.slice(0, 12)" size="small" empty-text="还没有调用记录">
          <el-table-column prop="step" label="运行步骤" width="120" /><el-table-column prop="model" label="模型" min-width="140" />
          <el-table-column label="记录耗时" width="90"><template #default="{ row }">{{ row.ms > 0 ? (row.ms / 1000).toFixed(1) + 's' : '未记录' }}</template></el-table-column>
          <el-table-column label="输入 / 输出 tokens"><template #default="{ row }">{{ row.prompt_tokens }} / {{ row.completion_tokens }}</template></el-table-column>
          <el-table-column label="时间"><template #default="{ row }">{{ fmtTime(row.at) }}</template></el-table-column>
        </el-table>
      </el-collapse-item>
    </el-collapse>
  </template>`,
});
