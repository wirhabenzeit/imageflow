# Connecting agents

ImageFlow can let AI agents on your Mac, such as Claude Desktop, Claude Code, ChatGPT and Codex, look at and change the books you have open. Agents use the [Model Context Protocol](https://modelcontextprotocol.io) (MCP) to render pages, run the Book check, edit templates and apply changes, while ImageFlow keeps saving and Undo.

## Add ImageFlow to an agent app

Open **ImageFlow → Settings…** and choose **Agents**. Add ImageFlow to each agent app once:

- **Add to Claude Desktop** opens Claude Desktop's extension installer. Choose **Install** there.
- **Add to ChatGPT & Codex** adds ImageFlow to the ChatGPT desktop app, the Codex CLI and the Codex IDE extension, which share one configuration. Start a new task to load the tools. ChatGPT on the web cannot reach an app on your Mac.
- **Claude Code and other agents** shows a `claude mcp add` command, the commands to install the ImageFlow plugin for Claude Code, and a generic configuration for other MCP clients.
- **Save Template Skill** saves the template-writing skill as a zip, to upload in Claude under **Settings → Capabilities → Skills** or unzip into `~/.claude/skills/`. New books already carry it, so Claude Code started in a book folder finds it.

Agents need no separate Node.js installation. If you move ImageFlow.app, add it to your agent apps again.

## Allow access

Open the book you want to work on and select **Allow agents to use open books** in **Settings → Agents**. Keep ImageFlow open while the agent works.

While access is on, **Agent · N** in the status bar shows how many agents are connected; click it to see them or turn access off. Access lasts until you quit ImageFlow: after restarting, open your books and select **Allow agents to use open books** again, and the agents reconnect on their own.

Agents act only on open books, and only through ImageFlow, so their changes appear in the book's Undo history.

## Next steps

[Agent connection and tools](../mcp.md) describes the tools, limits and recovery in detail, for template authors and agent developers.
