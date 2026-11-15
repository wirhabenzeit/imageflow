# Connecting agents

AI agents on your Mac can preview, check and edit open books through the [Model Context Protocol](https://modelcontextprotocol.io) (MCP). Project changes made through ImageFlow use its saving and Undo.

## Add ImageFlow to an agent app

Open **ImageFlow → Settings… → Agents** and add each agent app once:

- **Add to Claude Desktop:** opens its extension installer. Choose **Install**.
- **Add to ChatGPT & Codex:** configures the ChatGPT desktop app, Codex CLI and Codex IDE extension. Start a new task to load the tools. ChatGPT on the web cannot reach ImageFlow on your Mac.
- **Claude Code and other agents:** shows connection commands, Claude Code plugin installation commands and a generic MCP configuration.
- **Save Template Skill:** saves a zip for Claude's **Settings → Capabilities → Skills**, or for extraction into `~/.claude/skills/`. New books already include it for Claude Code.

No separate Node.js installation is needed. If you move ImageFlow.app, add it to your agent apps again.

## Allow access

Open the books you want to use, then select **Allow agents to use open books** in **Settings → Agents**. Keep ImageFlow open.

The **Agent · N** status indicator shows connected agents. Click it to view connections or turn access off. Access stays on until you turn it off: after ImageFlow restarts, it starts again with new credentials, and existing agent configurations reconnect to the books you open.

For tool details and recovery, see [Agent connection and tools](../mcp.md).
