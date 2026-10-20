import { defineComponent } from "vue";

// One stroke language across navigation, files and conversation controls.
const paths = {
  orbit: ["M12 3 21 12 12 21 3 12Z", "M12 7 17 12 12 17 7 12Z"],
  grid: ["M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"],
  box: ["m12 3 9 5v8l-9 5-9-5V8Z", "m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5"],
  file: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6M8 13h8M8 17h5"],
  layers: ["m12 3 10 5-10 5L2 8Z", "m2 12 10 5 10-5M2 16l10 5 10-5"],
  download: ["M12 3v12m-5-5 5 5 5-5", "M4 15v5h16v-5"],
  upload: ["M12 16V4m-5 5 5-5 5 5", "M4 16v4h16v-4"],
  chat: ["M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z", "M8 10h8M8 14h5"],
  spark: ["m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"],
  plus: ["M12 5v14M5 12h14"],
  arrow: ["M5 12h14m-6-6 6 6-6 6"],
  send: ["M12 19V5m-6 6 6-6 6 6"],
  clip: ["m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9", "m7 13 7-7"],
  refresh: ["M20 7v5h-5M4 17v-5h5", "M5.4 7a8 8 0 0 1 13.2-2L20 7M4 17l1.4 2A8 8 0 0 0 18.6 17"],
  expand: ["M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"],
  collapse: ["M3 8h5V3M21 8h-5V3M8 21v-5H3M16 21v-5h5"],
  trash: ["M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"],
  check: ["m5 12 4 4L19 6"],
  clock: ["M12 8v4l3 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
};

export default defineComponent({
  props: { name: { type: String, default: "spark" } },
  setup: () => ({ paths }),
  template: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path v-for="(d, i) in paths[name] || paths.spark" :key="i" :d="d" /></svg>`,
});
