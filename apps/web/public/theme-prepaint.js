/* global window */
try {
  const saved = window.localStorage.getItem('station-theme-mode');
  const mode = saved === 'light' || saved === 'dark' ? saved : 'system';
  window.document.documentElement.dataset.theme = mode === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
} catch {
  window.document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
