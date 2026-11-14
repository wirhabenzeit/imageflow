# Writing templates

A template decides what a book looks like: its print formats, its layouts (called spreads), the settings people can change and the editors they use. Templates are TypeScript and React. Every book carries its own copy in its `template/` folder, so you can change a book's design by editing that folder while the book is open: ImageFlow reloads it and shows errors in the window.

## Start here

1. Make a book from the **Photobook** starter, then open its `template/index.tsx` in your code editor. The template ships type declarations and a `tsconfig.json`, so the editor checks your code without installing anything.
2. Read the [Package](../template-api/package.md) and [Declaration](../template-api/declaration.md) topics for the shape of a template.
3. Copy the closest of the [example templates](../examples) and change it. `minimal.tsx` is the smallest complete template.
4. Watch the Book check while you work: it reports template errors and problems in the books made with the template.
5. When the template is ready, import its folder into the [template library](../guide/templates.md) to make new books from it or share it.

An agent can do this work with you. [Connecting agents](../guide/agents.md) sets it up, and [Agent connection and tools](../mcp.md) describes how agents read, preview and check templates. The [authoring workflow](../template-api/authoring-workflow.md) topic is the order of work agents follow.

## Template API reference

The reference is split into topics. The same topic files are what the ImageFlow MCP server and the `imageflow-templates` agent skill give agents, so people and agents read the same text.

<TopicList />

<div v-if="false">

The topic table appears on the documentation site. On GitHub, open the [`template-api`](../template-api) folder, or [template-api.md](../template-api.md) for every topic on one page.

</div>

The executable schemas in the app's source govern validation; these pages describe them. Templates run as code inside ImageFlow, so only open books and templates you trust.
