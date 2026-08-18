// Application entry point. Wiring only — the views own their own markup.

function main(): void {
  const app: HTMLElement | null = document.getElementById('app');
  if (!app) throw new Error('missing #app container');
  app.dataset.ready = 'true';
}

main();
