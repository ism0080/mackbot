/**
 * The Vite env keys this bundle reads. `VITE_API_BASE` is the Worker's origin
 * when the app is not served from it; leaving it unset means same-origin.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
