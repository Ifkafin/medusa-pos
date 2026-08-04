/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_TILLTAP_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
