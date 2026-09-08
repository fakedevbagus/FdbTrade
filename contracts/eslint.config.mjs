import coreWebVitals from "eslint-config-next/core-web-vitals";

/**
 * ESLint flat config for @fdbtrade/contracts (P02-01).
 *
 * Same convention as the backend: `eslint-config-next/core-web-vitals` is a
 * flat-config array that ignores `next-env.d.ts` and build output; ESLint
 * itself ignores node_modules and .git. This package has no JSX/React — the
 * config is used purely for the shared TS rules baseline.
 */
const config = [...coreWebVitals];

export default config;
