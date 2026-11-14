import topics from '../docs/template-api/topics.json';

/** The template API reference topics, in reading order. Each is docs/template-api/<id>.md, served by
 * get_authoring_context on request and shipped as a reference file of the agent skill. */
export const docTopics: readonly { id: string; title: string; summary: string }[] = topics;
export const docTopicIds = topics.map(({ id }) => id) as [string, ...string[]];
