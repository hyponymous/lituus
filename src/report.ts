/**
 * The step list both diagnostic pages report through.
 *
 * A diagnostic is read on the machine it is diagnosing, which for this project
 * means a phone held in one hand. Hence the shape: one line per question, its
 * answer in the margin, and the working underneath in a `<pre>` a reader can
 * select and paste back. Extracted from `spike.ts` when `probe.ts` needed the
 * same thing; the CSS is still the `spike-` prefix, since a class name is not
 * worth a stylesheet migration.
 */

export type Status = 'run' | 'ok' | 'warn' | 'bad';

/** One line of a report, updated in place as its step resolves. */
export interface Step {
  readonly note: (text: string, status?: Status) => void;
  readonly detail: (text: string) => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function makeReport(
  root: HTMLElement,
  title: string,
  blurb: string,
): (step: string) => Step {
  root.replaceChildren();
  const panel: HTMLElement = el('section', 'spike');
  panel.append(el('h2', undefined, title));
  panel.append(el('p', 'spike-blurb', blurb));

  const list: HTMLElement = el('ol', 'spike-steps');
  panel.append(list);
  root.append(panel);

  return (step: string): Step => {
    const item: HTMLElement = el('li', 'spike-step');
    const head: HTMLElement = el('div', 'spike-head');
    const label: HTMLElement = el('span', 'spike-label', step);
    const note: HTMLElement = el('span', 'spike-note spike-run', 'running…');
    head.append(label, note);
    const detail: HTMLElement = el('pre', 'spike-detail');
    item.append(head, detail);
    list.append(item);

    return {
      note: (text: string, status: Status = 'ok'): void => {
        note.textContent = text;
        note.className = `spike-note spike-${status}`;
      },
      detail: (text: string): void => {
        detail.textContent = detail.textContent === '' ? text : `${detail.textContent}\n${text}`;
      },
    };
  };
}
