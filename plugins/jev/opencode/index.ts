/**
 * Directory entrypoint for the OpenCode V2 plugin.
 * OpenCode requires the configured plugin path to be a directory; this file is
 * its entry. See ./plugin.ts for the implementation.
 */
export { default, plugin, setup } from './plugin.js';
export type { JevPluginOptions, JevPluginMode } from './plugin.js';
