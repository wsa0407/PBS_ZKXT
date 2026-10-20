import { computed, defineComponent, onBeforeUnmount, onMounted, provide, ref } from "vue";
import { api, call, shell } from "../api.js";
import { router } from "../router.js";
import Chat from "./chat.js";
import Materials from "./tabs/materials.js";
import Requirements from "./tabs/requirements.js";
import Questions from "./tabs/questions.js";
import Scenarios from "./tabs/scenarios.js";
import Pbs from "./tabs/pbs.js";
import Finish from "./tabs/finish.js";

const TABS = [
  { key: "materials", label: "材料" },
  { key: "requirements", label: "需求" },
  { key: "scenarios", label: "场景需求" },
  { key: "questions", label: "澄清" },
  { key: "pbs", label: "PBS" },
  { key: "finish", label: "导出" },
];

export default defineComponent({
  components: { Chat, Materials, Requirements, Scenarios, Questions, Pbs, Finish },
  setup() {
    const id = router.params.id;
    const view = ref(null);
    const error = ref("");
    const tab = ref(router.params.tab && TABS.some((t) => t.key === router.params.tab) ? router.params.tab : "");
    const focus = ref(null);
    const wide = ref(false);

    const reload = async () => {
      try {
        view.value = await api(`/projects/${id}`);
        shell.project = view.value.project;
        if (!tab.value) tab.value = defaultTab();
      } catch (e) {
        error.value = e.message;
      }
    };
    provide("project", { id, view, reload });

    const rename = async () => {
      const name = prompt("项目名称", view.value.project.name);
      if (name?.trim()) {
        await call(() => api(`/projects/${id}`, { method: "PUT", body: { name: name.trim() } }));
        reload();
      }
    };
    onMounted(() => {
      shell.rename = rename;
      reload();
    });
    onBeforeUnmount(() => {
      shell.project = null;
      shell.rename = null;
    });

    function defaultTab() {
      const s = view.value?.steps;
      if (!s) return "materials";
      if (s.pbs.items) return "pbs";
      if (s.requirements.total) return "requirements";
      return "materials";
    }
    // The conversation drives the workspace: it opens the tab where the result of an action lives.
    const open = (key, focusId = null) => {
      tab.value = key === "export" ? "finish" : key === "capabilities" ? "scenarios" : key;
      focus.value = focusId;
      history.replaceState(null, "", `#/projects/${id}/${tab.value}`);
    };
    provide("workspace", { open, focus });

    const badges = computed(() => {
      const s = view.value?.steps;
      if (!s) return {};
      const b = (n, tip) => (n ? { n, tip } : null);
      return {
        materials: b(s.materials.pending, "份新材料未处理"),
        requirements: b(s.requirements.pending, `条待确认（必审 ${s.requirements.mustReview}）`),
        scenarios: b(s.scenarios.pending + s.scenarios.unmapped.length, "项场景或需求去向待审阅"),
        questions: b(s.questions.open + s.questions.answered, `个待处理（已答复待应用 ${s.questions.answered}）`),
        pbs: b(s.pbs.uncovered + s.pbs.stale + s.pbs.conflicts, `项待处理：未覆盖 ${s.pbs.uncovered}，待复核 ${s.pbs.stale}，冲突 ${s.pbs.conflicts}`),
      };
    });

    return { view, error, tab, TABS, open, badges, wide };
  },
  template: `
  <div v-if="error" class="empty">{{ error }} <a href="#/projects">返回项目列表</a></div>
  <template v-else-if="view">
    <div class="split" :class="{ wide }">
      <section class="pane chat-pane"><Chat :open="open" /></section>
      <section class="pane work-pane">
        <div class="stepbar">
          <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="open(t.key)">
            {{ t.label }}
            <el-tooltip v-if="badges[t.key]" :content="badges[t.key].n + ' ' + badges[t.key].tip"><span class="badge">{{ badges[t.key].n }}</span></el-tooltip>
          </button>
          <span style="flex:1"></span>
          <el-button link size="small" @click="wide = !wide">{{ wide ? '收窄工作区' : '放宽工作区' }}</el-button>
        </div>
        <div class="work-body">
          <Materials v-if="tab === 'materials'" />
          <Requirements v-else-if="tab === 'requirements'" />
          <Scenarios v-else-if="tab === 'scenarios'" />
          <Questions v-else-if="tab === 'questions'" />
          <Pbs v-else-if="tab === 'pbs'" />
          <Finish v-else-if="tab === 'finish'" />
        </div>
      </section>
    </div>
  </template>
  <div v-else class="empty">加载中……</div>`,
});
