import { computed, defineComponent, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { api, call, shell, jobState } from "../api.js";
import { router } from "../router.js";
import Chat from "./chat.js";
import Materials from "./tabs/materials.js";
import Understanding from "./tabs/understanding.js";
import { workspaceTarget } from "../../shared/understanding.js";
import Pbs from "./tabs/pbs.js";
import Finish from "./tabs/finish.js";

const TABS = [
  { key: "materials", label: "材料", icon: "file" },
  { key: "understanding", label: "需求理解", icon: "layers" },
  { key: "pbs", label: "PBS", icon: "box" },
  { key: "finish", label: "导出", icon: "download" },
];

export default defineComponent({
  components: { Chat, Materials, Understanding, Pbs, Finish },
  setup() {
    const id = router.params.id;
    const view = ref(null);
    const error = ref("");
    const initial = workspaceTarget(router.params.tab, router.params.view);
    const tab = ref(router.params.tab ? initial.tab : "");
    const understandingPane = ref(initial.pane);
    const focus = ref(null);
    const wide = ref(false);
    const mobilePane = ref("chat");
    watch(() => [router.params.tab, router.params.view], ([key, pane]) => {
      const target = workspaceTarget(key, pane);
      tab.value = target.tab;
      understandingPane.value = target.pane;
      focus.value = null;
    });

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
    watch(() => jobState.visible, (visible) => { if (!visible) reload(); });

    const rename = async () => {
      try {
        const { value } = await ElMessageBox.prompt("为这个项目设置一个清晰的名称。", "重命名项目", {
          inputValue: view.value.project.name, inputValidator: value => Boolean(value?.trim()) || "请输入项目名称", confirmButtonText: "保存", cancelButtonText: "取消",
        });
        await call(() => api(`/projects/${id}`, { method: "PUT", body: { name: value.trim() } }));
        reload();
      } catch (reason) { if (reason !== "cancel" && reason !== "close") throw reason; }
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
      if (s.requirements.total || s.questions.total) return "understanding";
      return "materials";
    }
    // The conversation drives the workspace: it opens the tab where the result of an action lives.
    const open = (key, focusId = null) => {
      const target = workspaceTarget(key, understandingPane.value);
      tab.value = target.tab;
      if (target.tab === "understanding") understandingPane.value = target.pane;
      focus.value = focusId;
      mobilePane.value = "work";
      history.replaceState(null, "", `#/projects/${id}/${tab.value}${tab.value === "understanding" ? `/${understandingPane.value}` : ""}`);
    };
    provide("workspace", { open, focus, understandingPane });

    const badges = computed(() => {
      const s = view.value?.steps;
      if (!s) return {};
      const b = (n, tip) => (n ? { n, tip } : null);
      return {
        materials: b(s.materials.pending, "份材料仍有原文待处理"),
        pbs: b(s.pbs.uncovered + s.pbs.stale + s.pbs.conflicts, `个检查提醒（可能重叠）：必须需求无对应项 ${s.pbs.uncovered}，待复核 ${s.pbs.stale}，选型冲突 ${s.pbs.conflicts}`),
      };
    });

    return { view, error, tab, TABS, open, badges, wide, mobilePane };
  },
  template: `
  <div v-if="error" class="empty">{{ error }} <a href="#/projects">返回项目列表</a></div>
  <template v-else-if="view">
    <div class="mobile-panes" aria-label="工作区视图">
      <button :aria-pressed="mobilePane === 'chat'" @click="mobilePane = 'chat'"><UiIcon name="chat" />专家对话</button>
      <button :aria-pressed="mobilePane === 'work'" @click="mobilePane = 'work'"><UiIcon name="layers" />业务成果</button>
    </div>
    <div class="split" :class="{ wide, 'show-work': mobilePane === 'work' }">
      <section class="pane chat-pane" aria-label="专家对话"><Chat :open="open" /></section>
      <section class="pane work-pane" aria-label="业务成果">
        <div class="workspace-head">
        <nav class="stepbar" aria-label="业务成果导航">
          <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" :aria-current="tab === t.key ? 'page' : undefined" @click="open(t.key)">
            <UiIcon :name="t.icon" />{{ t.label }}
            <el-tooltip v-if="badges[t.key]" :content="badges[t.key].n + ' ' + badges[t.key].tip"><span class="badge">{{ badges[t.key].n }}</span></el-tooltip>
          </button>
        </nav>
          <button class="icon-button workspace-resize" :aria-label="wide ? '收窄工作区' : '放宽工作区'" :title="wide ? '收窄工作区' : '放宽工作区'" :aria-pressed="wide" @click="wide = !wide"><UiIcon :name="wide ? 'collapse' : 'expand'" /></button>
        </div>
        <div class="work-body">
          <Materials v-if="tab === 'materials'" />
          <Understanding v-else-if="tab === 'understanding'" />
          <Pbs v-else-if="tab === 'pbs'" />
          <Finish v-else-if="tab === 'finish'" />
        </div>
      </section>
    </div>
  </template>
  <div v-else class="empty">加载中……</div>`,
});
