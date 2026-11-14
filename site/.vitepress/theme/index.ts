import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import Banner from './Banner.vue';
import TopicList from './TopicList.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('TopicList', TopicList);
  },
  Layout: () => h(DefaultTheme.Layout, null, { 'doc-before': () => h(Banner) }),
};
