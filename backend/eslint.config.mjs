import coreWebVitals from "eslint-config-next/core-web-vitals";

/**
 * ESLint flat config for the FdbTrade API foundation (P01-02).
 *
 * Same convention as the frontend shell: `eslint-config-next/core-web-vitals`
 * is a flat-config array that already ignores `.next/`, `out/`, `build/` and
 * `next-env.d.ts`; node_modules and .git are ignored by ESLint itself.
 */
const config = [...coreWebVitals];

export default config;
