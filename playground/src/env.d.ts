/// <reference types="vite/client" />

declare const __PRY_COMMIT__: string;
declare const __PRY_BUILD_TIME__: string;
declare const __PRY_AX_VERSION__: string;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, unknown, unknown>;
  export default component;
}
