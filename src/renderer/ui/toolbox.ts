import { store } from '../state';
import { h, icon } from './dom';
import { TOOL_GROUPS, toolById } from './tools';

/** Caja de herramientas vertical (izquierda). */
export function createToolbox(): HTMLElement {
  const buttons = new Map<string, HTMLButtonElement>();
  const box = h('nav', { class: 'toolbox', 'aria-label': 'Caja de herramientas' });

  TOOL_GROUPS.forEach((group, index) => {
    if (index > 0) box.append(h('hr', { class: 'toolbox-sep' }));
    for (const tool of group) {
      const label = tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label;
      const button = h(
        'button',
        {
          type: 'button',
          class: tool.flyout ? 'tool has-flyout' : 'tool',
          'aria-label': label,
          title: label,
          'aria-pressed': 'false',
          onclick: () => store.set({ tool: tool.id, hint: tool.hint }),
        },
        icon(tool.icon),
      );
      buttons.set(tool.id, button);
      box.append(button);
    }
  });

  const paint = () => {
    const active = store.get().tool;
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === active));
  };
  store.subscribe((state, previous) => {
    if (state.tool !== previous.tool) paint();
  });
  paint();
  store.set({ hint: toolById(store.get().tool).hint });
  return box;
}
