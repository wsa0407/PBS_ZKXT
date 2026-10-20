import { computed, defineComponent, inject, onMounted, ref } from "vue";
import { api, call, fmtTime } from "../../api.js";
import { LEVEL_TYPE } from "../../ui.js";

export default defineComponent({
  setup() {
    const { id, view, reload } = inject("project");
    const log = ref({ events: [], llm: [] });
    onMounted(async () => (log.value = (await call(() => api(`/projects/${id}/events`))) ?? log.value));

    const s = computed(() => view.value.steps);
    const blockers = computed(() => view.value.audit.filter((a) => a.level === "阻断"));
    const warnings = computed(() => view.value.audit.filter((a) => a.level === "警告"));
    const ready = computed(() => s.value.pbs.items > 0 && !blockers.value.length && !s.value.pbs.uncovered);
    const llmSummary = computed(() => {
      const rows = log.value.llm;
      return { calls: rows.length, ms: rows.reduce((a, r) => a + r.ms, 0), tokens: rows.reduce((a, r) => a + r.prompt_tokens + r.completion_tokens, 0), models: [...new Set(rows.map((r) => r.model))].join("、") };
    });

    const finish = async (done) => {
      await call(() => api(`/projects/${id}`, { method: "PUT", body: { done } }), done ? "已标记为完成" : "已重新打开");
      reload();
    };

    return { view, s, blockers, warnings, ready, log, llmSummary, finish, fmtTime, LEVEL_TYPE, id };
  },
  template: `
  <div v-if="!s.pbs.items" class="empty">还没有 PBS，没有可导出的内容。</div>
  <template v-else>
    <el-card shadow="never">
      <template #header><b>交付前检查</b></template>
      <div class="check" :class="{ ok: !s.requirements.pending }">{{ s.requirements.pending ? '⚠' : '✓' }} 需求：{{ s.requirements.confirmed }} / {{ s.requirements.total }} 条已确认<span v-if="s.requirements.pending">，还有 {{ s.requirements.pending }} 条待确认（其中必审 {{ s.requirements.mustReview }}）</span></div>
      <div class="check" :class="{ ok: s.scenarios.active && !s.scenarios.pending && !s.scenarios.unmapped.length }">场景：{{ s.scenarios.confirmed }} / {{ s.scenarios.active }} 条已确认；{{ s.scenarios.unmapped.length }} 条原始需求待归类</div>
      <div class="check" :class="{ ok: !s.questions.open && !s.questions.answered }">{{ s.questions.open || s.questions.answered ? '⚠' : '✓' }} 澄清：{{ s.questions.applied }} 个已应用<span v-if="s.questions.open || s.questions.answered">，{{ s.questions.open }} 个待处理，{{ s.questions.answered }} 个已答复未应用</span></div>
      <div class="check" :class="{ ok: !s.pbs.uncovered }">{{ s.pbs.uncovered ? '✗' : '✓' }} 覆盖：{{ s.pbs.uncovered ? s.pbs.uncovered + ' 条必须需求没有被 PBS 承接' : '所有必须需求都有 PBS 项承接' }}</div>
      <div class="check" :class="{ ok: !s.pbs.stale }">{{ s.pbs.stale ? '⚠' : '✓' }} 复核：{{ s.pbs.stale ? s.pbs.stale + ' 项因需求或参数变化待复核' : '没有待复核的项' }}</div>
      <div class="check" :class="{ ok: !s.pbs.pendingQty }">{{ s.pbs.pendingQty ? '⚠' : '✓' }} 数量：{{ s.pbs.pendingQty ? s.pbs.pendingQty + ' 项数量待估' : '所有项都有数量' }}</div>
      <div class="check" :class="{ ok: !blockers.length }">{{ blockers.length ? '✗' : '✓' }} 阻断问题：{{ blockers.length }} 个</div>
      <div v-for="(b, k) in blockers" :key="k" class="risk-line"><el-tag size="small" type="danger">{{ b.type }}</el-tag> {{ b.message }}</div>
      <div v-for="(w, k) in warnings.slice(0, 6)" :key="'w' + k" class="risk-line"><el-tag size="small" type="warning">{{ w.type }}</el-tag> {{ w.message }}</div>
      <div class="muted" v-if="warnings.length > 6">另有 {{ warnings.length - 6 }} 条警告，见导出文件的“审核结果”。</div>
    </el-card>

    <el-card shadow="never" style="margin-top:12px">
      <div class="row">
        <a :href="'/api/projects/' + id + '/export.xlsx'"><el-button type="primary" size="large">导出 Excel</el-button></a>
        <span class="muted">包含 PBS 清单、场景需求、需求对应表、需求去向、澄清问题、测算参数、审核结果</span>
        <span style="flex:1"></span>
        <el-button v-if="!view.project.done" :type="ready ? 'success' : 'default'" @click="finish(true)">标记项目完成</el-button>
        <el-button v-else @click="finish(false)">重新打开</el-button>
      </div>
      <el-alert v-if="!ready && !view.project.done" type="warning" :closable="false" show-icon style="margin-top:10px" title="还有阻断问题或未覆盖的必须需求，建议处理后再标记完成（仍然可以导出）。" />
    </el-card>

    <el-card shadow="never" style="margin-top:12px">
      <template #header><b>模型调用</b><span class="muted" style="margin-left:8px">共 {{ llmSummary.calls }} 次 · {{ (llmSummary.ms / 1000).toFixed(0) }} 秒 · {{ llmSummary.tokens }} tokens · {{ llmSummary.models || '—' }}</span></template>
      <el-table :data="log.llm.slice(0, 12)" size="small" empty-text="还没有调用记录">
        <el-table-column prop="step" label="步骤" width="120" /><el-table-column prop="model" label="模型" width="140" />
        <el-table-column label="耗时" width="80"><template #default="{ row }">{{ (row.ms / 1000).toFixed(1) }}s</template></el-table-column>
        <el-table-column label="tokens"><template #default="{ row }">{{ row.prompt_tokens }} + {{ row.completion_tokens }}</template></el-table-column>
        <el-table-column label="时间"><template #default="{ row }">{{ fmtTime(row.at) }}</template></el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" style="margin-top:12px">
      <template #header><b>操作记录</b></template>
      <div v-for="e in log.events.slice(0, 40)" :key="e.id" class="event"><span class="muted">{{ fmtTime(e.at) }}</span> <el-tag size="small" type="info">{{ e.kind }}</el-tag> {{ e.message }}</div>
    </el-card>
  </template>`,
});
