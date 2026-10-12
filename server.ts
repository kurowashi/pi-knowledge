/**
 * OpenCode's directory-plugin entrypoint (Host.resolve tries `<dir>/server`
 * first). The adapter itself lives in src/hosts/opencode.ts next to the Pi one;
 * the npm `exports` map points `./server` at the same file.
 */
export { default } from "./src/hosts/opencode.ts";