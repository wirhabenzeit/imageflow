import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';
import type { SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import type { McpServer } from '@modelcontextprotocol/server';
import { existsSync } from 'node:fs';

const report = (message: string) => console.error('ImageFlow skills: ' + message);

/** The agent skills in `folder`, served with MCP's Skills extension. Clients verify each file against the hashes in
 * the skill's listing. An app update replaces the files while an older bridge keeps running, so call `reload` after a
 * new app connection; a read that finds changed or missing files reloads by itself, and the client's next try gets
 * the new ones. Undefined without a readable folder: the bridge then serves its tools alone. */
export async function bridgeSkills(folder: string) {
  if (!existsSync(folder)) return undefined;
  let catalog: SkillCatalog | undefined;
  let reloading: Promise<void> | undefined;
  // A reload under way also covers the warnings it raises itself, so a lasting problem cannot repeat it forever.
  const reload = () => reloading ??= catalog!.reload()
    .then(() => {}, (error: Error) => report(error.message))
    .finally(() => { reloading = undefined; });
  try {
    catalog = await loadSkills(folder, { onWarning: ({ path, message }) => {
      report(path + ': ' + message);
      if (catalog) void reload();
    } });
  } catch (error) {
    report((error as Error).message);
    return undefined;
  }
  return { attach: (server: McpServer) => catalog.attach(server), reload };
}
