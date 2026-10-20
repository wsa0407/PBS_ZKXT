import { createApp, defineComponent } from "vue";
import ElementPlus from "element-plus";
import zhCn from "element-plus/zh-cn";
import { jobState, loadMeta, meta, shell } from "./api.js";
import { resolve, router, setRoutes } from "./router.js";
import ProjectList from "./pages/projects.js";
import ProjectPage from "./pages/project.js";
import ProductsPage from "./pages/products.js";

setRoutes([
  [/^\/projects$/, ProjectList],
  [/^\/projects\/([\w-]+)(?:\/(\w+))?$/, ProjectPage, ["id", "tab"]],
  [/^\/products$/, ProductsPage],
]);
window.addEventListener("hashchange", resolve);

// ---------- shell ----------

const JobDialog = defineComponent({
  setup: () => ({ jobState }),
  template: `
  <el-dialog v-model="jobState.visible" :title="jobState.title" width="480px" :close-on-click-modal="false" :show-close="jobState.job?.status === '失败'">
    <div class="job-steps" v-if="jobState.job">
      <div v-for="s in jobState.job.steps" :key="s.name" class="job-step" :class="s.state">
        <span class="ic"><template v-if="s.state === 'done'">✓</template><template v-else-if="s.state === 'failed'">!</template></span>
        <span>{{ s.name }}</span><span class="muted" v-if="s.detail">{{ s.detail }}</span>
      </div>
      <el-alert v-if="jobState.job.status === '失败'" type="error" :closable="false" :title="jobState.job.error" style="margin-top:12px" />
    </div>
    <div v-else class="muted">正在启动……</div>
    <div class="muted" style="margin-top:10px" v-if="jobState.job?.status !== '失败'">处理中，通常需要 10～60 秒</div>
    <template #footer v-if="jobState.job?.status === '失败'"><el-button @click="jobState.visible = false">关闭</el-button></template>
  </el-dialog>`,
  data: () => ({ meta }),
});

const Shell = defineComponent({
  components: { JobDialog },
  setup: () => ({ router, meta, shell }),
  template: `
  <el-config-provider :locale="zhCn">
    <header class="topbar">
      <a class="brand" href="#/projects"><span class="logo">PBS</span> 智能拆解</a>
      <nav>
        <a href="#/projects" :class="{ active: router.path === '/projects' }">项目</a>
        <a href="#/products" :class="{ active: router.path.startsWith('/products') }">产品库</a>
      </nav>
      <div class="crumb-bar" v-if="shell.project && router.path.startsWith('/projects/')">
        <span class="sep">/</span>
        <b class="title">{{ shell.project.name }}</b>
        <span class="muted-light">{{ [shell.project.customer, shell.project.industry].filter(Boolean).join(' · ') }}</span>
        <el-tag v-if="shell.project.done" type="success" size="small">已完成</el-tag>
        <a href="#" class="rename" @click.prevent="shell.rename && shell.rename()">改名</a>
      </div>
    </header>
    <main v-if="meta.loaded"><component :is="router.component" :key="router.params.id || router.path" /></main>
    <JobDialog />
  </el-config-provider>`,
  data: () => ({ zhCn }),
});

resolve();
loadMeta().catch((error) => {
  document.getElementById("app").innerHTML = `<div style="padding:40px">无法连接服务：${error.message}</div>`;
});
createApp(Shell).use(ElementPlus).mount("#app");
