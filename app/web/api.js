import { reactive } from "vue";
import { ElMessage } from "element-plus";

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

/** Run an API call and show errors as a toast; returns undefined on failure. */
export async function call(fn, success) {
  try {
    const result = await fn();
    if (success) ElMessage.success(success);
    return result;
  } catch (error) {
    ElMessage.error(error.message);
    return undefined;
  }
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] ?? null);
    input.click();
  });
}

// ---------- background jobs (every model call runs as a job) ----------

export const jobState = reactive({ visible: false, title: "", job: null });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start a job with `start()` (returns { jobId }), show progress, resolve with the job result or null on failure. */
export async function runJob(title, start) {
  let started;
  try {
    started = await start();
  } catch (error) {
    ElMessage.error(error.message);
    return null;
  }
  jobState.title = title;
  jobState.job = null;
  jobState.visible = true;
  try {
    for (;;) {
      const job = await api(`/jobs/${started.jobId}`);
      jobState.job = job;
      if (job.status === "已完成") {
        jobState.visible = false;
        return job.result ?? {};
      }
      if (job.status === "失败") return null;
      await sleep(1000);
    }
  } catch (error) {
    ElMessage.error(error.message);
    return null;
  }
}

// The project page publishes its title here so the global top bar can show it (one bar, not two).
export const shell = reactive({ project: null, rename: null });

export const meta = reactive({ loaded: false });

export async function loadMeta() {
  Object.assign(meta, await api("/meta"), { loaded: true });
}

export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
