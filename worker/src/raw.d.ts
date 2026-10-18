// A file's text, imported with Vite's `?raw` suffix in the tests (deploy-config.test.ts).
declare module "*?raw" {
  const text: string;
  export default text;
}
